import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getEmailAccount, createTestLogger } from "@/__tests__/helpers";
import {
  createMockEmailProvider,
  getMockParsedMessage,
} from "@/__tests__/mocks/email-provider.mock";
import { processPaperlessAttachment } from "./filing";
import { analyzePaperlessAttachment } from "./analyze";
import { PaperlessHttpError } from "./client";
import { extractTextFromDocument } from "@/utils/drive/document-extraction";
import { sendAskNotification } from "@/utils/drive/filing-notifications";

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("./analyze");
vi.mock("./client", async (original) => {
  const actual = await original<typeof import("./client")>();
  return {
    ...actual,
    PaperlessClient: class {
      upload = upload;
    },
  };
});
vi.mock("@/utils/drive/document-extraction", () => ({
  extractTextFromDocument: vi.fn(),
}));
vi.mock("@/utils/drive/filing-notifications", () => ({
  sendAskNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/drive/filing-messaging-notifications", () => ({
  sendFilingMessagingNotifications: vi.fn().mockResolvedValue(undefined),
}));

function options() {
  const emailAccount = {
    ...getEmailAccount(),
    filingEnabled: true,
    filingPrompt: "Save invoices",
    filingConfirmationSendEmail: true,
  };
  const message = getMockParsedMessage();
  const attachment = {
    attachmentId: "attachment-1",
    filename: "invoice.pdf",
    mimeType: "application/pdf",
    headers: {
      "content-description": "",
      "content-id": "",
      "content-transfer-encoding": "base64",
      "content-type": "application/pdf",
    },
    size: 10,
  };
  const emailProvider = createMockEmailProvider();
  vi.mocked(emailProvider.getAttachment).mockResolvedValue({
    data: Buffer.from("original bytes").toString("base64"),
    size: 14,
  });
  return {
    emailAccount,
    message,
    attachment,
    emailProvider,
    logger: createTestLogger(),
  };
}

