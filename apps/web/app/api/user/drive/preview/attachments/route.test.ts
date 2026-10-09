import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getMockParsedMessage } from "@/__tests__/mocks/email-provider.mock";

vi.mock("@/utils/prisma");
const { emailProvider } = vi.hoisted(() => ({
  emailProvider: { getMessagesWithAttachments: vi.fn() },
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailProviderTestMiddleware(emailProvider);
});
import { GET } from "./route";

function attachment(filename: string, mimeType: string) {
  return {
    attachmentId: filename,
    filename,
    mimeType,
    size: 1024,
    headers: {
      "content-description": "",
      "content-id": "",
      "content-transfer-encoding": "base64",
      "content-type": mimeType,
    },
  };
}

describe("attachment preview support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "email-account-1",
      filingPrompt: "Save invoices",
      filingDestination: "paperless",
      filingFolders: [],
      driveConnections: [{ id: "connection-1", provider: "paperless" }],
    } as any);
  });
  async function preview(attachments: ReturnType<typeof attachment>[]) {
    emailProvider.getMessagesWithAttachments.mockResolvedValue({
      messages: [getMockParsedMessage({ attachments })],
    });
    return (
      await GET(
        new NextRequest(
          "http://localhost:3000/api/user/drive/preview/attachments",
        ),
        {} as never,
      )
    ).json();
  }
  it("skips an unsupported ZIP before a supported PDF", async () => {
    const body = await preview([
      attachment("archive.zip", "application/zip"),
      attachment("invoice.pdf", "application/pdf"),
    ]);
    expect(
      body.attachments.map((item: { filename: string }) => item.filename),
    ).toEqual(["invoice.pdf"]);
  });
  it("filters unsupported files before applying the three-file limit", async () => {
    const body = await preview([
      ...[1, 2, 3, 4].map((id) =>
        attachment(`archive-${id}.zip`, "application/zip"),
      ),
      ...[1, 2, 3, 4].map((id) =>
        attachment(`invoice-${id}.pdf`, "application/pdf"),
      ),
    ]);
    expect(
      body.attachments.map((item: { filename: string }) => item.filename),
    ).toEqual(["invoice-1.pdf", "invoice-2.pdf", "invoice-3.pdf"]);
    expect(body.noAttachmentsFound).toBe(false);
  });
  it("keeps ZIP files available for cloud-drive previews", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "email-account-1",
      filingPrompt: "Save attachments",
      filingDestination: "cloud",
      filingFolders: [{ id: "folder-1" }],
      driveConnections: [{ id: "connection-1", provider: "google" }],
    } as any);
    const body = await preview([
      attachment("archive.zip", "application/zip"),
      attachment("invoice.pdf", "application/pdf"),
    ]);
    expect(body.attachments).toHaveLength(2);
  });
  it("reports an empty Paperless preview when every file is unsupported", async () => {
    expect(
      await preview([attachment("archive.zip", "application/zip")]),
    ).toEqual({ attachments: [], noAttachmentsFound: true });
  });
});
