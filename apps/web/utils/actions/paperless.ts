"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  connectPaperlessBody,
  updateFilingDestinationBody,
  savePaperlessAttachmentBody,
  resolvePaperlessFilingBody,
} from "./paperless.validation";
import {
  connectPaperless,
  setFilingDestination,
} from "@/utils/paperless/connections";
import { savePaperlessAttachment } from "@/utils/paperless/save";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { PaperlessClient } from "@/utils/paperless/client";

export const connectPaperlessAction = actionClient
  .metadata({ name: "connectPaperless" })
  .inputSchema(connectPaperlessBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput }) => {
    await connectPaperless({ emailAccountId, ...parsedInput });
  });

export const updateFilingDestinationAction = actionClient
  .metadata({ name: "updateFilingDestination" })
  .inputSchema(updateFilingDestinationBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { destination } }) => {
    await setFilingDestination(emailAccountId, destination);
  });

export const savePaperlessAttachmentAction = actionClient
  .metadata({ name: "savePaperlessAttachment" })
  .inputSchema(savePaperlessAttachmentBody)
  .action(async ({ ctx: { emailAccountId, provider, logger }, parsedInput }) =>
    savePaperlessAttachment({
      emailAccountId,
      provider,
      logger,
      ...parsedInput,
    }),
  );

export const confirmPaperlessFilingAction = actionClient
  .metadata({ name: "confirmPaperlessFiling" })
  .inputSchema(resolvePaperlessFilingBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { filingId },
    }) => {
      const filing = await prisma.documentFiling.findFirst({
        where: {
          id: filingId,
          emailAccountId,
          status: "PENDING",
          driveConnection: { provider: "paperless" },
        },
      });
      if (!filing) throw new SafeError("Pending Paperless filing not found.");
      return savePaperlessAttachment({
        emailAccountId,
        provider,
        logger,
        messageId: filing.messageId,
        attachmentId: filing.attachmentId,
      });
    },
  );

export const rejectPaperlessFilingAction = actionClient
  .metadata({ name: "rejectPaperlessFiling" })
  .inputSchema(resolvePaperlessFilingBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { filingId } }) => {
    const result = await prisma.documentFiling.updateMany({
      where: {
        id: filingId,
        emailAccountId,
        status: "PENDING",
        driveConnection: { provider: "paperless" },
      },
      data: { status: "REJECTED" },
    });
    if (!result.count)
      throw new SafeError("Pending Paperless filing not found.");
  });

export const retryPaperlessFilingAction = actionClient
  .metadata({ name: "retryPaperlessFiling" })
  .inputSchema(resolvePaperlessFilingBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { filingId },
    }) => {
      const filing = await prisma.documentFiling.findFirst({
        where: {
          id: filingId,
          emailAccountId,
          status: "ERROR",
          driveConnection: { provider: "paperless", isConnected: true },
        },
        include: { driveConnection: true },
      });
      if (!filing)
        throw new SafeError("Reconnect Paperless before retrying this filing.");
      if (filing.paperlessTaskId) {
        const client = new PaperlessClient(
          filing.driveConnection.baseUrl || "",
          filing.driveConnection.accessToken || "",
        );
        const task = await client.getTask(filing.paperlessTaskId);
        if (task.status !== "error" && task.status !== "missing") {
          await prisma.documentFiling.updateMany({
            where: {
              id: filing.id,
              emailAccountId,
              status: "ERROR",
              updatedAt: filing.updatedAt,
            },
            data:
              task.status === "filed"
                ? {
                    status: "FILED",
                    fileId: task.documentId,
                    webUrl: task.webUrl,
                    errorMessage: null,
                  }
                : { status: "PROCESSING", errorMessage: null },
          });
          return;
        }
      }
      const reset = await prisma.documentFiling.updateMany({
        where: {
          id: filing.id,
          emailAccountId,
          status: "ERROR",
          updatedAt: filing.updatedAt,
        },
        data: {
          paperlessTaskId: null,
          paperlessUploadStartedAt: null,
          errorMessage: null,
        },
      });
      if (!reset.count)
        throw new SafeError("Another request is already retrying this filing.");
      return savePaperlessAttachment({
        emailAccountId,
        provider,
        logger,
        messageId: filing.messageId,
        attachmentId: filing.attachmentId,
      });
    },
  );
