/**
 * IMAP Message Fetching and Parsing
 *
 * Handles fetching messages from IMAP and parsing them into a consistent format.
 */

import type { ImapSimple, Message } from "imap-simple";
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import type { ImapMessage, ImapAttachment, ImapSearchCriteria } from "./types";
import { generateThreadId } from "./thread";

/**
 * Extract email address string from mailparser AddressObject
 */
function formatAddress(address: AddressObject | AddressObject[] | undefined): string {
  if (!address) return "";

  const addresses = Array.isArray(address) ? address : [address];
  return addresses
    .flatMap((a) => a.value || [])
    .map((v) => (v.name ? `${v.name} <${v.address}>` : v.address || ""))
    .filter(Boolean)
    .join(", ");
}

/**
 * Extract plain email addresses (without names) from AddressObject
 */
function extractEmailAddresses(address: AddressObject | AddressObject[] | undefined): string[] {
  if (!address) return [];

  const addresses = Array.isArray(address) ? address : [address];
  return addresses
    .flatMap((a) => a.value || [])
    .map((v) => v.address || "")
    .filter(Boolean);
}

/**
 * Generate a snippet from email content
 */
function generateSnippet(text: string | undefined, maxLength: number = 200): string {
  if (!text) return "";

  // Remove excessive whitespace and newlines
  const cleaned = text
    .replace(/\s+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim();

  if (cleaned.length <= maxLength) return cleaned;

  return cleaned.substring(0, maxLength).trim() + "...";
}

/**
 * Parse a raw IMAP message into our internal format
 */
export async function parseImapMessage(
  message: Message,
  folder: string = "INBOX",
): Promise<ImapMessage> {
  const attributes = message.attributes;
  const rawBody = message.parts.find((p) => p.which === "")?.body;

  if (!rawBody) {
    throw new Error("Message body not found");
  }

  // Parse the raw email using mailparser
  const parsed = await simpleParser(rawBody);

  // Extract message ID or generate one
  const messageId = parsed.messageId || `<${attributes.uid}@local>`;

  // Extract references for threading
  const references = parsed.references
    ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
    : [];

  // Generate thread ID based on message headers
  const threadId = generateThreadId(
    messageId,
    parsed.inReplyTo || undefined,
    references,
    parsed.subject || "",
  );

  // Parse attachments
  const attachments: ImapAttachment[] = (parsed.attachments || []).map((att) => ({
    filename: att.filename || "attachment",
    mimeType: att.contentType,
    size: att.size,
    contentId: att.contentId,
    content: att.content,
  }));

  // Extract flags and convert to labels
  const flags = attributes.flags || [];
  const labels = flagsToLabels(flags);

  return {
    uid: attributes.uid,
    messageId,
    threadId,
    subject: parsed.subject || "(No Subject)",
    from: formatAddress(parsed.from),
    to: formatAddress(parsed.to),
    cc: formatAddress(parsed.cc),
    bcc: formatAddress(parsed.bcc),
    date: parsed.date || new Date(),
    inReplyTo: parsed.inReplyTo || undefined,
    references,
    textPlain: parsed.text || undefined,
    textHtml: parsed.html || undefined,
    snippet: generateSnippet(parsed.text || parsed.html?.replace(/<[^>]*>/g, "")),
    flags,
    labels,
    attachments,
    folder,
    size: attributes.size || 0,
  };
}

/**
 * Convert IMAP flags to internal label format
 */
function flagsToLabels(flags: string[]): string[] {
  const labels: string[] = [];

  for (const flag of flags) {
    switch (flag.toLowerCase()) {
      case "\\seen":
        // No label for read messages
        break;
      case "\\flagged":
        labels.push("STARRED");
        break;
      case "\\answered":
        labels.push("REPLIED");
        break;
      case "\\draft":
        labels.push("DRAFT");
        break;
      case "\\deleted":
        labels.push("TRASH");
        break;
      default:
        // Custom flags/keywords become labels
        if (!flag.startsWith("\\")) {
          labels.push(flag.toUpperCase());
        }
    }
  }

  return labels;
}

/**
 * Fetch messages from IMAP server
 */
export async function fetchMessages(
  connection: ImapSimple,
  criteria: ImapSearchCriteria = {},
  options: {
    folder?: string;
    limit?: number;
    offset?: number;
    fetchBody?: boolean;
  } = {},
): Promise<ImapMessage[]> {
  const {
    folder = "INBOX",
    limit = 50,
    offset = 0,
    fetchBody = true,
  } = options;

  // Open the mailbox
  await connection.openBox(folder);

  // Build IMAP search criteria
  const searchCriteria = buildSearchCriteria(criteria);

  // Define what to fetch
  const fetchOptions: any = {
    bodies: fetchBody ? ["HEADER", ""] : ["HEADER"],
    struct: true,
  };

  // Search for messages
  const results = await connection.search(searchCriteria, fetchOptions);

  // Sort by UID descending (newest first)
  results.sort((a, b) => b.attributes.uid - a.attributes.uid);

  // Apply pagination
  const paginated = results.slice(offset, offset + limit);

  // Parse each message
  const messages: ImapMessage[] = [];
  for (const message of paginated) {
    try {
      const parsed = await parseImapMessage(message, folder);
      messages.push(parsed);
    } catch (error) {
      console.error(`Failed to parse message UID ${message.attributes.uid}:`, error);
    }
  }

  return messages;
}

/**
 * Fetch a single message by UID
 */
export async function fetchMessageByUid(
  connection: ImapSimple,
  uid: number,
  folder: string = "INBOX",
): Promise<ImapMessage | null> {
  await connection.openBox(folder);

  const results = await connection.search([["UID", uid.toString()]], {
    bodies: ["HEADER", ""],
    struct: true,
  });

  if (results.length === 0) return null;

  return parseImapMessage(results[0], folder);
}

/**
 * Fetch messages by their Message-IDs
 */
export async function fetchMessagesByMessageIds(
  connection: ImapSimple,
  messageIds: string[],
  folder: string = "INBOX",
): Promise<ImapMessage[]> {
  await connection.openBox(folder);

  const messages: ImapMessage[] = [];

  for (const msgId of messageIds) {
    // Search by header Message-ID
    const results = await connection.search(
      [["HEADER", "MESSAGE-ID", msgId]],
      {
        bodies: ["HEADER", ""],
        struct: true,
      },
    );

    for (const result of results) {
      try {
        const parsed = await parseImapMessage(result, folder);
        messages.push(parsed);
      } catch (error) {
        console.error(`Failed to parse message with ID ${msgId}:`, error);
      }
    }
  }

  return messages;
}

/**
 * Build IMAP search criteria from our search interface
 */
function buildSearchCriteria(criteria: ImapSearchCriteria): any[] {
  const searchCriteria: any[] = ["ALL"];

  if (criteria.since) {
    searchCriteria.push(["SINCE", criteria.since]);
  }

  if (criteria.before) {
    searchCriteria.push(["BEFORE", criteria.before]);
  }

  if (criteria.from) {
    searchCriteria.push(["FROM", criteria.from]);
  }

  if (criteria.to) {
    searchCriteria.push(["TO", criteria.to]);
  }

  if (criteria.subject) {
    searchCriteria.push(["SUBJECT", criteria.subject]);
  }

  if (criteria.body) {
    searchCriteria.push(["BODY", criteria.body]);
  }

  if (criteria.seen === true) {
    searchCriteria.push("SEEN");
  } else if (criteria.unseen === true || criteria.seen === false) {
    searchCriteria.push("UNSEEN");
  }

  if (criteria.flagged) {
    searchCriteria.push("FLAGGED");
  }

  if (criteria.keyword) {
    searchCriteria.push(["KEYWORD", criteria.keyword]);
  }

  if (criteria.uid && criteria.uid.length > 0) {
    searchCriteria.push(["UID", criteria.uid.join(",")]);
  }

  return searchCriteria;
}

/**
 * Fetch messages since a specific date/UID for polling
 */
export async function fetchNewMessagesSince(
  connection: ImapSimple,
  sinceDate: Date,
  folder: string = "INBOX",
): Promise<ImapMessage[]> {
  return fetchMessages(
    connection,
    { since: sinceDate },
    { folder, fetchBody: true },
  );
}

/**
 * Get message count in a folder
 */
export async function getMessageCount(
  connection: ImapSimple,
  folder: string = "INBOX",
): Promise<{ total: number; unseen: number }> {
  const box = await connection.openBox(folder);

  // Search for unseen messages
  const unseenResults = await connection.search(["UNSEEN"], { bodies: [] });

  return {
    total: box.messages.total,
    unseen: unseenResults.length,
  };
}

/**
 * Mark message as read
 */
export async function markAsRead(
  connection: ImapSimple,
  uid: number,
  folder: string = "INBOX",
): Promise<void> {
  await connection.openBox(folder);
  await connection.addFlags(uid, ["\\Seen"]);
}

/**
 * Mark message as unread
 */
export async function markAsUnread(
  connection: ImapSimple,
  uid: number,
  folder: string = "INBOX",
): Promise<void> {
  await connection.openBox(folder);
  await connection.delFlags(uid, ["\\Seen"]);
}

/**
 * Add a flag to a message
 */
export async function addFlag(
  connection: ImapSimple,
  uid: number,
  flag: string,
  folder: string = "INBOX",
): Promise<void> {
  await connection.openBox(folder);
  await connection.addFlags(uid, [flag]);
}

/**
 * Remove a flag from a message
 */
export async function removeFlag(
  connection: ImapSimple,
  uid: number,
  flag: string,
  folder: string = "INBOX",
): Promise<void> {
  await connection.openBox(folder);
  await connection.delFlags(uid, [flag]);
}

/**
 * Delete a message (move to trash or mark as deleted)
 */
export async function deleteMessage(
  connection: ImapSimple,
  uid: number,
  folder: string = "INBOX",
  trashFolder?: string,
): Promise<void> {
  await connection.openBox(folder);

  if (trashFolder) {
    // Move to trash folder if available
    await connection.moveMessage(uid, trashFolder);
  } else {
    // Mark as deleted and expunge
    await connection.addFlags(uid, ["\\Deleted"]);
    await (connection.imap as any).expunge();
  }
}

/**
 * Move a message to another folder
 */
export async function moveMessage(
  connection: ImapSimple,
  uid: number,
  sourceFolder: string,
  targetFolder: string,
): Promise<void> {
  await connection.openBox(sourceFolder);
  await connection.moveMessage(uid, targetFolder);
}

/**
 * Copy a message to another folder
 */
export async function copyMessage(
  connection: ImapSimple,
  uid: number,
  sourceFolder: string,
  targetFolder: string,
): Promise<void> {
  await connection.openBox(sourceFolder);
  await (connection.imap as any).copy(uid, targetFolder);
}
