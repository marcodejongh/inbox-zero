/**
 * SMTP Client for sending emails
 *
 * Uses nodemailer for SMTP operations.
 */

import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { SmtpConfig } from "@/utils/imap/types";

// Connection pool for SMTP transporters
const transporterPool = new Map<string, Transporter>();

/**
 * Get a cache key for the SMTP configuration
 */
function getSmtpCacheKey(config: SmtpConfig): string {
  return `${config.host}:${config.port}:${config.username}`;
}

/**
 * Create or get cached SMTP transporter
 */
export function getSmtpTransporter(config: SmtpConfig): Transporter {
  const cacheKey = getSmtpCacheKey(config);

  // Return cached transporter if available
  const cached = transporterPool.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Create new transporter
  const transporter = createSmtpTransporter(config);
  transporterPool.set(cacheKey, transporter);

  return transporter;
}

/**
 * Create a new SMTP transporter with the given configuration
 */
export function createSmtpTransporter(config: SmtpConfig): Transporter {
  const options: SMTPTransport.Options = {
    host: config.host,
    port: config.port,
    secure: config.security === "ssl" || config.port === 465,
    auth: {
      user: config.username,
      pass: config.password,
    },
    tls: {
      // Allow self-signed certificates for self-hosted servers
      rejectUnauthorized: false,
    },
  };

  // If using STARTTLS (port 587 typically)
  if (config.security === "tls" && config.port !== 465) {
    options.secure = false;
    options.requireTLS = true;
  }

  return nodemailer.createTransport(options);
}

/**
 * Test SMTP connection
 */
export async function testSmtpConnection(
  config: SmtpConfig,
): Promise<{ success: boolean; error?: string }> {
  const transporter = createSmtpTransporter(config);

  try {
    await transporter.verify();
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown connection error";
    return { success: false, error: message };
  } finally {
    transporter.close();
  }
}

/**
 * Email sending options
 */
export interface SendEmailOptions {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    content: string | Buffer;
    contentType?: string;
    encoding?: string;
  }>;
  headers?: Record<string, string>;
}

/**
 * Send email result
 */
export interface SendEmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

/**
 * Send an email using SMTP
 */
export async function sendEmail(
  config: SmtpConfig,
  options: SendEmailOptions,
): Promise<SendEmailResult> {
  const transporter = getSmtpTransporter(config);

  const mailOptions: nodemailer.SendMailOptions = {
    from: options.from,
    to: options.to,
    subject: options.subject,
  };

  // Optional fields
  if (options.cc) mailOptions.cc = options.cc;
  if (options.bcc) mailOptions.bcc = options.bcc;
  if (options.replyTo) mailOptions.replyTo = options.replyTo;
  if (options.text) mailOptions.text = options.text;
  if (options.html) mailOptions.html = options.html;

  // Threading headers
  if (options.inReplyTo) {
    mailOptions.inReplyTo = options.inReplyTo;
  }
  if (options.references) {
    mailOptions.references = options.references;
  }

  // Custom headers
  if (options.headers) {
    mailOptions.headers = options.headers;
  }

  // Attachments
  if (options.attachments && options.attachments.length > 0) {
    mailOptions.attachments = options.attachments.map((att) => ({
      filename: att.filename,
      content: att.content,
      contentType: att.contentType,
      encoding: att.encoding,
    }));
  }

  const result = await transporter.sendMail(mailOptions);

  return {
    messageId: result.messageId,
    accepted: result.accepted as string[],
    rejected: result.rejected as string[],
    response: result.response,
  };
}

/**
 * Send a reply email
 */
export async function sendReply(
  config: SmtpConfig,
  options: {
    from: string;
    to: string;
    cc?: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo: string;
    references?: string;
    attachments?: SendEmailOptions["attachments"];
  },
): Promise<SendEmailResult> {
  // Build references header (should include all previous message IDs in the thread)
  const references = options.references
    ? `${options.references} ${options.inReplyTo}`
    : options.inReplyTo;

  return sendEmail(config, {
    ...options,
    references,
    // Ensure subject has Re: prefix
    subject: options.subject.startsWith("Re:")
      ? options.subject
      : `Re: ${options.subject}`,
  });
}

/**
 * Send a forwarded email
 */
export async function sendForward(
  config: SmtpConfig,
  options: {
    from: string;
    to: string;
    cc?: string;
    originalSubject: string;
    originalFrom: string;
    originalDate: Date;
    originalContent: string;
    additionalContent?: string;
    attachments?: SendEmailOptions["attachments"];
  },
): Promise<SendEmailResult> {
  // Build forward body
  const forwardHeader = [
    "",
    "---------- Forwarded message ---------",
    `From: ${options.originalFrom}`,
    `Date: ${options.originalDate.toLocaleString()}`,
    `Subject: ${options.originalSubject}`,
    "",
    options.originalContent,
  ].join("\n");

  const fullContent = options.additionalContent
    ? `${options.additionalContent}\n${forwardHeader}`
    : forwardHeader;

  return sendEmail(config, {
    from: options.from,
    to: options.to,
    cc: options.cc,
    subject: `Fwd: ${options.originalSubject}`,
    text: fullContent,
    attachments: options.attachments,
  });
}

/**
 * Create a draft email (saves to IMAP Drafts folder)
 * Note: This requires IMAP connection, handled separately
 */
export function buildDraftMessage(options: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers: string[] = [];

  headers.push(`From: ${options.from}`);
  headers.push(`To: ${options.to}`);
  if (options.cc) headers.push(`Cc: ${options.cc}`);
  if (options.bcc) headers.push(`Bcc: ${options.bcc}`);
  headers.push(`Subject: ${options.subject}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push(`Message-ID: <${Date.now()}.draft@inboxzero.local>`);

  if (options.inReplyTo) {
    headers.push(`In-Reply-To: ${options.inReplyTo}`);
  }
  if (options.references) {
    headers.push(`References: ${options.references}`);
  }

  headers.push("MIME-Version: 1.0");

  if (options.html) {
    headers.push('Content-Type: text/html; charset="utf-8"');
    headers.push("");
    headers.push(options.html);
  } else {
    headers.push('Content-Type: text/plain; charset="utf-8"');
    headers.push("");
    headers.push(options.text || "");
  }

  return headers.join("\r\n");
}

/**
 * Close all cached SMTP connections
 */
export function closeAllSmtpConnections(): void {
  for (const transporter of transporterPool.values()) {
    try {
      transporter.close();
    } catch {
      // Ignore errors when closing
    }
  }
  transporterPool.clear();
}

/**
 * Parse email address into name and address parts
 */
export function parseEmailAddress(
  address: string,
): { name: string | null; address: string } {
  // Format: "Name <email@example.com>" or just "email@example.com"
  const match = address.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/);
  if (match) {
    return {
      name: match[1]?.trim() || null,
      address: match[2],
    };
  }

  // Just email address
  return {
    name: null,
    address: address.trim(),
  };
}

/**
 * Format email address with name
 */
export function formatEmailAddress(
  name: string | null | undefined,
  address: string,
): string {
  if (name) {
    // Escape quotes in name
    const escapedName = name.replace(/"/g, '\\"');
    return `"${escapedName}" <${address}>`;
  }
  return address;
}
