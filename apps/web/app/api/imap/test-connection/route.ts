/**
 * Test IMAP/SMTP Connection
 *
 * Tests the provided IMAP and SMTP credentials before saving.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/utils/auth";
import { withError } from "@/utils/middleware";
import { testImapConnection } from "@/utils/imap/client";
import { testSmtpConnection } from "@/utils/smtp/client";

const testConnectionSchema = z.object({
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

export const POST = withError("imap/test-connection", async (request) => {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = testConnectionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.errors },
      { status: 400 },
    );
  }

  const { data } = parsed;

  const results = {
    imap: { success: false, error: undefined as string | undefined },
    smtp: { success: false, error: undefined as string | undefined },
  };

  // Test IMAP connection
  try {
    const imapResult = await testImapConnection({
      host: data.imapHost,
      port: data.imapPort,
      username: data.imapUsername,
      password: data.imapPassword,
      security: data.imapSecurity,
    });
    results.imap = imapResult;
  } catch (error) {
    results.imap = {
      success: false,
      error: error instanceof Error ? error.message : "IMAP connection failed",
    };
  }

  // Test SMTP connection
  try {
    const smtpResult = await testSmtpConnection({
      host: data.smtpHost,
      port: data.smtpPort,
      username: data.smtpUsername,
      password: data.smtpPassword,
      security: data.smtpSecurity,
    });
    results.smtp = smtpResult;
  } catch (error) {
    results.smtp = {
      success: false,
      error: error instanceof Error ? error.message : "SMTP connection failed",
    };
  }

  const overallSuccess = results.imap.success && results.smtp.success;

  return NextResponse.json({
    success: overallSuccess,
    results,
  });
});
