/**
 * IMAP Keyword Operations
 *
 * IMAP keywords are custom flags that can be used as labels.
 * Not all IMAP servers support keywords, so we also support
 * folder-based labeling as a fallback.
 */

import type { ImapSimple } from "imap-simple";
import type { ImapCapabilities } from "./types";
import { getOrCreateFolder } from "./folder";

/**
 * Inbox Zero specific keyword prefixes
 */
export const INBOX_ZERO_KEYWORD_PREFIX = "IZ_";

/**
 * Map of Inbox Zero labels to IMAP keywords
 */
export const INBOX_ZERO_LABELS = {
  PROCESSED: `${INBOX_ZERO_KEYWORD_PREFIX}Processed`,
  AI_DRAFT: `${INBOX_ZERO_KEYWORD_PREFIX}AIDraft`,
  AWAITING_REPLY: `${INBOX_ZERO_KEYWORD_PREFIX}AwaitingReply`,
  NEEDS_REPLY: `${INBOX_ZERO_KEYWORD_PREFIX}NeedsReply`,
  COLD_EMAIL: `${INBOX_ZERO_KEYWORD_PREFIX}ColdEmail`,
  NEWSLETTER: `${INBOX_ZERO_KEYWORD_PREFIX}Newsletter`,
} as const;

/**
 * Check if the server supports keywords
 */
export function supportsKeywords(capabilities: ImapCapabilities): boolean {
  return capabilities.supportsKeywords;
}

/**
 * Add a keyword (label) to a message
 */
export async function addKeyword(
  connection: ImapSimple,
  uid: number,
  keyword: string,
  folder: string = "INBOX",
): Promise<void> {
  await connection.openBox(folder);

  // Sanitize keyword (no spaces, special chars)
  const sanitized = sanitizeKeyword(keyword);
  await connection.addFlags(uid, [sanitized]);
}

/**
 * Remove a keyword (label) from a message
 */
export async function removeKeyword(
  connection: ImapSimple,
  uid: number,
  keyword: string,
  folder: string = "INBOX",
): Promise<void> {
  await connection.openBox(folder);

  const sanitized = sanitizeKeyword(keyword);
  await connection.delFlags(uid, [sanitized]);
}

/**
 * Get all keywords (labels) for a message
 */
export async function getKeywords(
  connection: ImapSimple,
  uid: number,
  folder: string = "INBOX",
): Promise<string[]> {
  await connection.openBox(folder);

  const results = await connection.search([["UID", uid.toString()]], {
    bodies: [],
    struct: false,
  });

  if (results.length === 0) return [];

  const flags = results[0].attributes.flags || [];

  // Filter to only custom keywords (not standard IMAP flags)
  return flags.filter((flag: string) => !flag.startsWith("\\"));
}

/**
 * Sanitize a keyword name for IMAP compatibility
 */
export function sanitizeKeyword(keyword: string): string {
  // Remove spaces and special characters
  // IMAP keywords are typically alphanumeric with some allowed characters
  return keyword
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .substring(0, 63); // Max keyword length
}

/**
 * Convert an Inbox Zero label name to IMAP keyword
 */
export function labelToKeyword(label: string): string {
  const upperLabel = label.toUpperCase();

  // Check if it's a known Inbox Zero label
  if (upperLabel in INBOX_ZERO_LABELS) {
    return INBOX_ZERO_LABELS[upperLabel as keyof typeof INBOX_ZERO_LABELS];
  }

  // Create a custom keyword
  return sanitizeKeyword(`${INBOX_ZERO_KEYWORD_PREFIX}${label}`);
}

/**
 * Convert an IMAP keyword to Inbox Zero label name
 */
export function keywordToLabel(keyword: string): string {
  // Remove Inbox Zero prefix if present
  if (keyword.startsWith(INBOX_ZERO_KEYWORD_PREFIX)) {
    const withoutPrefix = keyword.substring(INBOX_ZERO_KEYWORD_PREFIX.length);

    // Check if it's a known label
    for (const [label, kw] of Object.entries(INBOX_ZERO_LABELS)) {
      if (kw === keyword) {
        return label;
      }
    }

    return withoutPrefix;
  }

  return keyword;
}

/**
 * Add an Inbox Zero label to a message
 */
export async function addInboxZeroLabel(
  connection: ImapSimple,
  uid: number,
  label: keyof typeof INBOX_ZERO_LABELS,
  folder: string = "INBOX",
): Promise<void> {
  const keyword = INBOX_ZERO_LABELS[label];
  await addKeyword(connection, uid, keyword, folder);
}

/**
 * Remove an Inbox Zero label from a message
 */
