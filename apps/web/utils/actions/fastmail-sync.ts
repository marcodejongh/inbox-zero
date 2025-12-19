"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { pollFastmailAccount } from "@/utils/fastmail/poll-sync";
import { isFastmailProvider } from "@/utils/email/provider-types";
import prisma from "@/utils/prisma";

export const syncFastmailAction = actionClient
  .metadata({ name: "syncFastmail" })
  .action(async ({ ctx: { emailAccountId, logger } }) => {
    const account = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        id: true,
        email: true,
        account: { select: { provider: true } },
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    if (!isFastmailProvider(account.account?.provider)) {
      throw new Error(
        "Sync is only available for Fastmail accounts. Gmail and Outlook use push notifications.",
      );
    }

    const result = await pollFastmailAccount({
      emailAccountId,
      logger: logger.with({ emailAccountId, email: account.email }),
      forceSync: true, // User-triggered sync should bypass rate limiting
    });

    if (result.status === "error") {
      throw new Error(result.error || "Unknown error during sync");
    }

    return {
      success: true,
      status: result.status,
      processedCount: result.processedCount || 0,
      message:
        result.status === "no_changes"
          ? "No new emails found"
          : `Processed ${result.processedCount} new emails`,
    };
  });
