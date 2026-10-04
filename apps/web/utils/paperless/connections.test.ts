import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { connectPaperless, setFilingDestination } from "./connections";

const { validate } = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  PaperlessClient: class {
    validateConnection = validate;
  },
}));

describe("Paperless connection isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validate.mockResolvedValue(undefined);
    prisma.driveConnection.findUnique.mockResolvedValue(null);
    prisma.emailAccount.findUniqueOrThrow.mockResolvedValue({
      email: "owner@example.com",
    } as any);
  });
  it("validates permissions before storing credentials and leaves the destination unchanged", async () => {
    validate.mockRejectedValueOnce(new Error("Permission denied"));
    await expect(
      connectPaperless({
        emailAccountId: "mailbox-a",
        baseUrl: "https://paperless.example.com",
        apiToken: "secret",
      }),
    ).rejects.toThrow();
    expect(prisma.driveConnection.upsert).not.toHaveBeenCalled();
    await connectPaperless({
      emailAccountId: "mailbox-a",
      baseUrl: "https://paperless.example.com/",
      apiToken: "secret",
    });
    expect(prisma.driveConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId_provider: {
            emailAccountId: "mailbox-a",
            provider: "paperless",
          },
        },
      }),
    );
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });
  it("refuses to switch mailbox destinations using another mailbox's connection", async () => {
    await expect(
      setFilingDestination("mailbox-b", "paperless"),
    ).rejects.toThrow("Connect Paperless");
    expect(prisma.driveConnection.findUnique).toHaveBeenCalledWith({
      where: {
        emailAccountId_provider: {
          emailAccountId: "mailbox-b",
          provider: "paperless",
        },
      },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });
  it("keeps in-flight tasks tied to the original instance", async () => {
    prisma.driveConnection.findUnique.mockResolvedValue({
      id: "connection",
      baseUrl: "https://old.example.com",
    } as any);
    prisma.documentFiling.count.mockResolvedValue(1);
    await expect(
      connectPaperless({
        emailAccountId: "mailbox-a",
        baseUrl: "https://new.example.com",
        apiToken: "new-token",
      }),
    ).rejects.toThrow("Resolve pending");
    expect(validate).not.toHaveBeenCalled();
    expect(prisma.driveConnection.upsert).not.toHaveBeenCalled();
  });
});
