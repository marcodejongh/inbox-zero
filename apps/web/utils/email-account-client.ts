import prisma from "@/utils/prisma";
import {
  getFastmailClientWithRefresh,
  getAccessTokenFromClient as getFastmailAccessToken,
} from "@/utils/fastmail/client";
import {
  getAccessTokenFromClient,
  getGmailClientWithRefresh,
} from "@/utils/gmail/client";
import {
  getAccessTokenFromClient as getOutlookAccessToken,
  getOutlookClientWithRefresh,
} from "@/utils/outlook/client";
import type { Logger } from "@/utils/logger";

export async function getGmailClientForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const gmail = getGmailClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  return gmail;
}

export async function getGmailAndAccessTokenForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const gmail = await getGmailClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  const accessToken = getAccessTokenFromClient(gmail);
  return { gmail, accessToken, tokens };
}

export async function getOutlookClientForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const outlook = await getOutlookClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  return outlook;
}

export async function getOutlookAndAccessTokenForEmail({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const tokens = await getTokens({ emailAccountId });
  const outlook = await getOutlookClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
    logger,
  });
  const accessToken = getOutlookAccessToken(outlook);
  return { outlook, accessToken, tokens };
}

export async function getOutlookClientForEmailId({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: { access_token: true, refresh_token: true, expires_at: true },
      },
    },
  });
  const outlook = await getOutlookClientWithRefresh({
    accessToken: account?.account.access_token,
    refreshToken: account?.account.refresh_token || "",
    expiresAt: account?.account.expires_at?.getTime() ?? null,
    emailAccountId,
    logger,
  });
  return outlook;
}

export async function getFastmailClientForEmail({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const tokens = await getTokens({ emailAccountId });
  const fastmail = await getFastmailClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
  });
  return fastmail;
}

export async function getFastmailAndAccessTokenForEmail({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const tokens = await getTokens({ emailAccountId });
  const fastmail = await getFastmailClientWithRefresh({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || "",
    expiresAt: tokens.expiresAt,
    emailAccountId,
  });
  const accessToken = getFastmailAccessToken(fastmail);
  return { fastmail, accessToken, tokens };
}

async function getTokens({ emailAccountId }: { emailAccountId: string }) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      account: {
        select: {
          access_token: true,
          refresh_token: true,
          expires_at: true,
          scope: true,
        },
      },
    },
  });

  return {
    accessToken: emailAccount?.account.access_token,
    refreshToken: emailAccount?.account.refresh_token,
    expiresAt: emailAccount?.account.expires_at?.getTime() ?? null,
    scope: emailAccount?.account.scope,
  };
}
