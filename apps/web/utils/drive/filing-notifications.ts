import { randomUUID } from "node:crypto";
import prisma from "@/utils/prisma";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  getFilebotFrom,
  getFilebotReplyTo,
} from "@/utils/filebot/is-filebot-email";
import { escapeHtml } from "@/utils/string";

// ============================================================================
// Types
// ============================================================================

interface SourceMessageInfo {
  headerMessageId: string;
  // Platform-specific message ID (e.g. Microsoft Graph ID) — required so
  // Outlook's createReply can thread the notification into the source
  // conversation instead of starting a new thread.
  messageId?: string;
  references?: string;
  threadId: string;
}

interface FilingNotificationParams {
  emailProvider: EmailProvider;
  filingId: string;
  logger: Logger;
  sourceMessage: SourceMessageInfo;
  userEmail: string;
}

interface FilingNotificationsParams
  extends Omit<FilingNotificationParams, "filingId"> {
  filingIds: string[];
}

type FilingNotification = {
  driveConnection: { provider: string };
  filename: string;
  folderPath: string;
  reasoning: string | null;
  wasAsked: boolean;
  status?: string;
  webUrl?: string | null;
};

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Send a notification email for a successful filing.
 * "✓ Filed Receipt.pdf to Receipts/2024/December"
 * Sent as a reply to the source email thread.
 */
export async function sendFiledNotification({
  emailProvider,
  userEmail,
  filingId,
  sourceMessage,
  logger,
}: FilingNotificationParams): Promise<void> {
  const log = logger.with({ action: "sendFiledNotification", filingId });

  const filing = await prisma.documentFiling.findUnique({
    where: { id: filingId },
    include: {
      driveConnection: { select: { provider: true } },
    },
  });

  if (!filing) {
    log.error("Filing not found");
    return;
  }

  const replyToAddress = getFilebotReplyTo({ userEmail });
  const fromAddress = getFilebotFrom({ userEmail });

  const subject = `✓ Filed ${filing.filename}`;
  const messageHtml = buildFiledEmailHtml({
    filename: filing.filename,
    folderPath: filing.folderPath,
    driveProvider: filing.driveConnection.provider,
    webUrl: filing.webUrl,
  });

  await sendNotificationEmail({
    emailProvider,
    filingIds: [filingId],
    fromAddress,
    logger: log,
    messageHtml,
    replyToAddress,
    sourceMessage,
    subject,
    userEmail,
  });
}

/**
 * Send a notification email asking where to file a document.
 * "📄 Where should I file Contract.pdf?"
 * Sent as a reply to the source email thread.
 */
export async function sendAskNotification({
  emailProvider,
  userEmail,
  filingId,
  sourceMessage,
  logger,
}: FilingNotificationParams): Promise<void> {
  const log = logger.with({ action: "sendAskNotification", filingId });

  const filing = await prisma.documentFiling.findUnique({
    where: { id: filingId },
    include: { driveConnection: { select: { provider: true } } },
  });

  if (!filing) {
    log.error("Filing not found");
    return;
  }

  const replyToAddress = getFilebotReplyTo({ userEmail });
  const fromAddress = getFilebotFrom({ userEmail });

  const subject =
    filing.driveConnection.provider === "paperless"
      ? `📄 Save ${filing.filename} to Paperless?`
      : `📄 Where should I file ${filing.filename}?`;
  const messageHtml = buildAskEmailHtml({
    filename: filing.filename,
    reasoning: filing.reasoning,
    paperless: filing.driveConnection.provider === "paperless",
  });

  await sendNotificationEmail({
    emailProvider,
    filingIds: [filingId],
    fromAddress,
    logger: log,
    messageHtml,
    replyToAddress,
    sourceMessage,
    subject,
    userEmail,
  });
}

/**
 * Send one notification for all newly processed attachments in a source email.
 */
