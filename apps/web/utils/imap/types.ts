/**
 * IMAP/SMTP Provider Types
 */

export interface ImapConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  security: "ssl" | "tls" | "none";
}

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  security: "ssl" | "tls" | "none";
}

export interface ImapCredentials {
  imap: ImapConfig;
  smtp: SmtpConfig;
}

export interface ImapMessage {
  uid: number;
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: Date;
  inReplyTo?: string;
  references?: string[];
  textPlain?: string;
  textHtml?: string;
  snippet: string;
  flags: string[];
  labels: string[];
  attachments: ImapAttachment[];
  folder: string;
  size: number;
}

export interface ImapAttachment {
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  content?: Buffer;
}

export interface ImapFolder {
  name: string;
  path: string;
  delimiter: string;
  flags: string[];
  specialUse?: string;
  children?: ImapFolder[];
}

export interface ImapCapabilities {
  supportsKeywords: boolean;
  supportsIdle: boolean;
  supportsMove: boolean;
  supportsCondstore: boolean;
  supportsQresync: boolean;
  supportsUtf8: boolean;
  supportedFlags: string[];
  permanentFlags: string[];
}

export interface ImapSearchCriteria {
  since?: Date;
  before?: Date;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  seen?: boolean;
  unseen?: boolean;
  flagged?: boolean;
  keyword?: string;
  uid?: number[];
}

export interface ImapSyncResult {
  newMessages: ImapMessage[];
  modifiedMessages: ImapMessage[];
  deletedUids: number[];
  lastUid: number;
}

/**
 * Common email provider presets for IMAP/SMTP configuration
 */
export interface EmailProviderPreset {
  name: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "ssl" | "tls" | "none";
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "ssl" | "tls" | "none";
}

export const EMAIL_PROVIDER_PRESETS: Record<string, EmailProviderPreset> = {
  fastmail: {
    name: "Fastmail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
  },
  protonmail: {
    name: "ProtonMail Bridge",
    imapHost: "127.0.0.1",
    imapPort: 1143,
    imapSecurity: "tls",
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecurity: "tls",
  },
  yahoo: {
    name: "Yahoo Mail",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
  },
  zoho: {
    name: "Zoho Mail",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
  },
  icloud: {
    name: "iCloud Mail",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "tls",
  },
  outlook: {
    name: "Outlook.com (IMAP)",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecurity: "tls",
  },
  gmail: {
    name: "Gmail (IMAP)",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecurity: "ssl",
  },
  custom: {
    name: "Custom Server",
    imapHost: "",
    imapPort: 993,
    imapSecurity: "ssl",
    smtpHost: "",
    smtpPort: 587,
    smtpSecurity: "tls",
  },
};
