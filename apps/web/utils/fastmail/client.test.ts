import { describe, expect, it, vi, afterEach } from "vitest";
import { checkJMAPErrors, createFastmailClient } from "@/utils/fastmail/client";
import { sleep } from "@/utils/sleep";

vi.mock("@/utils/auth/save-tokens", () => ({ saveTokens: vi.fn() }));
vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(sleep).mockClear();
});

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

  it("spreads out retries of requests that were rate limited together", async () => {
    stubRateLimitedOnce("jitter-account");
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    const client = await createFastmailClient("token");

    await Promise.all([
      client.request([
        ["Email/get", { accountId: "jitter-account", ids: [] }, "0"],
      ]),
      client.request([
        ["Email/get", { accountId: "jitter-account", ids: [] }, "1"],
      ]),
    ]);

    const [first, second] = vi.mocked(sleep).mock.calls.map(([ms]) => ms);
    expect(first).toBe(1000);
    expect(second).toBeGreaterThan(first);
  });

  it.each([
    { name: "seconds", retryAfter: "7", expected: 7000 },
    {
      name: "a date that has already passed",
      retryAfter: "Wed, 21 Oct 2015 07:28:00 GMT",
      expected: 1000,
    },
    { name: "zero", retryAfter: "0", expected: 1000 },
  ])("waits as long as a Retry-After of $name asks", async ({
    retryAfter,
    expected,
  }) => {
    stubRateLimitedOnce(`retry-after-${retryAfter}`, retryAfter);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const client = await createFastmailClient("token");

    await client.request([
      ["Email/get", { accountId: `retry-after-${retryAfter}`, ids: [] }, "0"],
    ]);

    expect(sleep).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

function stubRateLimitedOnce(accountId: string, retryAfter?: string) {
  const rateLimited = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session"))
        return Response.json({
          capabilities: {
            "urn:ietf:params:jmap:core": {},
            "urn:ietf:params:jmap:mail": {},
          },
          primaryAccounts: { "urn:ietf:params:jmap:mail": accountId },
          apiUrl: "https://api.fastmail.com/jmap/api/",
        });
      const body = String(init?.body);
      if (!rateLimited.has(body)) {
        rateLimited.add(body);
        return new Response(null, {
          status: 429,
          headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
        });
      }
      return Response.json({ methodResponses: [], sessionState: "s" });
    }),
  );
}
