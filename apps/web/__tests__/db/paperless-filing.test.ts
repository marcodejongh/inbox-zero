import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/prisma";
import {
  claimAttachmentFiling,
  findAttachmentFiling,
} from "@/utils/drive/filing-claim";
import { createTestLogger } from "@/__tests__/helpers";
import { createPaperlessEmulator } from "@/__tests__/emulators/paperless";
import { processPaperlessAttachment } from "@/utils/paperless/filing";
import { reconcilePaperlessFilings } from "@/utils/paperless/reconcile";
import { connectPaperless } from "@/utils/paperless/connections";
import { PaperlessClient } from "@/utils/paperless/client";
import {
  createMockEmailProvider,
  getMockParsedMessage,
} from "@/__tests__/mocks/email-provider.mock";

vi.mock("@/utils/paperless/analyze");
vi.mock("@/utils/drive/document-extraction");

describe.skipIf(!process.env.RUN_DB_TESTS)(
  "Paperless filing persistence",
  () => {
    const email = `paperless-${randomUUID()}@example.com`;
    let emailAccountId: string;
    let connectionId: string;
    beforeEach(async () => {
      await prisma.user.deleteMany({ where: { email } });
      const user = await prisma.user.create({ data: { email } });
      const account = await prisma.account.create({
        data: {
          userId: user.id,
          provider: "google",
          type: "oauth",
          providerAccountId: email,
        },
      });
      const mailbox = await prisma.emailAccount.create({
        data: { email, userId: user.id, accountId: account.id },
      });
      emailAccountId = mailbox.id;
      const connection = await prisma.driveConnection.create({
        data: {
          emailAccountId,
          provider: "paperless",
          email,
          baseUrl: "https://paperless.example.com",
          accessToken: "private-api-token",
        },
      });
      connectionId = connection.id;
    });
    afterAll(async () => {
      await prisma.user.deleteMany({ where: { email } });
    });

    it("defaults mailboxes to cloud and encrypts the Paperless token at rest", async () => {
      expect(
        (
          await prisma.emailAccount.findUniqueOrThrow({
            where: { id: emailAccountId },
          })
        ).filingDestination,
      ).toBe("cloud");
      const raw = await prisma.$queryRaw<
        { accessToken: string }[]
      >`SELECT "accessToken" FROM "DriveConnection" WHERE id = ${connectionId}`;
      expect(raw[0].accessToken).not.toBe("private-api-token");
      expect(
        (
          await prisma.driveConnection.findUniqueOrThrow({
            where: { id: connectionId },
          })
        ).accessToken,
      ).toBe("private-api-token");
      await expect(
        prisma.driveConnection.create({
          data: { emailAccountId, provider: "paperless", email },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
    it("lets one worker claim an attachment when concurrent requests race", async () => {
      const lookup = {
        emailAccountId,
        messageId: "message",
        attachmentId: "attachment",
      };
      const args = {
        existingFiling: null,
        attachmentLookup: lookup,
        attachment: {
          attachmentId: "attachment",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          headers: {
            "content-description": "",
            "content-id": "",
            "content-transfer-encoding": "base64",
            "content-type": "application/pdf",
          },
          size: 100,
        },
        driveConnectionId: connectionId,
        logger: createTestLogger(),
      };
      const claims = await Promise.all([
        claimAttachmentFiling(args),
        claimAttachmentFiling(args),
      ]);
      expect(claims.filter((claim) => claim.type === "retry")).toHaveLength(1);
      expect(await prisma.documentFiling.count({ where: lookup })).toBe(1);
      expect(
        await findAttachmentFiling({
          ...lookup,
          emailAccountId: "another-mailbox",
        }),
      ).toBeNull();
    });
    it("never reclaims an accepted upload, even after its claim gets stale", async () => {
      const lookup = {
        emailAccountId,
        messageId: "message",
        attachmentId: "attachment",
      };
      const row = await prisma.documentFiling.create({
        data: {
          ...lookup,
          driveConnectionId: connectionId,
          filename: "invoice.pdf",
          folderPath: "Paperless",
          status: "PROCESSING",
          paperlessTaskId: randomUUID(),
          paperlessUploadStartedAt: new Date(),
          updatedAt: new Date(0),
        },
      });
      const existingFiling = await findAttachmentFiling(lookup);
      const result = await claimAttachmentFiling({
        existingFiling,
        attachmentLookup: lookup,
        attachment: {
          attachmentId: "attachment",
          filename: row.filename,
          mimeType: "application/pdf",
          headers: {
            "content-description": "",
            "content-id": "",
            "content-transfer-encoding": "base64",
            "content-type": "application/pdf",
          },
          size: 100,
        },
        driveConnectionId: connectionId,
        logger: createTestLogger(),
      });
      expect(result.type).toBe("return");
      expect(
        (
          await prisma.documentFiling.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).paperlessTaskId,
      ).toBe(row.paperlessTaskId);
      await prisma.driveConnection.update({
        where: { id: connectionId },
        data: { isConnected: false, accessToken: null },
      });
      expect(await prisma.documentFiling.count({ where: lookup })).toBe(1);
    });
    it("changes an idle connection URL while retaining encrypted credentials", async () => {
      const emulator = await createPaperlessEmulator();
      try {
        await connectPaperless({
          emailAccountId,
          baseUrl: emulator.baseUrl,
          apiToken: emulator.token,
        });
        const connection = await prisma.driveConnection.findUniqueOrThrow({
          where: { id: connectionId },
        });
        expect(connection.baseUrl).toBe(emulator.baseUrl);
        expect(connection.accessToken).toBe(emulator.token);
      } finally {
        await emulator.close();
      }
    });
    it("blocks a URL change when an accepted upload arrives during connection validation", async () => {
      const validate = vi
        .spyOn(PaperlessClient.prototype, "validateConnection")
        .mockImplementationOnce(async () => {
          await prisma.documentFiling.create({
            data: {
              emailAccountId,
              driveConnectionId: connectionId,
              messageId: "racing-message",
              attachmentId: "attachment",
              filename: "receipt.pdf",
              folderPath: "Paperless",
              status: "PROCESSING",
              paperlessTaskId: "accepted-task",
              paperlessUploadStartedAt: new Date(),
            },
          });
        });
      try {
        await expect(
          connectPaperless({
            emailAccountId,
            baseUrl: "https://new.example.com",
            apiToken: "new-token",
          }),
        ).rejects.toThrow("Resolve pending");
        const connection = await prisma.driveConnection.findUniqueOrThrow({
          where: { id: connectionId },
        });
        expect(connection.baseUrl).toBe("https://paperless.example.com");
        expect(
          (
            await prisma.documentFiling.findFirstOrThrow({
              where: { emailAccountId },
            })
          ).paperlessTaskId,
        ).toBe("accepted-task");
      } finally {
        validate.mockRestore();
      }
    });
    it("does not upload using a cached connection after its URL changes", async () => {
      const emulator = await createPaperlessEmulator();
      const staleConnection = await prisma.driveConnection.findUniqueOrThrow({
        where: { id: connectionId },
      });
      try {
        await connectPaperless({
          emailAccountId,
          baseUrl: emulator.baseUrl,
          apiToken: emulator.token,
        });
        const lookup = vi
          .spyOn(prisma.driveConnection, "findUnique")
          .mockResolvedValueOnce(staleConnection);
        try {
          const emailAccount = await prisma.emailAccount.findUniqueOrThrow({
            where: { id: emailAccountId },
            include: { user: true, account: { select: { provider: true } } },
          });
          const emailProvider = createMockEmailProvider();
          vi.mocked(emailProvider.getAttachment).mockResolvedValue({
            data: Buffer.from("original bytes").toString("base64"),
            size: 14,
          });
          const result = await processPaperlessAttachment({
            emailAccount,
            emailProvider,
            logger: createTestLogger(),
            message: getMockParsedMessage(),
            manual: true,
            attachment: {
              attachmentId: "attachment",
              filename: "receipt.pdf",
              mimeType: "application/pdf",
              size: 14,
              headers: {
                "content-description": "",
                "content-id": "",
                "content-transfer-encoding": "base64",
                "content-type": "application/pdf",
              },
            },
          });
          expect(result.error).toContain("connection changed");
          expect(emulator.uploads).toHaveLength(0);
          const filing = await prisma.documentFiling.findFirstOrThrow({
            where: { emailAccountId },
          });
          expect(filing.status).toBe("ERROR");
          expect(filing.paperlessUploadStartedAt).toBeNull();
        } finally {
          lookup.mockRestore();
        }
      } finally {
        await emulator.close();
      }
    });
    it("persists one upload across concurrent manual saves and task reconciliation", async () => {
      const emulator = await createPaperlessEmulator();
      try {
        await prisma.driveConnection.update({
          where: { id: connectionId },
          data: { baseUrl: emulator.baseUrl, accessToken: emulator.token },
        });
        const emailAccount = await prisma.emailAccount.findUniqueOrThrow({
          where: { id: emailAccountId },
          include: { user: true, account: { select: { provider: true } } },
        });
        const emailProvider = createMockEmailProvider();
        vi.mocked(emailProvider.getAttachment).mockResolvedValue({
          data: Buffer.from("document bytes").toString("base64"),
          size: 14,
        });
        const args = {
          emailAccount,
          emailProvider,
          logger: createTestLogger(),
          message: getMockParsedMessage(),
          attachment: {
            attachmentId: "attachment",
            filename: "receipt.pdf",
            mimeType: "application/pdf",
            headers: {
              "content-description": "",
              "content-id": "",
              "content-transfer-encoding": "base64",
              "content-type": "application/pdf",
            },
            size: 14,
          },
          manual: true,
          sendNotification: false,
        };
        await Promise.all([
          processPaperlessAttachment(args),
          processPaperlessAttachment(args),
        ]);
        expect(emulator.uploads).toHaveLength(1);
        const filing = await prisma.documentFiling.findFirstOrThrow({
          where: { emailAccountId },
        });
        expect(filing.status).toBe("PROCESSING");
        expect(filing.paperlessTaskId).toBe(emulator.uploads[0].taskId);
        expect(filing.paperlessUploadStartedAt).not.toBeNull();
        await processPaperlessAttachment(args);
        expect(emulator.uploads).toHaveLength(1);
        emulator.complete(emulator.uploads[0].taskId, 42);
        await prisma.documentFiling.update({
          where: { id: filing.id },
          data: { updatedAt: new Date(0) },
        });
        await reconcilePaperlessFilings(createTestLogger());
        const saved = await prisma.documentFiling.findUniqueOrThrow({
          where: { id: filing.id },
        });
        expect(saved.status).toBe("FILED");
        expect(saved.fileId).toBe("42");
        expect(saved.webUrl).toBe(`${emulator.baseUrl}/documents/42/details`);
        expect(emulator.uploads).toHaveLength(1);
      } finally {
        await emulator.close();
      }
    });
  },
);
