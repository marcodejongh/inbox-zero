/**
 * IMAP Polling Cron Job
 *
 * Polls IMAP accounts for new emails every 2-3 minutes.
 * Processes new messages through the rules engine.
 *
 * Setup with Vercel Cron:
 * vercel.json:
 * {
 *   "crons": [{
 *     "path": "/api/cron/imap-poll",
 *     "schedule": "*/3 * * * *"
 *   }]
 * }
 */

import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { getImapCredentialsForEmail } from "@/utils/account";
import {
  connectImap,
  disconnectImap,
  fetchNewMessagesSince,
  type ImapMessage,
} from "@/utils/imap";
import { getPremiumUserFilter } from "@/utils/premium/get-premium-user-filter";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max

const DEFAULT_POLL_INTERVAL_MINUTES = 3;

export const GET = withError("cron/imap-poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized cron request: api/cron/imap-poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  return pollImapAccounts(request.logger);
});

export const POST = withError("cron/imap-poll", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(new Error("Unauthorized cron request: api/cron/imap-poll"));
    return new Response("Unauthorized", { status: 401 });
  }

  return pollImapAccounts(request.logger);
});

interface PollResult {
  emailAccountId: string;
  email: string;
  success: boolean;
  newMessages: number;
  processedMessages: number;
  error?: string;
}

async function pollImapAccounts(logger: Logger): Promise<NextResponse> {
  const startTime = Date.now();

  try {
    // Get all IMAP accounts that need polling
    const imapAccounts = await getImapAccountsToPool();

    logger.info(`Found ${imapAccounts.length} IMAP accounts to poll`);

    const results: PollResult[] = [];

    // Process accounts sequentially to avoid overwhelming connections
    for (const account of imapAccounts) {
      const result = await pollSingleAccount(account, logger);
      results.push(result);
    }

    const duration = Date.now() - startTime;
    const successCount = results.filter((r) => r.success).length;
    const totalNewMessages = results.reduce((sum, r) => sum + r.newMessages, 0);

    logger.info("IMAP polling completed", {
      duration,
      accounts: imapAccounts.length,
      successCount,
      totalNewMessages,
    });

    return NextResponse.json({
      success: true,
      accounts: imapAccounts.length,
      successCount,
      totalNewMessages,
      results,
    });
  } catch (error) {
    logger.error("IMAP polling failed", { error });
    throw error;
  }
}

/**
 * Get IMAP accounts that need polling
 */
async function getImapAccountsToPool() {
  return prisma.emailAccount.findMany({
    where: {
      account: {
        provider: "imap",
      },
      // Only poll premium users
      ...getPremiumUserFilter(),
    },
    select: {
      id: true,
      email: true,
      lastImapSync: true,
      account: {
        select: {
          provider: true,
          imapHost: true,
          imapPort: true,
          imapUsername: true,
          imapPassword: true,
          imapSecurity: true,
          smtpHost: true,
          smtpPort: true,
          smtpUsername: true,
          smtpPassword: true,
          smtpSecurity: true,
        },
      },
      user: {
        select: {
          id: true,
          aiApiKey: true,
          aiModel: true,
          aiProvider: true,
          premium: {
            select: {
              id: true,
              tier: true,
              aiCredits: true,
              aiMonth: true,
            },
          },
        },
      },
    },
  });
}

type ImapAccountToPool = Awaited<ReturnType<typeof getImapAccountsToPool>>[number];

/**
 * Poll a single IMAP account for new messages
 */
async function pollSingleAccount(
  account: ImapAccountToPool,
  parentLogger: Logger,
): Promise<PollResult> {
  const logger = parentLogger.with({
    emailAccountId: account.id,
    email: account.email,
  });

  const result: PollResult = {
    emailAccountId: account.id,
    email: account.email,
    success: false,
    newMessages: 0,
    processedMessages: 0,
  };

  try {
    // Validate IMAP credentials
    const credentials = await getImapCredentialsForEmail({
      emailAccountId: account.id,
    });

    if (!credentials) {
      throw new Error("IMAP credentials not configured");
    }

    // Connect to IMAP
    logger.info("Connecting to IMAP server");
    const connection = await connectImap(credentials.imap);

    // Determine sync start time
    const sinceDate = account.lastImapSync || new Date(Date.now() - 24 * 60 * 60 * 1000); // Default: last 24 hours

    // Fetch new messages
    logger.info("Fetching new messages", { since: sinceDate });
    const newMessages = await fetchNewMessagesSince(connection, sinceDate);

    result.newMessages = newMessages.length;
    logger.info(`Found ${newMessages.length} new messages`);

    if (newMessages.length > 0) {
      // Process each new message
      result.processedMessages = await processNewMessages(
        account,
        newMessages,
        logger,
      );
    }

    // Update last sync timestamp
    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { lastImapSync: new Date() },
    });

    // Disconnect
    await disconnectImap(credentials.imap);

    result.success = true;
    logger.info("Account polling completed", {
      newMessages: result.newMessages,
      processedMessages: result.processedMessages,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    result.error = errorMessage;
    logger.error("Account polling failed", { error });
    captureException(error);
  }

  return result;
}

/**
 * Process new messages through the rules engine
 */
async function processNewMessages(
  account: ImapAccountToPool,
  messages: ImapMessage[],
  logger: Logger,
): Promise<number> {
  let processedCount = 0;

  // Get automation rules for this account
  const rules = await prisma.rule.findMany({
    where: {
      emailAccountId: account.id,
      enabled: true,
    },
    include: {
      actions: true,
    },
  });

  const hasAutomationRules = rules.length > 0;
  const hasAiAccess = !!(
    account.user.aiApiKey ||
    account.user.premium?.tier
  );

  // Create provider
  const provider = await createEmailProvider({
    emailAccountId: account.id,
    provider: "imap",
    logger,
  });

  // Process each message
  for (const message of messages) {
    try {
      await processHistoryItem(
        {
          messageId: message.uid.toString(),
          threadId: message.threadId,
        },
        {
          provider,
          emailAccount: {
            id: account.id,
            email: account.email,
            autoCategorizeSenders: false,
            user: account.user,
          },
          hasAutomationRules,
          hasAiAccess,
          rules,
          logger: logger.with({ messageId: message.uid, subject: message.subject }),
        },
      );
      processedCount++;
    } catch (error) {
      logger.error("Failed to process message", {
        messageId: message.uid,
        error,
      });
    }
  }

  return processedCount;
}
