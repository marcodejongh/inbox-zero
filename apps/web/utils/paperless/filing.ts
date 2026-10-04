import prisma from "@/utils/prisma";
import type { DriveConnection } from "@/generated/prisma/client";
import type {
  FilingResult,
  ProcessAttachmentOptions,
} from "@/utils/drive/filing-engine";
import {
  claimAttachmentFiling,
  findAttachmentFiling,
  getExistingFilingResult,
} from "@/utils/drive/filing-claim";
import { extractTextFromDocument } from "@/utils/drive/document-extraction";
import { sendAskNotification } from "@/utils/drive/filing-notifications";
import { sendFilingMessagingNotifications } from "@/utils/drive/filing-messaging-notifications";
import { PaperlessClient, PaperlessHttpError } from "./client";
import { analyzePaperlessAttachment } from "./analyze";
import { isPaperlessAttachment } from "./attachments";
import { SafeError } from "@/utils/error";

export async function processPaperlessAttachment({
  attachment,
  emailAccount,
  emailProvider,
  logger,
  message,
  sendNotification = true,
  manual = false,
}: ProcessAttachmentOptions & { manual?: boolean }): Promise<FilingResult> {
  let filingId: string | undefined;
  let connection: DriveConnection | null = null;
  try {
    if (
      !manual &&
      (!emailAccount.filingEnabled || !emailAccount.filingPrompt)
    ) {
      return {
        success: false,
        error: "Filing is paused or preferences are missing.",
      };
    }
    if (!isPaperlessAttachment(attachment))
      return {
        success: false,
        skipped: true,
        skipReason: "Paperless does not support this attachment type.",
      };
    connection = await prisma.driveConnection.findUnique({
      where: {
        emailAccountId_provider: {
          emailAccountId: emailAccount.id,
          provider: "paperless",
        },
      },
    });
    if (
      !connection?.isConnected ||
      !connection.baseUrl ||
      !connection.accessToken
    ) {
      return {
        success: false,
        error: "Connect Paperless before saving attachments.",
      };
    }
    const lookup = {
      emailAccountId: emailAccount.id,
      messageId: message.id,
      attachmentId: attachment.attachmentId,
    };
    const existing = await findAttachmentFiling(lookup);
    if (
      manual &&
      existing &&
      existing.driveConnection.provider !== "paperless"
    ) {
      return {
        success: false,
        error: "This attachment was already filed to a cloud drive.",
      };
    }
    if (
      manual &&
      existing &&
      ["PENDING", "PREVIEW", "REJECTED"].includes(existing.status)
    ) {
      const claim = await prisma.documentFiling.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
          updatedAt: existing.updatedAt,
          paperlessUploadStartedAt: null,
          paperlessTaskId: null,
          driveConnection: { provider: "paperless" },
        },
        data: { status: "PROCESSING", wasAsked: false, errorMessage: null },
      });
      if (!claim.count) return getExistingFilingResult(existing);
      filingId = existing.id;
    } else {
      const claim = await claimAttachmentFiling({
        existingFiling: existing,
        attachmentLookup: lookup,
        attachment,
        driveConnectionId: connection.id,
        logger,
      });
      if (claim.type === "return") return claim.result;
      filingId = claim.filingId;
    }
    const download = await emailProvider.getAttachment(
      message.id,
      attachment.attachmentId,
    );
    const content = Buffer.from(download.data, "base64");
    let analysis = {
      action: "save",
      confidence: 1,
      reasoning: "Saved manually.",
    };
    if (!manual) {
      const extraction = await extractTextFromDocument(
        content,
        attachment.mimeType,
        { logger },
      );
      analysis = await analyzePaperlessAttachment({
        emailAccount: {
          ...emailAccount,
          filingPrompt: emailAccount.filingPrompt || "",
        },
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        subject: message.headers.subject || message.subject,
        sender: message.headers.from,
        content: extraction?.text ?? "",
      });
    }
    const shouldAsk = analysis.action === "save" && analysis.confidence < 0.7;
    const decision = await prisma.documentFiling.updateMany({
      where: {
        id: filingId,
        status: "PROCESSING",
        paperlessTaskId: null,
        paperlessUploadStartedAt: null,
      },
      data: {
        driveConnectionId: connection.id,
        folderId: null,
        folderPath: "Paperless",
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        status:
          analysis.action === "skip"
            ? "PREVIEW"
            : shouldAsk
              ? "PENDING"
              : "PROCESSING",
        wasAsked: shouldAsk,
        paperlessNotifyOnCompletion: !manual || !!existing?.wasAsked,
        ...(manual && existing?.wasAsked
          ? { notificationBatchId: null, notificationSentAt: null }
          : {}),
      },
    });
    if (!decision.count) {
      const current = await findAttachmentFiling(lookup);
      return current
        ? getExistingFilingResult(current)
        : { success: false, error: "Filing record no longer exists." };
    }
    if (analysis.action === "skip")
      return {
        success: false,
        skipped: true,
        skipReason: analysis.reasoning,
        filingId,
      };
    if (shouldAsk) {
      if (sendNotification)
        await sendAskNotification({
          emailProvider,
          userEmail: emailAccount.email,
          filingId,
          sourceMessage: {
            threadId: message.threadId,
            messageId: message.id,
            headerMessageId: message.headers["message-id"] || "",
            references: message.headers.references,
          },
          logger,
        }).catch(() =>
          logger.warn("Could not deliver Paperless confirmation email"),
        );
      await sendFilingMessagingNotifications({
        emailAccountId: emailAccount.id,
        filingId,
        logger,
      }).catch(() =>
        logger.warn("Could not deliver Paperless confirmation request"),
      );
    } else {
      const submitted = await submitPaperlessUpload({
        filingId,
        connection,
        content,
        attachment,
      });
      if (!submitted) {
        const current = await findAttachmentFiling(lookup);
        return current
          ? getExistingFilingResult(current)
          : { success: false, error: "Filing record no longer exists." };
      }
    }
    return {
      success: true,
      filingId,
      filing: {
        id: filingId,
        filename: attachment.filename,
        folderPath: "Paperless",
        fileId: null,
        status: shouldAsk ? "PENDING" : "PROCESSING",
        wasAsked: shouldAsk,
        confidence: analysis.confidence,
        provider: "paperless",
      },
    };
  } catch (error) {
    const errorMessage =
      error instanceof SafeError
        ? error.message
        : "Could not prepare or save this attachment. Please try again.";
    if (filingId)
      await prisma.documentFiling.updateMany({
        where: { id: filingId, status: "PROCESSING", paperlessTaskId: null },
        data: {
          status: "ERROR",
          errorMessage,
        },
      });
    if (
      connection &&
      error instanceof PaperlessHttpError &&
      error.statusCode === 401
    ) {
      await prisma.driveConnection.updateMany({
        where: { id: connection.id, updatedAt: connection.updatedAt },
        data: { isConnected: false },
      });
    }
    logger.warn("Paperless filing failed", { filingId });
    return {
      success: false,
      filingId,
      error: errorMessage,
    };
  }
}

async function submitPaperlessUpload({
  filingId,
  connection,
  content,
  attachment,
}: {
  filingId: string;
  connection: DriveConnection;
  content: Buffer;
  attachment: { filename: string; mimeType: string };
}) {
  const client = new PaperlessClient(
    connection.baseUrl || "",
    connection.accessToken || "",
  );
  // Persist before POST: a process crash or lost response must never trigger a blind re-upload.
  const uploadClaim = await prisma.documentFiling.updateMany({
    where: {
      id: filingId,
      status: "PROCESSING",
      paperlessTaskId: null,
      paperlessUploadStartedAt: null,
    },
    data: { paperlessUploadStartedAt: new Date() },
  });
  if (!uploadClaim.count) return false;
  try {
    const taskId = await client.upload({
      content,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    });
    await prisma.documentFiling.update({
      where: { id: filingId },
      data: { paperlessTaskId: taskId, errorMessage: null },
    });
    return true;
  } catch (error) {
    if (
      error instanceof PaperlessHttpError &&
      error.statusCode &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      await prisma.documentFiling.update({
        where: { id: filingId },
        data: { paperlessUploadStartedAt: null },
      });
    }
    throw error;
  }
}
