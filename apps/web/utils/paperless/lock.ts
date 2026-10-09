import prisma from "@/utils/prisma";

export function lockPaperlessConnection(emailAccountId: string) {
  return prisma.$queryRaw`
    SELECT true AS locked
    FROM (
      SELECT pg_advisory_xact_lock(742932, hashtext(${emailAccountId}))
    ) lock
  `;
}
