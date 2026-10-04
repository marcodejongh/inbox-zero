import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { reconcilePaperlessFilings } from "./reconcile";

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
