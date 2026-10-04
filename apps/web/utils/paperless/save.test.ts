import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getEmailAccount, createTestLogger } from "@/__tests__/helpers";
import {
  createMockEmailProvider,
  getMockParsedMessage,
} from "@/__tests__/mocks/email-provider.mock";
import { createEmailProvider } from "@/utils/email/provider";
import { processPaperlessAttachment } from "./filing";
import { savePaperlessAttachment } from "./save";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("./filing", () => ({ processPaperlessAttachment: vi.fn() }));

describe("manual Paperless saves", () => {
  const args = {
    emailAccountId: "mailbox",
    provider: "fastmail",
    messageId: "message",
    attachmentId: "second",
    logger: createTestLogger(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUniqueOrThrow.mockResolvedValue({
      ...getEmailAccount(),
      id: "mailbox",
      filingDestination: "paperless",
    } as any);
    const message = getMockParsedMessage({
      attachments: ["first", "second"].map((attachmentId) => ({
        attachmentId,
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        size: 100,
      })),
    });
    const emailProvider = createMockEmailProvider({
      getMessage: vi.fn().mockResolvedValue(message),
    });
    vi.mocked(createEmailProvider).mockResolvedValue(emailProvider);
    vi.mocked(processPaperlessAttachment).mockResolvedValue({
      success: true,
      filing: {
        id: "filing",
        filename: "receipt.pdf",
        folderPath: "Paperless",
        fileId: null,
        status: "PROCESSING",
        wasAsked: false,
        confidence: 1,
        provider: "paperless",
      },
    });
  });
  it("selects the requested attachment ID when filenames collide", async () => {
    await savePaperlessAttachment(args);
    expect(processPaperlessAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({ attachmentId: "second" }),
        manual: true,
      }),
    );
    expect(createEmailProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "mailbox",
        provider: "fastmail",
      }),
    );
  });
  it("rejects stale saves after the mailbox switches back to cloud", async () => {
    prisma.emailAccount.findUniqueOrThrow.mockResolvedValue({
      filingDestination: "cloud",
    } as any);
    await expect(savePaperlessAttachment(args)).rejects.toThrow(
      "Select Paperless",
    );
    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(processPaperlessAttachment).not.toHaveBeenCalled();
  });
  it("does not replace an unknown attachment ID with a matching filename", async () => {
    await expect(
      savePaperlessAttachment({ ...args, attachmentId: "foreign" }),
    ).rejects.toThrow("Attachment not found");
    expect(processPaperlessAttachment).not.toHaveBeenCalled();
  });
});
