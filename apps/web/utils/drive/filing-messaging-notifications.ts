import prisma from "@/utils/prisma";
import {
  MessagingProvider,
  MessagingRoutePurpose,
} from "@/generated/prisma/enums";
import {
  resolveSlackRouteDestination,
  sendDocumentFiledToSlack,
  sendDocumentAskToSlack,
} from "@/utils/messaging/providers/slack/send";
import type { Logger } from "@/utils/logger";
import { sendAutomationMessage } from "@/utils/automation-jobs/messaging";
import {
  getMessagingRoute,
  getMessagingRouteWhere,
} from "@/utils/messaging/routes";
import { isMessagingChannelOperational } from "@/utils/messaging/channel-validity";

export async function sendFilingMessagingNotifications({
  emailAccountId,
  filingId,
  senderEmail,
  skipChannelIds = [],
  logger,
}: {
  emailAccountId: string;
  filingId: string;
  senderEmail?: string | null;
  skipChannelIds?: string[];
  logger: Logger;
}): Promise<{ successfulChannelIds: string[]; failedChannelIds: string[] }> {
  const log = logger.with({
    action: "sendFilingMessagingNotifications",
    filingId,
  });

  const channels = await prisma.messagingChannel.findMany({
    where: {
      emailAccountId,
      isConnected: true,
      id: { notIn: skipChannelIds },
      ...getMessagingRouteWhere(MessagingRoutePurpose.DOCUMENT_FILINGS),
    },
    select: {
      id: true,
      provider: true,
      isConnected: true,
      accessToken: true,
      teamId: true,
      providerUserId: true,
      routes: {
        select: {
          purpose: true,
          targetType: true,
          targetId: true,
        },
      },
    },
  });

  const successfulChannelIds: string[] = [];
  const failedChannelIds: string[] = [];
  if (channels.length === 0) return { successfulChannelIds, failedChannelIds };

  const filing = await prisma.documentFiling.findUnique({
    where: { id: filingId },
    include: {
      driveConnection: { select: { provider: true } },
    },
  });

  if (!filing) {
    log.error("Filing not found for messaging notification");
    return {
      successfulChannelIds,
      failedChannelIds: channels.map((channel) => channel.id),
    };
  }

  const deliveryPromises: { channelId: string; promise: Promise<unknown> }[] =
    [];

  for (const channel of channels) {
    const route = getMessagingRoute(
      channel.routes,
      MessagingRoutePurpose.DOCUMENT_FILINGS,
    );
    if (!route) continue;
    if (!isMessagingChannelOperational(channel)) {
      log.warn("Skipping filing notification for invalid messaging channel", {
        messagingChannelId: channel.id,
        provider: channel.provider,
      });
      continue;
    }

    switch (channel.provider) {
      case MessagingProvider.SLACK: {
        if (!channel.accessToken) continue;
        const destination = await resolveSlackRouteDestination({
          accessToken: channel.accessToken,
          route,
        }).catch((error: unknown) => {
          log.error("Slack destination resolution failed", { error });
          return null;
        });
        if (!destination) {
          failedChannelIds.push(channel.id);
          continue;
        }

        if (filing.wasAsked && filing.status === "PENDING") {
          deliveryPromises.push({
            channelId: channel.id,
            promise: sendDocumentAskToSlack({
              accessToken: channel.accessToken,
              channelId: destination,
              filename: filing.filename,
              reasoning: filing.reasoning,
              senderEmail,
              paperless: filing.driveConnection.provider === "paperless",
            }),
          });
        } else {
          deliveryPromises.push({
            channelId: channel.id,
            promise: sendDocumentFiledToSlack({
              accessToken: channel.accessToken,
              channelId: destination,
              filename: filing.filename,
              folderPath: filing.folderPath,
              driveProvider: filing.driveConnection.provider,
              senderEmail,
              fileId: filing.fileId,
              webUrl: filing.webUrl,
            }),
          });
        }
        break;
      }
      case MessagingProvider.TEAMS:
      case MessagingProvider.TELEGRAM: {
        deliveryPromises.push({
          channelId: channel.id,
          promise: sendAutomationMessage({
            channel,
            route,
            text:
              filing.wasAsked && filing.status === "PENDING"
                ? formatDocumentAskText({
                    filename: filing.filename,
                    reasoning: filing.reasoning,
                    senderEmail,
                    paperless: filing.driveConnection.provider === "paperless",
                  })
                : formatDocumentFiledText({
                    filename: filing.filename,
                    folderPath: filing.folderPath,
                    senderEmail,
                    webUrl: filing.webUrl,
                  }),
            logger: log,
          }),
        });
        break;
      }
    }
  }

  const results = await Promise.allSettled(
    deliveryPromises.map((delivery) => delivery.promise),
  );
  for (const [index, result] of results.entries()) {
    const channelId = deliveryPromises[index].channelId;
    if (result.status === "fulfilled") {
      successfulChannelIds.push(channelId);
    } else {
      failedChannelIds.push(channelId);
      log.error("Filing notification failed", { reason: result.reason });
    }
  }
  return { successfulChannelIds, failedChannelIds };
}

function formatDocumentAskText({
  filename,
  reasoning,
  senderEmail,
  paperless,
}: {
  filename: string;
  reasoning: string | null;
  senderEmail?: string | null;
  paperless?: boolean;
}) {
  const fromPart = senderEmail ? ` from ${senderEmail}` : "";
  const reasonPart = reasoning ? ` — ${reasoning}` : "";
  return paperless
    ? `📄 Save ${filename}${fromPart} to Paperless?${reasonPart} Confirm Save or Skip in attachment filing activity.`
    : `📄 Where should I file ${filename}${fromPart}?${reasonPart}`;
}

function formatDocumentFiledText({
  filename,
  folderPath,
  senderEmail,
  webUrl,
}: {
  filename: string;
  folderPath: string;
  senderEmail?: string | null;
  webUrl?: string | null;
}) {
  const fromPart = senderEmail ? ` from ${senderEmail}` : "";
  return `📨 Filed ${filename}${fromPart} to ${folderPath}${webUrl ? `\n${webUrl}` : ""}`;
}
