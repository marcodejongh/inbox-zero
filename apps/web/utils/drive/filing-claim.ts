import prisma from "@/utils/prisma";
import type { Attachment } from "@/utils/types";
import type { Logger } from "@/utils/logger";
import { isDuplicateError } from "@/utils/prisma-helpers";
import type { FilingResult } from "@/utils/drive/filing-engine";

const DUPLICATE_FILING_FIELDS = ["emailAccountId", "messageId", "attachmentId"];
const PROCESSING_FILING_STALE_MS = 30 * 60 * 1000;

type AttachmentFiling = NonNullable<
  Awaited<ReturnType<typeof findAttachmentFiling>>
>;

type ExistingFilingDecision =
  | { type: "retry"; filingId: string }
  | { type: "return"; result: FilingResult };

type AttachmentLookup = {
  emailAccountId: string;
  messageId: string;
  attachmentId: string;
};

export function findAttachmentFiling({
  emailAccountId,
  messageId,
  attachmentId,
}: AttachmentLookup) {
  return prisma.documentFiling.findFirst({
    where: {
      emailAccountId,
      messageId,
      attachmentId,
    },
    select: {
      id: true,
      filename: true,
      folderPath: true,
      fileId: true,
      webUrl: true,
      paperlessTaskId: true,
      paperlessUploadStartedAt: true,
      paperlessNotifyOnCompletion: true,
      errorMessage: true,
      status: true,
      updatedAt: true,
      wasAsked: true,
      confidence: true,
      reasoning: true,
      driveConnection: {
        select: {
          provider: true,
        },
      },
    },
  });
}

export async function claimAttachmentFiling({
  existingFiling,
  attachmentLookup,
  attachment,
  driveConnectionId,
  logger,
}: {
  existingFiling: AttachmentFiling | null;
  attachmentLookup: AttachmentLookup;
  attachment: Attachment;
  driveConnectionId: string;
  logger: Logger;
}): Promise<ExistingFilingDecision> {
  if (existingFiling) {
    return claimOrResolveExistingFiling(existingFiling, logger);
  }

  try {
    const processingFiling = await prisma.documentFiling.create({
      data: {
        ...attachmentLookup,
        filename: attachment.filename,
        folderPath: "",
        status: "PROCESSING",
        driveConnectionId,
      },
    });
    return { type: "retry", filingId: processingFiling.id };
  } catch (claimError) {
    if (!isDuplicateError(claimError, DUPLICATE_FILING_FIELDS)) {
      throw claimError;
    }

    const claimedFiling = await findAttachmentFiling(attachmentLookup);
    if (!claimedFiling) throw claimError;

    logger.info("Attachment was claimed by another filing process", {
      filingId: claimedFiling.id,
      status: claimedFiling.status,
    });

    return claimOrResolveExistingFiling(claimedFiling, logger);
  }
}

async function claimOrResolveExistingFiling(
  filing: AttachmentFiling,
  logger: Logger,
): Promise<ExistingFilingDecision> {
  logger.info("Attachment already has a filing record", {
    filingId: filing.id,
    status: filing.status,
  });

  if (filing.paperlessTaskId || filing.paperlessUploadStartedAt) {
    return { type: "return", result: getExistingFilingResult(filing) };
  }

  if (filing.status === "ERROR") {
    const claim = await prisma.documentFiling.updateMany({
      where: {
        id: filing.id,
        status: "ERROR",
        ...(filing.driveConnection.provider === "paperless"
          ? {
              updatedAt: filing.updatedAt,
              paperlessTaskId: null,
              paperlessUploadStartedAt: null,
            }
          : {}),
      },
      data: {
        status: "PROCESSING",
        reasoning: null,
        updatedAt: new Date(),
      },
    });

    if (claim.count === 1) {
      logger.info("Retrying attachment after previous filing error", {
        filingId: filing.id,
      });
      return { type: "retry", filingId: filing.id };
    }

    return alreadyProcessing(filing.id);
  }

  if (filing.status === "PREVIEW") {
    return { type: "return", result: getExistingFilingResult(filing) };
  }

  if (filing.status === "PROCESSING") {
    const staleCutoff = new Date(Date.now() - PROCESSING_FILING_STALE_MS);

    if (filing.updatedAt <= staleCutoff) {
      const claim = await prisma.documentFiling.updateMany({
        where: {
          id: filing.id,
          status: "PROCESSING",
          updatedAt: { lte: staleCutoff },
          ...(filing.driveConnection.provider === "paperless"
            ? {
                paperlessTaskId: null,
                paperlessUploadStartedAt: null,
              }
            : {}),
        },
        data: {
          reasoning: null,
          updatedAt: new Date(),
        },
      });

      if (claim.count === 1) {
        logger.info("Retrying stale attachment filing claim", {
          filingId: filing.id,
        });
        return { type: "retry", filingId: filing.id };
      }
    }

    return alreadyProcessing(filing.id);
  }

  return { type: "return", result: getExistingFilingResult(filing) };
}

function alreadyProcessing(filingId: string): ExistingFilingDecision {
  return {
    type: "return",
    result: {
      success: false,
      error: "Attachment is already being filed",
      filingId,
    },
  };
}

export function isClaimableFiling(filing: AttachmentFiling) {
  return (
    !filing.paperlessTaskId &&
    !filing.paperlessUploadStartedAt &&
    (filing.status === "ERROR" || filing.status === "PROCESSING")
  );
}

export function getExistingFilingResult(
  filing: AttachmentFiling,
  logger?: Logger,
): FilingResult {
  logger?.info("Attachment already has a filing record", {
    filingId: filing.id,
    status: filing.status,
  });

  if (
    filing.status === "PREVIEW" ||
    (filing.driveConnection.provider === "paperless" &&
      filing.status === "REJECTED")
  ) {
    return {
      success: false,
      skipped: true,
      skipReason:
        filing.status === "REJECTED"
          ? "Skipped by you."
          : filing.reasoning || "Document doesn't match filing preferences",
      filingId: filing.id,
    };
  }

  if (filing.status === "ERROR") {
    return {
      success: false,
      filingId: filing.id,
      error: filing.errorMessage || filing.reasoning || "Filing failed",
    };
  }

  return {
    success: true,
    filing: {
      id: filing.id,
      filename: filing.filename,
      folderPath: filing.folderPath,
      fileId: filing.fileId,
      ...(filing.driveConnection.provider === "paperless"
        ? { webUrl: filing.webUrl, status: filing.status }
        : {}),
      wasAsked: filing.wasAsked,
      confidence: filing.confidence,
      provider: filing.driveConnection.provider,
    },
    filingId: filing.id,
  };
}
