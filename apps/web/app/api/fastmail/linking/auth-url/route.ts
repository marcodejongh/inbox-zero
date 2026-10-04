import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import {
  getLinkingOAuth2Config,
  FASTMAIL_OAUTH_AUTHORIZE_URL,
} from "@/utils/fastmail/client";
import { FASTMAIL_LINKING_STATE_COOKIE_NAME } from "@/utils/fastmail/constants";
import {
  getMailboxLinkingBlockedResponse,
  hasActiveAccountLinkingUser,
} from "@/utils/oauth/account-linking";
import { SCOPES } from "@/utils/fastmail/scopes";
import {
  generateSignedOAuthState,
  oauthStateCookieOptions,
} from "@/utils/oauth/state";

export type GetAuthLinkUrlResponse = { url: string };

const getAuthUrl = ({ userId }: { userId: string }) => {
  const config = getLinkingOAuth2Config();
  const state = generateSignedOAuthState({ userId });

  // Build OAuth authorization URL
  // Use offline_access scope (OIDC standard) to get refresh token - access_type is Google-specific
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: [
      ...new Set([...SCOPES, "openid", "email", "profile", "offline_access"]),
    ].join(" "),
    state,
    prompt: "consent",
  });

  const url = `${FASTMAIL_OAUTH_AUTHORIZE_URL}?${params.toString()}`;

  return { url, state };
};

export const GET = withAuth("fastmail/linking/auth-url", async (request) => {
  const blockedResponse = getMailboxLinkingBlockedResponse(request);
  if (blockedResponse) return blockedResponse;
  if (
    !(await hasActiveAccountLinkingUser({
      targetUserId: request.auth.userId,
      logger: request.logger,
    }))
  ) {
    return NextResponse.json(
      { error: "Unauthorized", isKnownError: true, redirectTo: "/logout" },
      { status: 401 },
    );
  }
  if (request.nextUrl.searchParams.has("emailAccountId")) {
    return NextResponse.json(
      { error: "Fastmail reconnect is not supported yet", isKnownError: true },
      { status: 501 },
    );
  }

  // Validate configuration before generating OAuth URL
  const config = getLinkingOAuth2Config();
  if (!config.clientId || !config.clientSecret) {
    return NextResponse.json(
      { error: "Fastmail OAuth not configured" },
      { status: 501 },
    );
  }

  const userId = request.auth.userId;
  const { url: authUrl, state } = getAuthUrl({ userId });

  const response = NextResponse.json({ url: authUrl });

  response.cookies.set(
    FASTMAIL_LINKING_STATE_COOKIE_NAME,
    state,
    oauthStateCookieOptions,
  );

  return response;
});