export async function removeInboxZeroLabel(
  connection: ImapSimple,
  uid: number,
  label: keyof typeof INBOX_ZERO_LABELS,
  folder: string = "INBOX",
): Promise<void> {
  const keyword = INBOX_ZERO_LABELS[label];
  await removeKeyword(connection, uid, keyword, folder);
}

/**
 * Check if a message has an Inbox Zero label
 */
export async function hasInboxZeroLabel(
  connection: ImapSimple,
  uid: number,
  label: keyof typeof INBOX_ZERO_LABELS,
  folder: string = "INBOX",
): Promise<boolean> {
  const keywords = await getKeywords(connection, uid, folder);
  const keyword = INBOX_ZERO_LABELS[label];
  return keywords.includes(keyword);
}

/**
 * Search for messages with a specific keyword
 */
export async function searchByKeyword(
  connection: ImapSimple,
  keyword: string,
  folder: string = "INBOX",
): Promise<number[]> {
  await connection.openBox(folder);

  const sanitized = sanitizeKeyword(keyword);
  const results = await connection.search([["KEYWORD", sanitized]], {
    bodies: [],
  });

  return results.map((r: any) => r.attributes.uid);
}

/**
 * Folder-based labeling (fallback for servers without keyword support)
 * Creates a folder hierarchy like: Labels/CustomLabel
 */
export const LABELS_FOLDER_PREFIX = "Labels";

/**
 * Add a label using folder-based approach (fallback)
 * Copies the message to a label folder
 */
export async function addLabelViaFolder(
  connection: ImapSimple,
  uid: number,
  label: string,
  sourceFolder: string = "INBOX",
): Promise<void> {
  const labelFolderPath = `${LABELS_FOLDER_PREFIX}/${sanitizeKeyword(label)}`;

  // Ensure label folder exists
  await getOrCreateFolder(connection, labelFolderPath);

  // Copy message to label folder
  await connection.openBox(sourceFolder);
  await (connection.imap as any).copy(uid, labelFolderPath);
}

/**
 * Remove a label using folder-based approach (fallback)
 * This is tricky - we need to find and delete the copy in the label folder
 */
export async function removeLabelViaFolder(
  connection: ImapSimple,
  messageId: string,
  label: string,
): Promise<void> {
  const labelFolderPath = `${LABELS_FOLDER_PREFIX}/${sanitizeKeyword(label)}`;

  // Find the message in the label folder by Message-ID header
  await connection.openBox(labelFolderPath);

  const results = await connection.search(
    [["HEADER", "MESSAGE-ID", messageId]],
    { bodies: [] },
  );

  if (results.length > 0) {
    const uid = results[0].attributes.uid;
    await connection.addFlags(uid, ["\\Deleted"]);
    await (connection.imap as any).expunge();
  }
}

/**
 * List all custom labels (either keywords or folders)
 */
export async function listAllLabels(
  connection: ImapSimple,
  capabilities: ImapCapabilities,
): Promise<string[]> {
  const labels: Set<string> = new Set();

  if (capabilities.supportsKeywords) {
    // Get permanent flags which might include keywords
    // This is tricky as not all servers report custom keywords
    // We'll rely on the permanentFlags from capabilities
    for (const flag of capabilities.permanentFlags) {
      if (!flag.startsWith("\\")) {
        labels.add(keywordToLabel(flag));
      }
    }
  }

  // Also check for label folders
  try {
    const boxes = await connection.getBoxes();
    if (boxes[LABELS_FOLDER_PREFIX]) {
      const labelBoxes = boxes[LABELS_FOLDER_PREFIX].children || {};
      for (const labelName of Object.keys(labelBoxes)) {
        labels.add(labelName);
      }
    }
  } catch {
    // Ignore errors if Labels folder doesn't exist
  }

  return Array.from(labels);
}

/**
 * Smart label function that uses keywords or folders based on server capabilities
 */
export async function smartAddLabel(
  connection: ImapSimple,
  uid: number,
  label: string,
  capabilities: ImapCapabilities,
  folder: string = "INBOX",
  messageId?: string,
): Promise<void> {
  if (capabilities.supportsKeywords) {
    await addKeyword(connection, uid, labelToKeyword(label), folder);
  } else if (messageId) {
    await addLabelViaFolder(connection, uid, label, folder);
  } else {
    throw new Error("Cannot add label without keyword support and no message ID provided");
  }
}

/**
 * Smart remove label function
 */
export async function smartRemoveLabel(
  connection: ImapSimple,
  uid: number,
  label: string,
  capabilities: ImapCapabilities,
  folder: string = "INBOX",
  messageId?: string,
): Promise<void> {
  if (capabilities.supportsKeywords) {
    await removeKeyword(connection, uid, labelToKeyword(label), folder);
  } else if (messageId) {
    await removeLabelViaFolder(connection, messageId, label);
  } else {
    throw new Error("Cannot remove label without keyword support and no message ID provided");
  }
}
