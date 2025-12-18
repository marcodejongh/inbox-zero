/**
 * Create IMAP Account
 *
 * Creates a new IMAP/SMTP email account.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/utils/auth";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { testImapConnection } from "@/utils/imap/client";
import { testSmtpConnection } from "@/utils/smtp/client";
import { getServerInfo, capabilitiesToJson } from "@/utils/imap/capabilities";
import { connectImap, disconnectImap } from "@/utils/imap/client";

const createAccountSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  imapHost: z.string().min(1),
  imapPort: z.number().int().positive(),
  imapUsername: z.string().min(1),
  imapPassword: z.string().min(1),
  imapSecurity: z.enum(["ssl", "tls", "none"]),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive(),
  smtpUsername: z.string().min(1),
  smtpPassword: z.string().min(1),
  smtpSecurity: z.enum(["ssl", "tls", "none"]),
});

export const POST = withError("imap/create-account", async (request) => {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const body = await request.json();
  const parsed = createAccountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.errors },
      { status: 400 },
    );
  }

  const { data } = parsed;

  // Check if email already exists
  const existingAccount = await prisma.emailAccount.findUnique({
    where: { email: data.email.toLowerCase() },
  });

  if (existingAccount) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 400 },
    );
  }

  // Test connections before saving
  const imapConfig = {
    host: data.imapHost,
    port: data.imapPort,
    username: data.imapUsername,
    password: data.imapPassword,
    security: data.imapSecurity,
  };

  const smtpConfig = {
    host: data.smtpHost,
    port: data.smtpPort,
    username: data.smtpUsername,
    password: data.smtpPassword,
    security: data.smtpSecurity,
  };

  // Test IMAP
  const imapResult = await testImapConnection(imapConfig);
  if (!imapResult.success) {
    return NextResponse.json(
      { error: `IMAP connection failed: ${imapResult.error}` },
      { status: 400 },
    );
  }

  // Test SMTP
  const smtpResult = await testSmtpConnection(smtpConfig);
  if (!smtpResult.success) {
    return NextResponse.json(
      { error: `SMTP connection failed: ${smtpResult.error}` },
      { status: 400 },
    );
  }

  // Get server capabilities for caching
  let capabilities = {};
  try {
    const connection = await connectImap(imapConfig);
    const serverInfo = await getServerInfo(connection);
    capabilities = capabilitiesToJson(serverInfo.capabilities);
    await disconnectImap(imapConfig);
  } catch {
    // Non-fatal: we'll detect capabilities later if needed
  }

  // Create the account and email account
  const account = await prisma.account.create({
    data: {
      userId,
      provider: "imap",
      type: "imap",
      providerAccountId: data.email.toLowerCase(), // Use email as provider account ID
      imapHost: data.imapHost,
      imapPort: data.imapPort,
      imapUsername: data.imapUsername,
      imapPassword: data.imapPassword,
      imapSecurity: data.imapSecurity,
      smtpHost: data.smtpHost,
      smtpPort: data.smtpPort,
      smtpUsername: data.smtpUsername,
      smtpPassword: data.smtpPassword,
      smtpSecurity: data.smtpSecurity,
    },
  });

  const emailAccount = await prisma.emailAccount.create({
    data: {
      userId,
      accountId: account.id,
      email: data.email.toLowerCase(),
      name: data.name || data.email.split("@")[0],
      imapCapabilities: capabilities,
      lastImapSync: null, // Will be set on first poll
    },
  });

  return NextResponse.json({
    success: true,
    emailAccountId: emailAccount.id,
    email: emailAccount.email,
  });
});
