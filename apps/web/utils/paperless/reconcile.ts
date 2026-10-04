import { randomUUID } from "node:crypto";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import { sendFiledNotification } from "@/utils/drive/filing-notifications";
import { sendFilingMessagingNotifications } from "@/utils/drive/filing-messaging-notifications";
import { PaperlessClient, PaperlessHttpError } from "./client";

const RECONCILE_LEASE_MS = 5 * 60_000;
const RENEW_LEASE_MS = 30_000;

export async function reconcilePaperlessFilings(logger: Logger) {
  const now = new Date();
  const filings = await prisma.documentFiling.findMany({
    where: {
      driveConnection: { provider: "paperless", isConnected: true },
      updatedAt: { lte: new Date(now.getTime() - 60_000) },
      AND: [
        {
          OR: [
            { paperlessReconcileLeaseUntil: null },
            { paperlessReconcileLeaseUntil: { lte: now } },
          ],
        },
      ],
      OR: [
        { status: "PROCESSING", paperlessTaskId: { not: null } },
        { status: "FILED", paperlessNotifyOnCompletion: true },
        {
          status: "PROCESSING",
          paperlessTaskId: null,
          updatedAt: { lte: new Date(now.getTime() - 30 * 60_000) },
        },
      ],
    },
    include: {
      driveConnection: true,
      emailAccount: { include: { account: { select: { provider: true } } } },
    },
    orderBy: { updatedAt: "asc" },
    take: 10,
  });
  let completed = 0;
  let failed = 0;
  for (let offset = 0; offset < filings.length; offset += 3) {
    await Promise.all(
      filings.slice(offset, offset + 3).map(async (filing) => {
        const log = logger.with({ filingId: filing.id });
        const leaseId = randomUUID();
        const claimTime = new Date();
        const ownedFiling = {
          id: filing.id,
          paperlessReconcileLeaseId: leaseId,
        };
        const lease = await prisma.documentFiling.updateMany({
          where: {
            id: filing.id,
            status: filing.status,
            updatedAt: filing.updatedAt,
            OR: [
              { paperlessReconcileLeaseUntil: null },
              { paperlessReconcileLeaseUntil: { lte: claimTime } },
            ],
          },
          data: {
            paperlessReconcileLeaseId: leaseId,
            paperlessReconcileLeaseUntil: new Date(
              claimTime.getTime() + RECONCILE_LEASE_MS,
            ),
          },
        });
        if (!lease.count) return;
        let leaseLost = false;
        let renewal = Promise.resolve();
        // Keep ownership while self-hosted provider calls await retries.
        const heartbeat = setInterval(() => {
          renewal = renewal.then(async () => {
            if (leaseLost) return;
            try {
              const renewed = await prisma.documentFiling.updateMany({
                where: ownedFiling,
                data: {
                  paperlessReconcileLeaseUntil: new Date(
                    Date.now() + RECONCILE_LEASE_MS,
                  ),
                },
              });
              if (!renewed.count) leaseLost = true;
            } catch {
              leaseLost = true;
              log.warn("Could not renew Paperless reconciliation lease");
            }
          });
        }, RENEW_LEASE_MS);
        heartbeat.unref();
        try {
          if (filing.status === "PROCESSING") {
            if (!filing.paperlessTaskId) {
              await prisma.documentFiling.update({
                where: { id: filing.id },
                data: {
                  status: "ERROR",
                  errorMessage: filing.paperlessUploadStartedAt
                    ? "Upload outcome unknown. Check Paperless before retrying."
                    : "Filing was interrupted before upload. You can retry.",
                },
              });
              failed += 1;
              return;
            }
            const client = new PaperlessClient(
              filing.driveConnection.baseUrl || "",
              filing.driveConnection.accessToken || "",
            );
            const task = await client.getTask(filing.paperlessTaskId);
            if (task.status === "processing") return;
            if (task.status === "missing") {
              if (
                !filing.paperlessUploadStartedAt ||
                filing.paperlessUploadStartedAt.getTime() >
                  now.getTime() - 30 * 60_000
              )
                return;
              await prisma.documentFiling.update({
                where: { id: filing.id },
                data: {
                  status: "ERROR",
                  errorMessage:
                    "Paperless no longer reports this task. Check whether the document was saved before retrying.",
                },
              });
              failed += 1;
              return;
            }
            if (task.status === "error") {
              await prisma.documentFiling.update({
                where: { id: filing.id },
                data: {
                  status: "ERROR",
                  paperlessUploadStartedAt: null,
                  errorMessage:
                    "Paperless could not consume this document. Check its task log and file support.",
                },
              });
              failed += 1;
              return;
            }
            await prisma.documentFiling.update({
              where: { id: filing.id },
              data: {
                status: "FILED",
                fileId: task.documentId,
                webUrl: task.webUrl,
                errorMessage: null,
              },
            });
            completed += 1;
          }
          if (leaseLost) return;
          if (filing.paperlessNotifyOnCompletion) {
            let emailDelivered = true;
            if (
              filing.emailAccount.filingConfirmationSendEmail &&
              !filing.notificationSentAt
            ) {
              try {
                const emailProvider = await createEmailProvider({
                  emailAccountId: filing.emailAccountId,
                  provider: filing.emailAccount.account.provider,
                  logger: log,
                });
                const message = await emailProvider.getMessage(
                  filing.messageId,
                );
                if (leaseLost) return;
                await sendFiledNotification({
                  emailProvider,
                  userEmail: filing.emailAccount.email,
                  filingId: filing.id,
                  logger: log,
                  sourceMessage: {
                    messageId: message.id,
                    threadId: message.threadId,
                    headerMessageId: message.headers["message-id"] || "",
                    references: message.headers.references,
                  },
                });
              } catch {
                emailDelivered = false;
                log.warn(
                  "Could not send Paperless completion email; will retry",
                );
              }
            }
            if (leaseLost) return;
            const messaging = await sendFilingMessagingNotifications({
              emailAccountId: filing.emailAccountId,
              filingId: filing.id,
              skipChannelIds: filing.paperlessNotifiedChannelIds,
              logger: log,
            });
            // Record known deliveries even if renewal failed; the owner guard remains authoritative.
            if (messaging.successfulChannelIds.length) {
              const recorded = await prisma.documentFiling.updateMany({
                where: ownedFiling,
                data: {
                  paperlessNotifiedChannelIds: {
                    push: messaging.successfulChannelIds,
                  },
                },
              });
              if (!recorded.count) return;
            }
            if (emailDelivered && !messaging.failedChannelIds.length) {
              await prisma.documentFiling.updateMany({
                where: ownedFiling,
                data: { paperlessNotifyOnCompletion: false },
              });
            }
          }
        } catch (error) {
          if (error instanceof PaperlessHttpError && error.statusCode === 401) {
            await prisma.driveConnection.updateMany({
              where: {
                id: filing.driveConnectionId,
                updatedAt: filing.driveConnection.updatedAt,
              },
              data: { isConnected: false },
            });
          }
          log.warn("Could not reconcile Paperless filing; will retry", {
            statusCode:
              error instanceof PaperlessHttpError
                ? error.statusCode
                : undefined,
          });
        } finally {
          clearInterval(heartbeat);
          await renewal;
          await prisma.documentFiling
            .updateMany({
              where: ownedFiling,
              data: {
                paperlessReconcileLeaseId: null,
                paperlessReconcileLeaseUntil: null,
              },
            })
            .catch(() => {
              log.warn(
                "Could not release Paperless reconciliation lease; it will expire",
              );
            });
        }
      }),
    );
  }
  return { checked: filings.length, completed, failed };
}
