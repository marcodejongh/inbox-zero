import { beforeEach, describe, expect, it, vi } from "vitest";
import { FastmailProvider } from "@/utils/email/fastmail";
import type { FastmailClient, JMAPMethodCall } from "@/utils/fastmail/client";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("@/utils/fastmail/client", () => ({
  getAccessTokenFromClient: () => "token",
}));

beforeEach(() => vi.clearAllMocks());

describe("Fastmail mail operations", () => {
  it("only reports a send after submission succeeds", async () => {
    const { provider, calls } = createProvider();
    await expect(
      provider.sendEmail({
        to: '"Recipient, One" <one@example.com>',
        subject: "Hello",
        messageText: "Body",
      }),
    ).resolves.toEqual({ messageId: "created" });
    const create = calls.find(([name]) => name === "Email/set")?.[1]
      .create as Record<string, Record<string, unknown>>;
    expect(create.email.to).toEqual([
      { email: "one@example.com", name: '"Recipient, One"' },
    ]);
    expect(create.email.mailboxIds).toEqual({ drafts: true });
    const submit = calls.find(([name]) => name === "EmailSubmission/set")?.[1];
    expect(submit?.onSuccessUpdateEmail).toEqual({
      "#submission": {
        "keywords/$draft": null,
        "mailboxIds/drafts": null,
        "mailboxIds/sent": true,
      },
    });
  });

  it("leaves rejected submissions as drafts and reports the rejection", async () => {
    const { provider } = createProvider({ submissionRejected: true });
    await expect(
      provider.sendEmail({
        to: "one@example.com",
        subject: "Hello",
        messageText: "Body",
      }),
    ).rejects.toThrow("Sending denied");
  });

  it("does not make an ambiguous submission safe to retry", async () => {
    const { provider } = createProvider({
      submissionError: new SafeError("JMAP request failed: 503"),
    });
    const error = await provider
      .sendEmail({
        to: "one@example.com",
        subject: "Hello",
        messageText: "Body",
      })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SafeError);
    expect((error as Error).message).toContain("Check Sent");
  });

  it("uses Thread/get and removes only the seen keyword when marking unread", async () => {
    const { provider, calls } = createProvider();
    await provider.markReadThread("thread", false);
    expect(calls[0]).toEqual([
      "Thread/get",
      { accountId: "account", ids: ["thread"] },
      "0",
    ]);
    expect(calls[1][1].update).toEqual({ message: { "keywords/$seen": null } });
  });

  it("preserves unrelated mailbox memberships when archiving", async () => {
    const { provider, calls } = createProvider();
    await provider.archiveMessages(["message"], "custom");
    expect(calls.at(-1)?.[1].update).toEqual({
      message: {
        "mailboxIds/inbox": null,
        "mailboxIds/archive": true,
        "mailboxIds/custom": true,
      },
    });
  });

  it("honors server batch limits", async () => {
    const { provider, calls } = createProvider();
    await provider.markMessagesStarredState(["1", "2", "3", "1"], true);
    expect(
      calls
        .filter(([name]) => name === "Email/set")
        .map(([, args]) => Object.keys(args.update as object)),
    ).toEqual([["1", "2"], ["3"]]);
  });

  it("normalizes mailbox roles and received timestamps for the shared mail engine", async () => {
    const { provider } = createProvider();
    const messages = await provider.getMessagesBatch(["message"]);
    expect(messages[0]).toMatchObject({
      labelIds: ["inbox", "INBOX", "UNREAD"],
      internalDate: String(Date.parse("2026-10-01T12:00:00Z")),
      historyId: "s1",
    });
  });

  it("uses an anchor for subsequent pages so deletions cannot shift an offset past unseen mail", async () => {
    const { provider, calls } = createProvider();
    const page = await provider.getMessagesWithPagination({ maxResults: 1 });
    expect(page.nextPageToken).toBe("anchor:message");
    await provider.getMessagesWithPagination({
      maxResults: 1,
      pageToken: page.nextPageToken,
    });
    const queries = calls.filter(([name]) => name === "Email/query");
    expect(queries[1][1]).toMatchObject({ anchor: "message", anchorOffset: 1 });
    expect(queries[1][1]).not.toHaveProperty("position");
  });

  it("translates shared system labels and split exclusions to JMAP conditions", async () => {
    const { provider, calls } = createProvider();
    await provider.getThreadsWithQuery({
      query: {
        type: "inbox",
        labelIds: ["STARRED"],
        excludeSplits: [{ matchAll: true, filters: [{ kind: "UNREAD" }] }],
      },
    });
    const query = calls.find(([name]) => name === "Email/query")?.[1];
    expect(query?.filter).toEqual({
      operator: "AND",
      conditions: [
        { inMailbox: "inbox" },
        { hasKeyword: "$flagged" },
        {
          operator: "NOT",
          conditions: [
            {
              operator: "AND",
              conditions: [{ notKeyword: "$seen" }, { inMailbox: "inbox" }],
            },
          ],
        },
      ],
    });
  });

  it("captures a baseline without reading or processing existing messages", async () => {
    const { provider, calls } = createProvider();
    await expect(
      provider.getMailboxSyncPage({ limit: 50 }),
    ).resolves.toMatchObject({
      cursor: "s1",
      upsertedMessages: [],
      reset: false,
    });
    expect(calls).toEqual([
      ["Email/get", { accountId: "account", ids: [], properties: ["id"] }, "0"],
    ]);
  });

  it("rejects local sync cursors from another account", async () => {
    const { provider } = createProvider();
    const baseline = await provider.syncLocalMail(
      { phase: "history-baseline", after: 0 },
      { emailAccountId: "owner" },
    );
    if (baseline.status !== "ok" || baseline.phase !== "history-baseline")
      throw new Error("Missing baseline");
    await expect(
      provider.syncLocalMail(
        {
          phase: "history-changes",
          after: 0,
          cursor: baseline.result.cursor,
          limit: 50,
        },
        { emailAccountId: "other" },
      ),
    ).rejects.toThrow("scope mismatch");
  });

  it("surfaces expired history rather than silently advancing past missed mail", async () => {
    const { provider, request } = createProvider();
    request.mockRejectedValueOnce(
      new Error("JMAP error: cannotCalculateChanges"),
    );
    await expect(provider.getEmailChanges("old")).rejects.toThrow(
      "cannotCalculateChanges",
    );
  });

  it("rejects a changed draft before destroying it", async () => {
    const { provider, request } = createProvider();
    request.mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            notDestroyed: {
              draft: { type: "forbidden", description: "Permission denied" },
            },
          },
          "0",
        ],
      ],
    });
    await expect(provider.deleteDraft("draft")).rejects.toThrow(
      "Permission denied",
    );
  });

  it("protects draft replacement against concurrent editors", async () => {
    const { provider, calls } = createProvider({
      draft: true,
      emailAccountId: "owner",
    });
    prisma.fastmailDraft.upsert.mockResolvedValue({
      id: "stable",
      emailAccountId: "owner",
      messageId: "message",
      version: 1,
    } as never);
    prisma.fastmailDraft.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      provider.updateDraft("stable", { subject: "Changed" }),
    ).rejects.toThrow("another session");
    const deletions = calls
      .filter(([, args]) => args.destroy)
      .map(([, args]) => args.destroy);
    expect(deletions).toEqual([["created"]]);
  });
});

