import { describe, expect, it, vi } from "vitest";
import { FastmailProvider } from "@/utils/email/fastmail";
import type { FastmailClient } from "@/utils/fastmail/client";
import { createScopedLogger } from "@/utils/logger";

vi.mock("@/utils/fastmail/client", () => ({
  getAccessTokenFromClient: () => "test-token",
}));

describe("Fastmail upstream compatibility", () => {
  it("returns sent-message pages and advances the JMAP position", async () => {
    const { provider, request } = createProvider();
    request.mockResolvedValueOnce(mailboxes()).mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/query",
          { total: 5, position: 2, ids: ["message-3", "message-4"] },
          "0",
        ],
        [
          "Email/get",
          {
            list: [
              { id: "message-3", threadId: "thread-3" },
              { id: "message-4", threadId: "thread-4" },
            ],
          },
          "1",
        ],
      ],
    });

    await expect(
      provider.getSentMessageIds({ maxResults: 2, pageToken: "2" }),
    ).resolves.toEqual({
      messages: [
        { id: "message-3", threadId: "thread-3" },
        { id: "message-4", threadId: "thread-4" },
      ],
      nextPageToken: "4",
    });
    expect(request.mock.calls[1][0][0][1]).toMatchObject({
      position: 2,
      calculateTotal: true,
    });
  });

  it("returns the created message id after sending", async () => {
    const { provider, request } = createProvider();
    request
      .mockResolvedValueOnce(mailboxes())
      .mockResolvedValueOnce({
        methodResponses: [
          [
            "Identity/get",
            { list: [{ id: "identity-1", email: "owner@example.com" }] },
            "0",
          ],
        ],
      })
      .mockResolvedValueOnce({
        methodResponses: [
          ["Email/set", { created: { email: { id: "sent-1" } } }, "0"],
        ],
      });

    await expect(
      provider.sendEmail({
        to: "recipient@example.com",
        subject: "Hello",
        messageText: "Body",
      }),
    ).resolves.toEqual({ messageId: "sent-1" });
  });

  it("reports a rejected draft deletion instead of claiming success", async () => {
    const { provider, request } = createProvider();
    request.mockResolvedValueOnce({
      methodResponses: [
        [
          "Email/set",
          {
            notDestroyed: {
              "draft-1": {
                type: "forbidden",
                description: "Permission denied",
              },
            },
          },
          "0",
        ],
      ],
    });

    await expect(provider.deleteDraft("draft-1")).rejects.toThrow(
      "Permission denied",
    );
  });

  it("rejects unsupported reply options instead of silently dropping them", async () => {
    const { provider, request } = createProvider();

    await expect(
      provider.replyToEmail({} as never, "Body", { from: "alias@example.com" }),
    ).rejects.toThrow("reply options are not supported yet");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unfinished local-mail sync before making JMAP requests", async () => {
    const { provider, request } = createProvider();

    await expect(provider.getMailboxSyncPage({ limit: 50 })).rejects.toThrow(
      "not supported yet",
    );
    expect(request).not.toHaveBeenCalled();
  });
});

function createProvider() {
  const request = vi.fn();
  const client = {
    accountId: "account-1",
    request,
  } as unknown as FastmailClient;
  return {
    provider: new FastmailProvider(client, createScopedLogger("fastmail-test")),
    request,
  };
}

function mailboxes() {
  return {
    methodResponses: [
      [
        "Mailbox/get",
        { list: [{ id: "sent", name: "Sent", role: "sent" }] },
        "0",
      ],
    ],
  };
}
