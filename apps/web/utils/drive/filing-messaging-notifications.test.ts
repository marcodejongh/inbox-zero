import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  MessagingProvider,
  MessagingRoutePurpose,
  MessagingRouteTargetType,
} from "@/generated/prisma/enums";
import { createTestLogger } from "@/__tests__/helpers";
import { sendFilingMessagingNotifications } from "./filing-messaging-notifications";
import {
  resolveSlackRouteDestination,
  sendDocumentFiledToSlack,
  sendDocumentAskToSlack,
} from "@/utils/messaging/providers/slack/send";
import { sendAutomationMessage } from "@/utils/automation-jobs/messaging";

vi.mock("@/utils/prisma");
vi.mock("@/utils/messaging/providers/slack/send", () => ({
  resolveSlackRouteDestination: vi.fn(),
  sendDocumentFiledToSlack: vi.fn(),
  sendDocumentAskToSlack: vi.fn(),
}));
vi.mock("@/utils/automation-jobs/messaging", () => ({
  sendAutomationMessage: vi.fn(),
}));

const logger = createTestLogger();

describe("sendFilingMessagingNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.documentFiling.findUnique.mockResolvedValue({
      id: "filing-1",
      filename: "invoice.pdf",
      folderPath: "Invoices",
      reasoning: null,
      fileId: "file-1",
      wasAsked: false,
      driveConnection: { provider: "google" },
    } as any);
  });

  function channel(id: string, provider: MessagingProvider) {
    return {
      id,
      provider,
      isConnected: true,
      accessToken: "token",
      providerUserId: "user-1",
      teamId: "team-1",
      routes: [
        {
          purpose: MessagingRoutePurpose.DOCUMENT_FILINGS,
          targetType: MessagingRouteTargetType.DIRECT_MESSAGE,
          targetId: "destination-1",
        },
      ],
    };
  }

  it("reports successful and failed channels independently", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      channel("slack-1", MessagingProvider.SLACK),
      channel("teams-1", MessagingProvider.TEAMS),
      channel("telegram-1", MessagingProvider.TELEGRAM),
    ] as any);
    vi.mocked(resolveSlackRouteDestination).mockResolvedValueOnce("C1");
    vi.mocked(sendDocumentFiledToSlack).mockResolvedValueOnce(undefined);
    vi.mocked(sendAutomationMessage).mockRejectedValueOnce(
      new Error("Teams unavailable"),
    );
    vi.mocked(sendAutomationMessage).mockResolvedValueOnce({
      messageId: "m1",
      channelId: "destination-1",
    });
    expect(
      await sendFilingMessagingNotifications({
        emailAccountId: "email-account-1",
        filingId: "filing-1",
        logger,
      }),
    ).toEqual({
      successfulChannelIds: ["slack-1", "telegram-1"],
      failedChannelIds: ["teams-1"],
    });
  });
  it("excludes already delivered channels when retrying", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      channel("teams-1", MessagingProvider.TEAMS),
    ] as any);
    vi.mocked(sendAutomationMessage).mockResolvedValueOnce({
      messageId: "m1",
      channelId: "destination-1",
    });
    expect(
      await sendFilingMessagingNotifications({
        emailAccountId: "email-account-1",
        filingId: "filing-1",
        logger,
        skipChannelIds: ["slack-1", "telegram-1"],
      }),
    ).toEqual({ successfulChannelIds: ["teams-1"], failedChannelIds: [] });
    expect(prisma.messagingChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { notIn: ["slack-1", "telegram-1"] },
        }),
      }),
    );
    expect(sendDocumentFiledToSlack).not.toHaveBeenCalled();
  });
  it("retries Slack destination failures while delivering to other channels", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      channel("slack-1", MessagingProvider.SLACK),
      channel("teams-1", MessagingProvider.TEAMS),
    ] as any);
    vi.mocked(resolveSlackRouteDestination).mockRejectedValueOnce(
      new Error("Slack unavailable"),
    );
    vi.mocked(sendAutomationMessage).mockResolvedValueOnce({
      messageId: "m1",
      channelId: "destination-1",
    });
    expect(
      await sendFilingMessagingNotifications({
        emailAccountId: "email-account-1",
        filingId: "filing-1",
        logger,
      }),
    ).toEqual({
      successfulChannelIds: ["teams-1"],
      failedChannelIds: ["slack-1"],
    });
  });

  it("skips Slack channels missing a provider user id", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      {
        id: "channel-1",
        provider: MessagingProvider.SLACK,
        isConnected: true,
        accessToken: "xoxb-token",
        teamId: "team-1",
        providerUserId: null,
        routes: [
          {
            purpose: MessagingRoutePurpose.DOCUMENT_FILINGS,
            targetType: MessagingRouteTargetType.CHANNEL,
            targetId: "C1",
          },
        ],
      },
    ] as any);

    await sendFilingMessagingNotifications({
      emailAccountId: "email-account-1",
      filingId: "filing-1",
      logger,
    });

    expect(resolveSlackRouteDestination).not.toHaveBeenCalled();
    expect(sendDocumentFiledToSlack).not.toHaveBeenCalled();
    expect(sendDocumentAskToSlack).not.toHaveBeenCalled();
  });

  it("skips Teams channels missing a provider user id", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      {
        id: "channel-2",
        provider: MessagingProvider.TEAMS,
        isConnected: true,
        accessToken: null,
        teamId: "team-2",
        providerUserId: null,
        routes: [
          {
            purpose: MessagingRoutePurpose.DOCUMENT_FILINGS,
            targetType: MessagingRouteTargetType.DIRECT_MESSAGE,
            targetId: "29:teams-user",
          },
        ],
      },
    ] as any);

    await sendFilingMessagingNotifications({
      emailAccountId: "email-account-1",
      filingId: "filing-1",
      logger,
    });

    expect(sendAutomationMessage).not.toHaveBeenCalled();
  });
});
