import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { normalizePaperlessUrl, PaperlessClient } from "./client";
import { lockPaperlessConnection } from "./lock";
import { isDuplicateError } from "@/utils/prisma-helpers";
import type { Prisma } from "@/generated/prisma/client";

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
  const unresolvedFilings = {
    OR: [
      { status: "PROCESSING" },
      { status: "PENDING" },
      { status: "ERROR", paperlessUploadStartedAt: { not: null } },
    ],
  } satisfies Prisma.DocumentFilingWhereInput;
  const existing = await prisma.driveConnection.findUnique({
    where: {
      emailAccountId_provider: { emailAccountId, provider: "paperless" },
    },
  });
  if (existing && existing.baseUrl !== url) {
    const pending = await prisma.documentFiling.count({
      where: {
        driveConnectionId: existing.id,
        ...unresolvedFilings,
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
  try {
    await prisma.$transaction([
      lockPaperlessConnection(emailAccountId),
      prisma.driveConnection.upsert({
        where: {
          emailAccountId_provider: { emailAccountId, provider: "paperless" },
          OR: [
            { baseUrl: url },
            { documentFilings: { none: unresolvedFilings } },
          ],
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
      }),
    ]);
  } catch (error) {
    if (isDuplicateError(error, ["emailAccountId", "provider"]))
      throw new SafeError(
        "Resolve pending Paperless filings before changing the instance URL.",
      );
    throw error;
  }
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
