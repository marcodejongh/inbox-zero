import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { reconcilePaperlessFilings } from "./reconcile";
import { createEmailProvider } from "@/utils/email/provider";
import { sendFiledNotification } from "@/utils/drive/filing-notifications";
import { sendFilingMessagingNotifications } from "@/utils/drive/filing-messaging-notifications";
import { createMockEmailProvider } from "@/__tests__/mocks/email-provider.mock";

const emailProvider = createMockEmailProvider();

const { getTask } = vi.hoisted(() => ({ getTask: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  PaperlessClient: class {
    getTask = getTask;
  },
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/drive/filing-notifications", () => ({
  sendFiledNotification: vi.fn(),
}));
vi.mock("@/utils/drive/filing-messaging-notifications", () => ({
  sendFilingMessagingNotifications: vi.fn(),
}));

function filing(overrides = {}) {
  return {
    id: "filing-1",
    driveConnectionId: "connection-1",
    status: "PROCESSING",
    paperlessTaskId: "task-1",
    updatedAt: new Date(0),
    paperlessNotifyOnCompletion: false,
    paperlessNotifiedChannelIds: [],
    notificationSentAt: null,
    emailAccountId: "mailbox-1",
    messageId: "message-1",
    emailAccount: {
      email: "user@example.com",
      filingConfirmationSendEmail: true,
      account: { provider: "google" },
    },
    driveConnection: {
      baseUrl: "https://paperless.example.com",
      accessToken: "token",
    },
    ...overrides,
  } as any;
}

