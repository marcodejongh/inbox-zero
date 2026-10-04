import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSignedOAuthState } from "@/utils/oauth/state";
import { FASTMAIL_LINKING_STATE_COOKIE_NAME } from "@/utils/fastmail/constants";

const { authState, hasActiveUser } = vi.hoisted(() => ({
  authState: { userId: "user-1" } as { userId: string; emailOtp?: boolean },
  hasActiveUser: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithAuthTestMiddleware({ auth: authState });
});

vi.mock("@/utils/fastmail/client", () => ({
  getLinkingOAuth2Config: () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "http://localhost:3000/api/fastmail/linking/callback",
  }),
  FASTMAIL_OAUTH_AUTHORIZE_URL: "https://www.fastmail.com/dev/oidc/authorize",
}));

vi.mock("@/utils/oauth/account-linking", async (importActual) => {
  const actual =
    await importActual<typeof import("@/utils/oauth/account-linking")>();
  return { ...actual, hasActiveAccountLinkingUser: hasActiveUser };
});

import { GET } from "./route";

describe("Fastmail linking authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.emailOtp = undefined;
    hasActiveUser.mockResolvedValue(true);
  });

  it("issues signed state that the current callback can validate", async () => {
    const response = await GET(createRequest(), {} as never);
    const { url } = await response.json();
    const state = new URL(url).searchParams.get("state");
    expect(response.status).toBe(200);
    expect(state).toBe(
      response.cookies.get(FASTMAIL_LINKING_STATE_COOKIE_NAME)?.value,
    );
    expect(parseSignedOAuthState(state!)).toMatchObject({ userId: "user-1" });
  });

  it("blocks mailbox linking from email-code sessions", async () => {
    authState.emailOtp = true;
    const response = await GET(createRequest(), {} as never);
    expect(response.status).toBe(403);
    expect(
      response.cookies.get(FASTMAIL_LINKING_STATE_COOKIE_NAME),
    ).toBeUndefined();
  });

  it("sends stale sessions to logout", async () => {
    hasActiveUser.mockResolvedValue(false);
    const response = await GET(createRequest(), {} as never);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      redirectTo: "/logout",
    });
  });

  it("rejects reconnects until Fastmail can enforce the target identity", async () => {
    const response = await GET(
      createRequest("?emailAccountId=mailbox-1"),
      {} as never,
    );
    expect(response.status).toBe(501);
    expect(
      response.cookies.get(FASTMAIL_LINKING_STATE_COOKIE_NAME),
    ).toBeUndefined();
  });
});

function createRequest(query = "") {
  return new NextRequest(
    `http://localhost:3000/api/fastmail/linking/auth-url${query}`,
  );
}