export async function sendFilingNotifications({
  emailProvider,
  userEmail,
  filingIds,
  sourceMessage,
  logger,
}: FilingNotificationsParams): Promise<void> {
  const log = logger.with({
    action: "sendFilingNotifications",
    filingCount: filingIds.length,
  });

  const filings = await prisma.documentFiling.findMany({
    where: {
      id: { in: filingIds },
      notificationBatchId: null,
      notificationSentAt: null,
    },
    include: {
      driveConnection: { select: { provider: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (filings.length === 0) {
    log.info("No filing notifications to send");
    return;
  }

  const replyToAddress = getFilebotReplyTo({ userEmail });
  const fromAddress = getFilebotFrom({ userEmail });
  const askedFilings = filings.filter(
    (filing) =>
      filing.wasAsked && (!filing.status || filing.status === "PENDING"),
  );
  const subject = getFilingNotificationSubject({
    filingCount: filings.length,
    askedCount: askedFilings.length,
    firstFilename: filings[0].filename,
    paperless: filings.every(
      (filing) => filing.driveConnection.provider === "paperless",
    ),
  });
  const messageHtml = getFilingNotificationHtml(filings);

  await sendNotificationEmail({
    emailProvider,
    filingIds: filings.map((filing) => filing.id),
    fromAddress,
    logger: log,
    messageHtml,
    replyToAddress,
    sourceMessage,
    subject,
    userEmail,
  });
}

/**
 * Send a confirmation email after a correction.
 * "Done! Moved to Business/Expenses"
 * Sent as a reply to the source email thread.
 */
export async function sendCorrectionConfirmation({
  emailProvider,
  userEmail,
  filingId,
  sourceMessage,
  newFolderPath,
  logger,
}: FilingNotificationParams & { newFolderPath: string }): Promise<void> {
  const log = logger.with({ action: "sendCorrectionConfirmation", filingId });

  const filing = await prisma.documentFiling.findUnique({
    where: { id: filingId },
  });

  if (!filing) {
    log.error("Filing not found");
    return;
  }

  const replyToAddress = getFilebotReplyTo({ userEmail });
  const fromAddress = getFilebotFrom({ userEmail });

  const subject = `Re: ✓ Filed ${filing.filename}`;
  const messageHtml = buildCorrectionConfirmationHtml({
    filename: filing.filename,
    newFolderPath,
  });

  try {
    await emailProvider.sendEmailWithHtml({
      replyToEmail: sourceMessage,
      to: userEmail,
      from: fromAddress,
      replyTo: replyToAddress,
      subject,
      messageHtml,
    });

    log.info("Correction confirmation sent");
  } catch (error) {
    log.error("Failed to send correction confirmation", { error });
    throw error;
  }
}

// ============================================================================
// Email Templates
// ============================================================================

function buildFiledEmailHtml({
  filename,
  folderPath,
  driveProvider,
  webUrl,
}: {
  filename: string;
  folderPath: string;
  driveProvider: string;
  webUrl?: string | null;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px;">
      <p>Filed your document:</p>
      ${buildFiledItemHtml({ filename, folderPath, driveName: getDriveName(driveProvider), webUrl })}
      
      <p style="color: #666; font-size: 14px;">
        ${driveProvider === "paperless" ? "Open Paperless to review document organization." : "Wrong folder? Just reply with where it should go."}
      </p>
    </div>
  `;
}

function buildAskEmailHtml({
  filename,
  reasoning,
  paperless = false,
}: {
  filename: string;
  reasoning: string | null;
  paperless?: boolean;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px;">
      <p>Got a document I'm not sure about:</p>
      ${buildAskItemHtml({ filename, reasoning })}
      
      <p><strong>${paperless ? "Save this attachment to Paperless?" : "Where should I put it?"}</strong></p>
      
      <p style="color: #666; font-size: 14px;">
        ${
          paperless
            ? 'Reply "save" to upload, or "skip" to ignore this attachment.'
            : `Reply with a folder path, e.g.:<br>
        • "Receipts/2024"<br>
        • "Projects/Acme Corp/Contracts"<br>
        • "Skip" to ignore this one`
        }
      </p>
    </div>
  `;
}

function buildFilingSummaryEmailHtml(filings: FilingNotification[]): string {
  const paperless = filings.every(
    (filing) => filing.driveConnection.provider === "paperless",
  );
  const filedItems = filings.filter(
    (filing) =>
      !(filing.wasAsked && (!filing.status || filing.status === "PENDING")),
  );
  const askedItems = filings.filter(
    (filing) =>
      filing.wasAsked && (!filing.status || filing.status === "PENDING"),
  );

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px;">
      ${
        filedItems.length > 0
          ? `<p>Filed your documents:</p>
             ${filedItems
               .map((filing) =>
                 buildFiledItemHtml({
                   filename: filing.filename,
                   folderPath: filing.folderPath,
                   driveName: getDriveName(filing.driveConnection.provider),
                   webUrl: filing.webUrl,
                 }),
               )
               .join("")}`
          : ""
      }
      ${
        askedItems.length > 0
          ? `<p>Got some documents I'm not sure about:</p>
             ${askedItems.map(buildAskItemHtml).join("")}`
          : ""
      }

      <p style="color: #666; font-size: 14px;">
        ${
          paperless
            ? askedItems.length > 0
              ? "Reply with the document name and save or skip for anything that needs your input."
              : "Open Paperless to review document organization."
            : askedItems.length > 0
              ? "Reply with the document name and folder path for anything that needs your input."
              : "Wrong folder? Reply with the document name and where it should go."
        }
      </p>
    </div>
  `;
}

function getFilingNotificationHtml(filings: FilingNotification[]): string {
  if (filings.length > 1) return buildFilingSummaryEmailHtml(filings);

  const filing = filings[0];
  if (filing.wasAsked && (!filing.status || filing.status === "PENDING")) {
    return buildAskEmailHtml({
      filename: filing.filename,
      reasoning: filing.reasoning,
      paperless: filing.driveConnection.provider === "paperless",
    });
  }

  return buildFiledEmailHtml({
    filename: filing.filename,
    folderPath: filing.folderPath,
    driveProvider: filing.driveConnection.provider,
    webUrl: filing.webUrl,
  });
}

function buildFiledItemHtml({
  filename,
  folderPath,
  driveName,
  webUrl,
}: {
  filename: string;
  folderPath: string;
  driveName: string;
  webUrl?: string | null;
}): string {
  return `
    <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 12px 0;">
      <p style="margin: 0 0 8px 0;"><strong>📄 ${escapeHtml(filename)}</strong></p>
      <p style="margin: 0; color: #666;">📁 → ${escapeHtml(folderPath)}</p>
      <p style="margin: 8px 0 0 0; font-size: 12px; color: #888;">${driveName}</p>
      ${webUrl ? `<p><a href="${escapeHtml(webUrl)}">Open document</a></p>` : ""}
    </div>
  `;
}

function buildAskItemHtml({
  filename,
  reasoning,
}: {
  filename: string;
  reasoning: string | null;
}): string {
  return `
    <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 12px 0;">
      <p style="margin: 0;"><strong>📄 ${escapeHtml(filename)}</strong></p>
      ${reasoning ? `<p style="margin: 8px 0 0 0; color: #666; font-size: 14px;">${escapeHtml(reasoning)}</p>` : ""}
    </div>
  `;
}

function getFilingNotificationSubject({
  filingCount,
  askedCount,
  firstFilename,
  paperless = false,
}: {
  filingCount: number;
  askedCount: number;
  firstFilename: string;
  paperless?: boolean;
}): string {
  if (filingCount === 1) {
    return askedCount === 1
      ? paperless
        ? `📄 Save ${firstFilename} to Paperless?`
        : `📄 Where should I file ${firstFilename}?`
      : `✓ Filed ${firstFilename}`;
  }

  if (askedCount === 0) return `✓ Filed ${filingCount} documents`;
  if (askedCount === filingCount) {
    return paperless
      ? `📄 Save ${filingCount} documents to Paperless?`
      : `📄 Where should I file ${filingCount} documents?`;
  }
  return `📄 Filing update for ${filingCount} documents`;
}

function getDriveName(provider: string): string {
  return provider === "paperless"
    ? "Paperless"
    : provider === "google"
      ? "Google Drive"
      : "OneDrive";
}

async function sendNotificationEmail({
  emailProvider,
  filingIds,
  fromAddress,
  logger,
  messageHtml,
  replyToAddress,
  sourceMessage,
  subject,
  userEmail,
}: {
  emailProvider: EmailProvider;
  filingIds: string[];
  fromAddress: string;
  logger: Logger;
  messageHtml: string;
  replyToAddress: string;
  sourceMessage: SourceMessageInfo;
  subject: string;
  userEmail: string;
}): Promise<void> {
  const notificationBatchId = randomUUID();
  const claim = await prisma.documentFiling.updateMany({
    where: {
      id: { in: filingIds },
      notificationBatchId: null,
      notificationSentAt: null,
    },
    data: { notificationBatchId },
  });

  if (claim.count !== filingIds.length) {
    await releaseNotificationBatch({
      filingIds,
      logger,
      notificationBatchId,
    });
    logger.info("Filing notification already claimed", {
      filingCount: filingIds.length,
    });
    return;
  }

  let result: Awaited<ReturnType<EmailProvider["sendEmailWithHtml"]>>;

  try {
    result = await emailProvider.sendEmailWithHtml({
      replyToEmail: sourceMessage,
      to: userEmail,
      from: fromAddress,
      replyTo: replyToAddress,
      subject,
      messageHtml,
    });
  } catch (error) {
    await releaseNotificationBatch({
      filingIds,
      logger,
      notificationBatchId,
    });

    logger.error("Failed to send filing notification", { error });
    throw error;
  }

  const batchCompleted = await completeNotificationBatch({
    filingIds,
    logger,
    notificationBatchId,
  });
  if (!batchCompleted) return;

  if (result.messageId) {
    try {
      await prisma.documentFiling.update({
        where: { id: filingIds[0] },
        data: { notificationMessageId: result.messageId },
      });
    } catch (error) {
      logger.error("Failed to save filing notification message ID", { error });
    }
  }

  logger.info("Filing notification sent", {
    messageId: result.messageId,
    filingCount: filingIds.length,
  });
}

async function completeNotificationBatch({
  filingIds,
  logger,
  notificationBatchId,
}: {
  filingIds: string[];
  logger: Logger;
  notificationBatchId: string;
}): Promise<boolean> {
  const notificationSentAt = new Date();
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await prisma.documentFiling.updateMany({
        where: {
          id: { in: filingIds },
          notificationBatchId,
        },
        data: {
          notificationSentAt,
        },
      });

      if (result.count === filingIds.length) return true;

      logger.error("Failed to complete every filing notification claim", {
        completedCount: result.count,
        filingCount: filingIds.length,
      });
      return false;
    } catch (error) {
      lastError = error;
    }
  }

  logger.error("Failed to complete filing notification claim", {
    error: lastError,
  });
  return false;
}

async function releaseNotificationBatch({
  filingIds,
  logger,
  notificationBatchId,
}: {
  filingIds: string[];
  logger: Logger;
  notificationBatchId: string;
}): Promise<void> {
  try {
    await prisma.documentFiling.updateMany({
      where: {
        id: { in: filingIds },
        notificationBatchId,
      },
      data: { notificationBatchId: null },
    });
  } catch (error) {
    logger.error("Failed to release filing notification claim", { error });
  }
}

function buildCorrectionConfirmationHtml({
  filename,
  newFolderPath,
}: {
  filename: string;
  newFolderPath: string;
}): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px;">
      <p>✓ Done! Moved <strong>${escapeHtml(filename)}</strong> to:</p>
      
      <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 0;">
          📁 ${escapeHtml(newFolderPath)}
        </p>
      </div>
    </div>
  `;
}