describe("Paperless reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.documentFiling.findMany.mockResolvedValue([filing()]);
    prisma.documentFiling.updateMany.mockResolvedValue({ count: 1 });
    getTask.mockResolvedValue({ status: "processing" });
    vi.mocked(createEmailProvider).mockResolvedValue(emailProvider);
    vi.mocked(sendFiledNotification).mockResolvedValue(undefined);
    vi.mocked(sendFilingMessagingNotifications).mockResolvedValue({
      successfulChannelIds: ["slack-1"],
      failedChannelIds: [],
    });
  });
  it.each([
    "provider",
    "source message",
    "send",
  ])("still delivers messaging when email %s fails, and retries without repeating delivered channels", async (stage) => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({ status: "FILED", paperlessNotifyOnCompletion: true }),
    ]);
    if (stage === "provider")
      vi.mocked(createEmailProvider).mockRejectedValueOnce(
        new Error("Expired auth"),
      );
    if (stage === "source message")
      vi.mocked(emailProvider.getMessage).mockRejectedValueOnce(
        new Error("Deleted message"),
      );
    if (stage === "send")
      vi.mocked(sendFiledNotification).mockRejectedValueOnce(
        new Error("Send failed"),
      );
    await reconcilePaperlessFilings(createTestLogger());
    expect(sendFilingMessagingNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        skipChannelIds: [],
      }),
    );
    expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith({
      where: { id: "filing-1", paperlessReconcileLeaseId: expect.any(String) },
      data: { paperlessNotifiedChannelIds: { push: ["slack-1"] } },
    });
    expect(prisma.documentFiling.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paperlessNotifyOnCompletion: false },
      }),
    );
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({
        status: "FILED",
        paperlessNotifyOnCompletion: true,
        paperlessNotifiedChannelIds: ["slack-1"],
      }),
    ]);
    vi.mocked(sendFilingMessagingNotifications).mockResolvedValueOnce({
      successfulChannelIds: [],
      failedChannelIds: [],
    });
    await reconcilePaperlessFilings(createTestLogger());
    expect(sendFilingMessagingNotifications).toHaveBeenLastCalledWith(
      expect.objectContaining({ skipChannelIds: ["slack-1"] }),
    );
    expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith({
      where: { id: "filing-1", paperlessReconcileLeaseId: expect.any(String) },
      data: { paperlessNotifyOnCompletion: false },
    });
  });
  it("retries failed messaging without fetching or resending an already delivered email", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({
        status: "FILED",
        paperlessNotifyOnCompletion: true,
        notificationSentAt: new Date(),
        paperlessNotifiedChannelIds: ["slack-1"],
      }),
    ]);
    vi.mocked(sendFilingMessagingNotifications).mockResolvedValueOnce({
      successfulChannelIds: ["teams-1"],
      failedChannelIds: ["telegram-1"],
    });
    await reconcilePaperlessFilings(createTestLogger());
    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(sendFiledNotification).not.toHaveBeenCalled();
    expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith({
      where: { id: "filing-1", paperlessReconcileLeaseId: expect.any(String) },
      data: { paperlessNotifiedChannelIds: { push: ["teams-1"] } },
    });
    expect(prisma.documentFiling.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { paperlessNotifyOnCompletion: false } }),
    );
  });
  it("renews a slow worker's owned lease beyond five minutes and releases it after delivery", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({
        status: "FILED",
        paperlessNotifyOnCompletion: true,
        notificationSentAt: new Date(),
      }),
    ]);
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(sendFilingMessagingNotifications).mockImplementationOnce(
      async () => {
        started();
        await blocked;
        return { successfulChannelIds: ["slack-1"], failedChannelIds: [] };
      },
    );
    vi.useFakeTimers();
    const sweep = reconcilePaperlessFilings(createTestLogger());
    try {
      await began;
      const leaseId =
        prisma.documentFiling.updateMany.mock.calls[0][0].data
          .paperlessReconcileLeaseId;
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(prisma.documentFiling.updateMany).toHaveBeenLastCalledWith({
        where: { id: "filing-1", paperlessReconcileLeaseId: leaseId },
        data: {
          paperlessReconcileLeaseUntil: new Date(Date.now() + 5 * 60_000),
        },
      });
      finish();
      await sweep;
      expect(prisma.documentFiling.updateMany).toHaveBeenLastCalledWith({
        where: { id: "filing-1", paperlessReconcileLeaseId: leaseId },
        data: {
          paperlessReconcileLeaseId: null,
          paperlessReconcileLeaseUntil: null,
        },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish();
      await sweep;
      vi.useRealTimers();
    }
  });
  it("records a known successful delivery after a transient heartbeat error without dropping its receipt", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({
        status: "FILED",
        paperlessNotifyOnCompletion: true,
        notificationSentAt: new Date(),
      }),
    ]);
    prisma.documentFiling.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("Database unavailable"));
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(sendFilingMessagingNotifications).mockImplementationOnce(
      async () => {
        started();
        await blocked;
        return { successfulChannelIds: ["slack-1"], failedChannelIds: [] };
      },
    );
    vi.useFakeTimers();
    const sweep = reconcilePaperlessFilings(createTestLogger());
    try {
      await began;
      await vi.advanceTimersByTimeAsync(30_000);
      finish();
      await sweep;
      expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith({
        where: {
          id: "filing-1",
          paperlessReconcileLeaseId: expect.any(String),
        },
        data: { paperlessNotifiedChannelIds: { push: ["slack-1"] } },
      });
      expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith({
        where: {
          id: "filing-1",
          paperlessReconcileLeaseId: expect.any(String),
        },
        data: { paperlessNotifyOnCompletion: false },
      });
    } finally {
      finish();
      await sweep;
      vi.useRealTimers();
    }
  });
  it("does not record delivery or clear another worker's notification intent after losing ownership", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({
        status: "FILED",
        paperlessNotifyOnCompletion: true,
        notificationSentAt: new Date(),
      }),
    ]);
    prisma.documentFiling.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await reconcilePaperlessFilings(createTestLogger());
    expect(prisma.documentFiling.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { paperlessNotifyOnCompletion: false } }),
    );
    const receiptCall = prisma.documentFiling.updateMany.mock.calls.find(
      ([args]) => args.data.paperlessNotifiedChannelIds,
    );
    expect(receiptCall?.[0].where).toEqual({
      id: "filing-1",
      paperlessReconcileLeaseId: expect.any(String),
    });
  });
  it("keeps running consumption tasks processing", async () => {
    expect(
      (await reconcilePaperlessFilings(createTestLogger())).completed,
    ).toBe(0);
    expect(prisma.documentFiling.update).not.toHaveBeenCalled();
  });
  it("persists the document ID and link only after consumption succeeds", async () => {
    getTask.mockResolvedValue({
      status: "filed",
      documentId: "42",
      webUrl: "https://paperless.example.com/documents/42/details",
    });
    expect(
      (await reconcilePaperlessFilings(createTestLogger())).completed,
    ).toBe(1);
    expect(prisma.documentFiling.update).toHaveBeenCalledWith({
      where: { id: "filing-1" },
      data: {
        status: "FILED",
        fileId: "42",
        webUrl: "https://paperless.example.com/documents/42/details",
        errorMessage: null,
      },
    });
  });
  it("reports consumption failures without re-uploading", async () => {
    getTask.mockResolvedValue({ status: "error" });
    expect((await reconcilePaperlessFilings(createTestLogger())).failed).toBe(
      1,
    );
    expect(prisma.documentFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ERROR",
          paperlessUploadStartedAt: null,
        }),
      }),
    );
  });
  it("lets transient API failures retry on the next sweep", async () => {
    getTask.mockRejectedValue(new Error("Unavailable"));
    await reconcilePaperlessFilings(createTestLogger());
    expect(prisma.documentFiling.update).not.toHaveBeenCalled();
  });
  it("does not reconcile rows claimed by another sweep", async () => {
    prisma.documentFiling.updateMany.mockResolvedValue({ count: 0 });
    await reconcilePaperlessFilings(createTestLogger());
    expect(getTask).not.toHaveBeenCalled();
  });
  it("surfaces stale uploads whose task ID was lost", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({ paperlessTaskId: null, paperlessUploadStartedAt: new Date(0) }),
    ]);
    await reconcilePaperlessFilings(createTestLogger());
    expect(prisma.documentFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: "ERROR",
          errorMessage:
            "Upload outcome unknown. Check Paperless before retrying.",
        },
      }),
    );
    expect(getTask).not.toHaveBeenCalled();
  });
  it("waits for a recently accepted task to appear", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({ paperlessUploadStartedAt: new Date() }),
    ]);
    getTask.mockResolvedValue({ status: "missing" });
    await reconcilePaperlessFilings(createTestLogger());
    expect(prisma.documentFiling.update).not.toHaveBeenCalled();
  });
  it("requires review when an accepted task disappears", async () => {
    prisma.documentFiling.findMany.mockResolvedValue([
      filing({ paperlessUploadStartedAt: new Date(0) }),
    ]);
    getTask.mockResolvedValue({ status: "missing" });
    expect((await reconcilePaperlessFilings(createTestLogger())).failed).toBe(
      1,
    );
    expect(prisma.documentFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ERROR" }),
      }),
    );
  });
});
