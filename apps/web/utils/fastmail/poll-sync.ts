import prisma from "@/utils/prisma";
import { hasAiAccess, getPremiumUserFilter } from "@/utils/premium";
import { createEmailProvider } from "@/utils/email/provider";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import type { FastmailProvider } from "@/utils/email/fastmail";
import type { Logger } from "@/utils/logger";

export interface PollSyncResult {
  emailAccountId: string;
  email: string;
  status: "success" | "error" | "skipped" | "no_changes";
  processedCount?: number;
  newState?: string;
  error?: string;
}

/**
 * Get Fastmail accounts that are eligible for polling
 */
async function getFastmailAccountsToPoll() {
  return prisma.emailAccount.findMany({
    where: {
      account: {
        provider: "fastmail",
      },
      ...getPremiumUserFilter(),
    },
    select: {
      id: true,
      email: true,
      lastSyncedHistoryId: true,
      lastPolledAt: true,
      autoCategorizeSenders: true,
      about: true,
      multiRuleSelectionEnabled: true,
      timezone: true,
      calendarBookingLink: true,
      account: {
        select: {
          provider: true,
          access_token: true,
          refresh_token: true,
          expires_at: true,
        },
      },
      rules: {
        where: { enabled: true },
        include: { actions: true },
      },
      user: {
        select: {
          id: true,
          aiProvider: true,
          aiModel: true,
          aiApiKey: true,
          premium: {
            select: {
              tier: true,
              lemonSqueezyRenewsAt: true,
              stripeSubscriptionStatus: true,
            },
          },
        },
      },
    },
    orderBy: {
      lastPolledAt: { sort: "asc", nulls: "first" },
    },
  });
}

/**
 * Poll a single Fastmail account for new emails and process them through the rule engine
 */
export async function pollFastmailAccount({
  emailAccountId,
  logger,
  forceSync = false,
}: {
  emailAccountId: string;
  logger: Logger;
  forceSync?: boolean;
}): Promise<PollSyncResult> {
  const log = logger.with({ emailAccountId, action: "pollFastmailAccount" });

  try {
    const account = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        id: true,
        email: true,
        lastSyncedHistoryId: true,
        lastPolledAt: true,
        autoCategorizeSenders: true,
        about: true,
        multiRuleSelectionEnabled: true,
        timezone: true,
        calendarBookingLink: true,
        account: {
          select: {
            provider: true,
            access_token: true,
            refresh_token: true,
            expires_at: true,
          },
        },
        rules: {
          where: { enabled: true },
          include: { actions: true },
        },
        user: {
          select: {
            id: true,
            aiProvider: true,
            aiModel: true,
            aiApiKey: true,
            premium: {
              select: {
                tier: true,
                lemonSqueezyRenewsAt: true,
                stripeSubscriptionStatus: true,
              },
            },
          },
        },
      },
    });

    if (!account) {
      return {
        emailAccountId,
        email: "",
        status: "error",
        error: "Account not found",
      };
    }

    if (account.account?.provider !== "fastmail") {
      return {
        emailAccountId,
        email: account.email,
        status: "skipped",
        error: "Not a Fastmail account",
      };
    }

    // Skip accounts polled recently (< 2 minutes ago) during cron unless forced
    if (!forceSync && account.lastPolledAt) {
      const timeSinceLastPoll = Date.now() - account.lastPolledAt.getTime();
      if (timeSinceLastPoll < 2 * 60 * 1000) {
        log.info("Skipping recently polled account", {
          lastPolledAt: account.lastPolledAt,
          timeSinceLastPoll,
        });
        return {
          emailAccountId,
          email: account.email,
          status: "skipped",
          error: "Recently polled",
        };
      }
    }

    // Check if user has AI access
    const userHasAiAccess = hasAiAccess(
      account.user.premium?.tier || null,
      account.user.aiApiKey,
    );

    if (!userHasAiAccess) {
      log.info("User does not have AI access");
      return {
        emailAccountId,
        email: account.email,
        status: "skipped",
        error: "No AI access",
      };
    }

    // Check if user has rules
    const hasAutomationRules = account.rules.length > 0;
    if (!hasAutomationRules) {
      log.info("User has no enabled rules");
      return {
        emailAccountId,
        email: account.email,
        status: "skipped",
        error: "No rules enabled",
      };
    }

    // Check for tokens (refresh_token is optional for app token accounts)
    if (!account.account?.access_token) {
      log.error("Missing access token");
      return {
        emailAccountId,
        email: account.email,
        status: "error",
        error: "Missing authentication tokens",
      };
    }

    log.info("Creating Fastmail provider");

    const provider = (await createEmailProvider({
      emailAccountId,
      provider: "fastmail",
      logger: log,
    })) as FastmailProvider;

    // Get changes since last state
    const sinceState = account.lastSyncedHistoryId;
    log.info("Getting email changes", { sinceState });

    const changes = await provider.getEmailChanges(sinceState);

    if (changes.created.length === 0 && changes.updated.length === 0) {
      log.info("No new emails found");
      // Update lastPolledAt even when no changes
      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: {
          lastPolledAt: new Date(),
          lastSyncedHistoryId: changes.newState,
        },
      });
      return {
        emailAccountId,
        email: account.email,
        status: "no_changes",
        newState: changes.newState,
      };
    }

    log.info("Processing new emails", {
      created: changes.created.length,
      updated: changes.updated.length,
    });

    // Process new emails through the rule engine
    let processedCount = 0;
    for (const messageId of changes.created) {
      try {
        log.info("Processing message", { messageId });
        await processHistoryItem(
          { messageId },
          {
            provider,
            emailAccount: {
              ...account,
              userId: account.user.id,
              user: account.user,
            },
            hasAutomationRules,
            hasAiAccess: userHasAiAccess,
            rules: account.rules,
            logger: log.with({ messageId }),
          },
        );
        processedCount++;
      } catch (error) {
        log.error("Error processing message", { messageId, error });
      }
    }

    // Update state and polling timestamp
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: {
        lastSyncedHistoryId: changes.newState,
        lastPolledAt: new Date(),
      },
    });

    // Handle pagination if there are more changes
    if (changes.hasMoreChanges) {
      log.info("More changes available, will be processed on next poll");
    }

    log.info("Completed polling", {
      processedCount,
      newState: changes.newState,
    });

    return {
      emailAccountId,
      email: account.email,
      status: "success",
      processedCount,
      newState: changes.newState,
    };
  } catch (error) {
    log.error("Error polling Fastmail account", { error });
    return {
      emailAccountId,
      email: "",
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Poll all Fastmail accounts for new emails
 */
export async function pollAllFastmailAccounts(
  logger: Logger,
): Promise<PollSyncResult[]> {
  const fastmailAccounts = await getFastmailAccountsToPoll();

  logger.info("Polling Fastmail accounts", { count: fastmailAccounts.length });

  const results: PollSyncResult[] = [];

  for (const account of fastmailAccounts) {
    const result = await pollFastmailAccount({
      emailAccountId: account.id,
      logger: logger.with({ email: account.email }),
    });
    results.push(result);
  }

  logger.info("Completed polling all Fastmail accounts", {
    total: results.length,
    successful: results.filter((r) => r.status === "success").length,
    noChanges: results.filter((r) => r.status === "no_changes").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
  });

  return results;
}
