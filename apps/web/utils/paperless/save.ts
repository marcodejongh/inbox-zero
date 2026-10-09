import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import { getFilableAttachments } from "@/utils/drive/filing-engine";
import type { Logger } from "@/utils/logger";
import { processPaperlessAttachment } from "./filing";

export async function savePaperlessAttachment({
  emailAccountId,
  provider,
  messageId,
  attachmentId,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  messageId: string;
  attachmentId: string;
  logger: Logger;
}) {
  const emailAccount = await prisma.emailAccount.findUniqueOrThrow({
    where: { id: emailAccountId },
    include: { user: true, account: true },
  });
  if (emailAccount.filingDestination !== "paperless")
    throw new SafeError("Select Paperless as your filing destination first.");
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });
  const message = await emailProvider.getMessage(messageId);
  const attachment = getFilableAttachments(message).find(
    (item) => item.attachmentId === attachmentId,
  );
  if (!attachment) throw new SafeError("Attachment not found.");
  const result = await processPaperlessAttachment({
    emailAccount,
    emailProvider,
    logger,
    message,
    attachment,
    manual: true,
    sendNotification: false,
  });
  if (!result.success || !result.filing)
    throw new SafeError(
      result.error || result.skipReason || "Could not save the attachment.",
    );
  return result.filing;
}