describe("Paperless filing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (operations) => Promise.all(operations as any) as any,
    );
    prisma.driveConnection.findUnique.mockResolvedValue({
      id: "paperless-1",
      emailAccountId: "mailbox-a",
      provider: "paperless",
      isConnected: true,
      baseUrl: "https://paperless.example.com",
      accessToken: "token",
    } as any);
    prisma.documentFiling.findFirst.mockResolvedValue(null);
    prisma.documentFiling.create.mockResolvedValue({ id: "filing-1" } as any);
    prisma.documentFiling.updateMany.mockResolvedValue({ count: 1 });
    prisma.documentFiling.update.mockResolvedValue({ id: "filing-1" } as any);
    vi.mocked(extractTextFromDocument).mockResolvedValue({
      text: "invoice",
    } as any);
    vi.mocked(analyzePaperlessAttachment).mockResolvedValue({
      action: "save",
      confidence: 0.95,
      reasoning: "Invoice",
    });
    upload.mockResolvedValue("12345678-1234-4234-8234-123456789abc");
  });
  it("submits a qualifying attachment and reports processing, not filed", async () => {
    const args = options();
    const result = await processPaperlessAttachment(args);
    expect(result.filing?.status).toBe("PROCESSING");
    expect(upload).toHaveBeenCalledWith({
      content: Buffer.from("original bytes"),
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });
    expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "filing-1",
          status: "PROCESSING",
          paperlessTaskId: null,
          paperlessUploadStartedAt: null,
          driveConnection: {
            baseUrl: "https://paperless.example.com",
            isConnected: true,
          },
        },
        data: { paperlessUploadStartedAt: expect.any(Date) },
      }),
    );
    expect(
      prisma.documentFiling.updateMany.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(prisma.documentFiling.update.mock.invocationCallOrder[0]);
  });
  it("manual saves bypass filing preferences and paused automation", async () => {
    const args = options();
    args.emailAccount.filingEnabled = false;
    args.emailAccount.filingPrompt = "";
    const result = await processPaperlessAttachment({ ...args, manual: true });
    expect(result.success).toBe(true);
    expect(analyzePaperlessAttachment).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
  });
  it.each([
    "PREVIEW",
    "PENDING",
    "REJECTED",
    "ERROR",
  ])("allows a manual Paperless save after a cloud %s without an uploaded file", async (status) => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status,
      updatedAt: new Date(),
      fileId: null,
      driveConnection: { provider: "google" },
    } as any);
    const result = await processPaperlessAttachment({
      ...options(),
      manual: true,
    });
    expect(result.filing?.status).toBe("PROCESSING");
    expect(upload).toHaveBeenCalledOnce();
  });
  it.each([
    "FILED",
    "PROCESSING",
  ])("refuses a manual Paperless save while a cloud filing is %s", async (status) => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status,
      driveConnection: { provider: "google" },
    } as any);
    expect(
      (await processPaperlessAttachment({ ...options(), manual: true }))
        .success,
    ).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });
  it.each([
    true,
    false,
  ])("preserves an existing cloud file in ERROR when manual=%s", async (manual) => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status: "ERROR",
      fileId: "cloud-file",
      driveConnection: { provider: "google" },
    } as any);
    expect(
      (await processPaperlessAttachment({ ...options(), manual })).success,
    ).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(prisma.documentFiling.updateMany).not.toHaveBeenCalled();
  });
  it("preserves completion notifications when retrying an automatic filing manually", async () => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status: "ERROR",
      updatedAt: new Date(),
      wasAsked: false,
      paperlessNotifyOnCompletion: true,
      driveConnection: { provider: "paperless" },
    } as any);
    await processPaperlessAttachment({ ...options(), manual: true });
    expect(upload).toHaveBeenCalledOnce();
    expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paperlessNotifyOnCompletion: true }),
      }),
    );
  });
  it("keeps a confirmation pending when its email cannot be delivered", async () => {
    vi.mocked(analyzePaperlessAttachment).mockResolvedValue({
      action: "save",
      confidence: 0.4,
      reasoning: "Needs review",
    });
    vi.mocked(sendAskNotification).mockRejectedValueOnce(
      new Error("Mail unavailable"),
    );
    const result = await processPaperlessAttachment(options());
    expect(result.filing?.status).toBe("PENDING");
    expect(upload).not.toHaveBeenCalled();
    expect(
      prisma.documentFiling.update.mock.calls.some(
        ([arg]) => arg.data.status === "ERROR",
      ),
    ).toBe(false);
  });
  it("does not upload low-confidence selections before approval", async () => {
    vi.mocked(analyzePaperlessAttachment).mockResolvedValue({
      action: "save",
      confidence: 0.5,
      reasoning: "Uncertain",
    });
    const result = await processPaperlessAttachment(options());
    expect(result.filing?.status).toBe("PENDING");
    expect(upload).not.toHaveBeenCalled();
  });
  it("records skipped attachments without uploading", async () => {
    vi.mocked(analyzePaperlessAttachment).mockResolvedValue({
      action: "skip",
      confidence: 0.95,
      reasoning: "Marketing",
    });
    expect((await processPaperlessAttachment(options())).skipped).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });
  it("does not upload an unsupported archive", async () => {
    const args = options();
    args.attachment.mimeType = "application/zip";
    args.attachment.filename = "archive.zip";
    expect((await processPaperlessAttachment(args)).skipped).toBe(true);
    expect(args.emailProvider.getAttachment).not.toHaveBeenCalled();
  });
  it("does not repost accepted tasks on repeated webhook delivery", async () => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status: "PROCESSING",
      updatedAt: new Date(0),
      paperlessTaskId: "task",
      driveConnection: { provider: "paperless" },
    } as any);
    expect((await processPaperlessAttachment(options())).success).toBe(true);
    expect(upload).not.toHaveBeenCalled();
  });
  it("does not retry an upload with an unknown outcome", async () => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status: "ERROR",
      paperlessUploadStartedAt: new Date(),
      errorMessage: "Unknown outcome",
      driveConnection: { provider: "paperless" },
    } as any);
    expect((await processPaperlessAttachment(options())).error).toBe(
      "Unknown outcome",
    );
    expect(upload).not.toHaveBeenCalled();
  });
  it("does not upload when another approval won the atomic claim", async () => {
    prisma.documentFiling.findFirst.mockResolvedValue({
      id: "existing",
      status: "PENDING",
      updatedAt: new Date(),
      driveConnection: { provider: "paperless" },
    } as any);
    prisma.documentFiling.updateMany.mockResolvedValue({ count: 0 });
    await processPaperlessAttachment({ ...options(), manual: true });
    expect(upload).not.toHaveBeenCalled();
  });
  it("allows safe retry after a definitive validation rejection", async () => {
    upload.mockRejectedValue(new PaperlessHttpError(400));
    await processPaperlessAttachment(options());
    expect(prisma.documentFiling.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paperlessUploadStartedAt: null } }),
    );
  });
  it("marks a revoked-token connection disconnected", async () => {
    upload.mockRejectedValue(new PaperlessHttpError(401));
    await processPaperlessAttachment(options());
    expect(prisma.driveConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isConnected: false } }),
    );
  });
});
