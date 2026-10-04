import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { normalizePaperlessUrl, PaperlessClient } from "./client";

export async function connectPaperless({
  emailAccountId,
  baseUrl,
  apiToken,
}: {
  emailAccountId: string;
  baseUrl: string;
  apiToken: string;
}) {
  const url = normalizePaperlessUrl(baseUrl);
  const existing = await prisma.driveConnection.findUnique({
    where: {
      emailAccountId_provider: { emailAccountId, provider: "paperless" },
    },
  });
  if (existing && existing.baseUrl !== url) {
    const pending = await prisma.documentFiling.count({
      where: {
        driveConnectionId: existing.id,
        OR: [
          { status: "PROCESSING" },
          { status: "PENDING" },
          { status: "ERROR", paperlessUploadStartedAt: { not: null } },
        ],
      },
    });
    if (pending)
      throw new SafeError(
        "Resolve pending Paperless filings before changing the instance URL.",
      );
  }
  const client = new PaperlessClient(url, apiToken);
  await client.validateConnection();
  const emailAccount = await prisma.emailAccount.findUniqueOrThrow({
    where: { id: emailAccountId },
    select: { email: true },
  });
  await prisma.driveConnection.upsert({
    where: {
      emailAccountId_provider: { emailAccountId, provider: "paperless" },
    },
    create: {
      emailAccountId,
      email: emailAccount.email,
      provider: "paperless",
      baseUrl: url,
      accessToken: apiToken,
    },
    update: {
      baseUrl: url,
      accessToken: apiToken,
      refreshToken: null,
      expiresAt: null,
      isConnected: true,
    },
  });
}

export async function setFilingDestination(
  emailAccountId: string,
  destination: "cloud" | "paperless",
) {
  if (destination === "paperless") {
    const connection = await prisma.driveConnection.findUnique({
      where: {
        emailAccountId_provider: { emailAccountId, provider: "paperless" },
      },
    });
    if (
      !connection?.isConnected ||
      !connection.accessToken ||
      !connection.baseUrl
    )
      throw new SafeError("Connect Paperless before selecting it.");
  }
  await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: { filingDestination: destination },
  });
}
