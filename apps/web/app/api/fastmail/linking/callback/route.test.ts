import { NextRequest } from "next/server";
import prisma from "@/utils/prisma";
import { getUserInfo } from "@/utils/fastmail/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSignedOAuthState } from "@/utils/oauth/state";
import { FASTMAIL_LINKING_STATE_COOKIE_NAME } from "@/utils/fastmail/constants";

const { authMock, acquireLock, fetchMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  acquireLock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@/utils/auth", () => ({ auth: authMock }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/user/merge-account", () => ({ mergeAccount: vi.fn() }));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});
vi.mock("@/utils/fastmail/client", () => ({
  getLinkingOAuth2Config: () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  }),
  FASTMAIL_OAUTH_TOKEN_URL: "https://www.fastmail.com/dev/oidc/token",
  getUserInfo: vi.fn(),
}));
vi.mock("@/utils/redis/oauth-code", () => ({
  acquireOAuthCodeLock: acquireLock,
  getOAuthCodeResult: vi.fn(),
  setOAuthCodeResult: vi.fn(),
  clearOAuthCode: vi.fn(),
}));

import { GET } from "./route";

describe("Fastmail linking callback session checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("updates the same owner's mailbox when its provider identity changed", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    acquireLock.mockResolvedValue(true);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "access", refresh_token: "refresh" }),
    });
    vi.mocked(getUserInfo).mockResolvedValue({
      sub: "new-provider-id",
      email: "owner@example.com",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
    } as never);
    vi.mocked(prisma.account.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      accountId: "existing-account",
      userId: "user-1",
      account: { provider: "fastmail" },
    } as never);

    const response = await GET(createRequest(), {} as never);

    expect(response.headers.get("location")).toContain(
      "success=tokens_updated",
    );
    expect(prisma.account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "existing-account" },
        data: expect.objectContaining({
          providerAccountId: "new-provider-id",
          access_token: "access",
        }),
      }),
    );
    expect(prisma.account.create).not.toHaveBeenCalled();
  });

  it("rejects a different signed-in user before exchanging credentials", async () => {
    authMock.mockResolvedValue({ user: { id: "different-user" }, session: {} });
    const response = await GET(createRequest(), {} as never);
    expect(response.headers.get("location")).toContain("error=invalid_state");
    expect(acquireLock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks email-code sessions before exchanging credentials", async () => {
    authMock.mockResolvedValue({
      user: { id: "user-1" },
      session: { emailOtp: true },
    });
    const response = await GET(createRequest(), {} as never);
    expect(response.headers.get("location")).toContain(
      "error=provider_sign_in_required",
    );
    expect(acquireLock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createRequest() {
  const state = generateSignedOAuthState({ userId: "user-1" });
  const request = new NextRequest(
    `http://localhost:3000/api/fastmail/linking/callback?code=test-code&state=${encodeURIComponent(state)}`,
  );
  request.cookies.set(FASTMAIL_LINKING_STATE_COOKIE_NAME, state);
  return request;
}
