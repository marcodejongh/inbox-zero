import { describe, expect, it, vi, afterEach } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { checkJMAPErrors, createFastmailClient } from "@/utils/fastmail/client";
import { runWithRequestTimer, startRequestTimer } from "@/utils/request-timing";

vi.mock("@/utils/auth/save-tokens", () => ({ saveTokens: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("JMAP failures", () => {
  it.each([
    "notCreated",
    "notUpdated",
    "notDestroyed",
  ])("rejects per-object %s errors inside a successful HTTP response", (field) => {
    expect(() =>
      checkJMAPErrors({
        sessionState: "session",
        methodResponses: [
          [
            "Email/set",
            {
              [field]: {
                message: {
                  type: "forbidden",
                  description: "Permission denied",
                },
              },
            },
            "0",
          ],
        ],
      }),
    ).toThrow("Permission denied");
  });

  it("does not retry an ambiguous submission after a network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          capabilities: {
            "urn:ietf:params:jmap:core": {},
            "urn:ietf:params:jmap:mail": {},
          },
          primaryAccounts: { "urn:ietf:params:jmap:mail": "account" },
          apiUrl: "https://api.fastmail.com/jmap/api/",
        }),
      )
      .mockRejectedValue(new Error("Connection lost after submission"));
    vi.stubGlobal("fetch", fetchMock);
    const client = await createFastmailClient("token");
    await expect(
      client.request([
        ["EmailSubmission/set", { accountId: "account", create: {} }, "0"],
      ]),
    ).rejects.toThrow("Connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps parallel requests within the limit the server advertises", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/session"))
        return Response.json({
          capabilities: {
            "urn:ietf:params:jmap:core": { maxConcurrentRequests: 2 },
            "urn:ietf:params:jmap:mail": {},
          },
          primaryAccounts: { "urn:ietf:params:jmap:mail": "limited-account" },
          apiUrl: "https://api.fastmail.com/jmap/api/",
        });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return Response.json({ methodResponses: [], sessionState: "s" });
    });
    vi.stubGlobal("fetch", fetchMock);
    // Clients are created per request, so the limit has to hold across them.
    const clients = await Promise.all([
      createFastmailClient("token"),
      createFastmailClient("token"),
    ]);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        clients[index % 2].request([
          ["Email/get", { accountId: "limited-account", ids: [] }, "0"],
        ]),
      ),
    );
    expect(peak).toBe(2);
  });

  it("reports how long requests waited for a free slot", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/session"))
        return Response.json({
          capabilities: {
            "urn:ietf:params:jmap:core": { maxConcurrentRequests: 1 },
            "urn:ietf:params:jmap:mail": {},
          },
          primaryAccounts: { "urn:ietf:params:jmap:mail": "queued-account" },
          apiUrl: "https://api.fastmail.com/jmap/api/",
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ methodResponses: [], sessionState: "s" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const timer = startRequestTimer({
      logger,
      requestName: "threads request",
      slowWarnAfterMs: -1,
    });

    await runWithRequestTimer(timer, async () => {
      const client = await createFastmailClient("token");
      await Promise.all(
        Array.from({ length: 3 }, () =>
          client.request([
            ["Email/get", { accountId: "queued-account", ids: [] }, "0"],
          ]),
        ),
      );
    });
    timer.logSlowCompletion();
    timer.stop();

    const { provider } = warn.mock.calls[0][1] as {
      provider: { requests: number; queueWaitMs: number; requestMs: number };
    };
    expect(provider.requests).toBe(3);
    // The second request waits for one, the third for two.
    expect(provider.queueWaitMs).toBeGreaterThanOrEqual(40);
    expect(provider.requestMs).toBeGreaterThanOrEqual(40);
  });
});