function createProvider(
  options: {
    submissionRejected?: boolean;
    submissionError?: Error;
    draft?: boolean;
    emailAccountId?: string;
  } = {},
) {
  const calls: JMAPMethodCall[] = [];
  const request = vi.fn(async (methods: JMAPMethodCall[]) => {
    calls.push(...methods);
    return {
      methodResponses: methods.map(([name, args, id]) => {
        let result: unknown;
        switch (name) {
          case "Mailbox/get":
            result = {
              list: ["inbox", "sent", "drafts", "trash", "junk", "archive"].map(
                (role) => ({
                  id: role,
                  name: role,
                  role,
                  totalEmails: 1,
                  unreadEmails: 1,
                }),
              ),
            };
            break;
          case "Identity/get":
            result = { list: [{ id: "identity", email: "owner@example.com" }] };
            break;
          case "Thread/get":
            result = { list: [{ id: "thread", emailIds: ["message"] }] };
            break;
          case "Email/query":
            result = { ids: ["message"], position: 0, total: 2 };
            break;
          case "Email/get":
            result = {
              state: "s1",
              list: ((args.ids as string[] | undefined) ?? ["message"]).map(
                (messageId) => ({
                  id: messageId,
                  threadId: "thread",
                  mailboxIds: { [options.draft ? "drafts" : "inbox"]: true },
                  keywords: options.draft ? { $draft: true } : {},
                  receivedAt: "2026-10-01T12:00:00Z",
                  from: [{ email: "owner@example.com" }],
                  to: [{ email: "to@example.com" }],
                  subject: "Hello",
                }),
              ),
            };
            break;
          case "Email/set":
            result = args.create
              ? { created: { email: { id: "created", threadId: "thread" } } }
              : args.destroy
                ? { destroyed: args.destroy }
                : {
                    updated: Object.fromEntries(
                      Object.keys(args.update as object).map((key) => [
                        key,
                        null,
                      ]),
                    ),
                  };
            break;
          case "EmailSubmission/set":
            if (options.submissionError) throw options.submissionError;
            result = options.submissionRejected
              ? {
                  notCreated: {
                    submission: {
                      type: "forbidden",
                      description: "Sending denied",
                    },
                  },
                }
              : { created: { submission: { id: "submission" } } };
            break;
          default:
            throw new Error(`Unexpected JMAP method: ${name}`);
        }
        return [name, result, id];
      }),
    };
  });
  const client = {
    accountId: "account",
    request,
    session: {
      capabilities: { "urn:ietf:params:jmap:core": { maxObjectsInSet: 2 } },
    },
  } as unknown as FastmailClient;
  return {
    provider: new FastmailProvider(
      client,
      createScopedLogger("fastmail-test"),
      options.emailAccountId,
    ),
    request,
    calls,
  };
}
