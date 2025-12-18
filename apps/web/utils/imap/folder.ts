/**
 * IMAP Folder Operations
 *
 * Handles listing, creating, and managing IMAP folders (mailboxes).
 */

import type { ImapSimple } from "imap-simple";
import type { ImapFolder } from "./types";

/**
 * Standard folder names and their common aliases
 */
export const STANDARD_FOLDERS = {
  INBOX: ["INBOX", "Inbox"],
  SENT: ["Sent", "Sent Items", "Sent Mail", "[Gmail]/Sent Mail"],
  DRAFTS: ["Drafts", "[Gmail]/Drafts"],
  TRASH: ["Trash", "Deleted Items", "Deleted Messages", "[Gmail]/Trash", "Bin"],
  JUNK: ["Junk", "Spam", "Junk E-mail", "[Gmail]/Spam"],
  ARCHIVE: ["Archive", "All Mail", "[Gmail]/All Mail"],
} as const;

/**
 * Special-use folder attributes
 */
export const SPECIAL_USE_FLAGS = {
  "\\All": "all",
  "\\Archive": "archive",
  "\\Drafts": "drafts",
  "\\Flagged": "flagged",
  "\\Important": "important",
  "\\Junk": "junk",
  "\\Sent": "sent",
  "\\Trash": "trash",
} as const;

/**
 * List all folders from the IMAP server
 */
export async function listFolders(connection: ImapSimple): Promise<ImapFolder[]> {
  const boxes = await connection.getBoxes();
  return parseBoxes(boxes, "", "/");
}

/**
 * Parse IMAP boxes into our folder structure
 */
function parseBoxes(
  boxes: Record<string, any>,
  parentPath: string,
  defaultDelimiter: string,
): ImapFolder[] {
  const folders: ImapFolder[] = [];

  for (const [name, box] of Object.entries(boxes)) {
    const delimiter = box.delimiter || defaultDelimiter;
    const path = parentPath ? `${parentPath}${delimiter}${name}` : name;

    const folder: ImapFolder = {
      name,
      path,
      delimiter,
      flags: box.attribs || [],
      specialUse: detectSpecialUse(name, box.attribs || []),
    };

    // Recursively parse children
    if (box.children) {
      folder.children = parseBoxes(box.children, path, delimiter);
    }

    folders.push(folder);
  }

  return folders;
}

/**
 * Detect the special use of a folder based on name and flags
 */
function detectSpecialUse(name: string, flags: string[]): string | undefined {
  // Check flags first
  for (const flag of flags) {
    const specialUse = SPECIAL_USE_FLAGS[flag as keyof typeof SPECIAL_USE_FLAGS];
    if (specialUse) {
      return specialUse;
    }
  }

  // Fall back to name-based detection
  const normalizedName = name.toLowerCase();

  if (normalizedName === "inbox") return "inbox";

  for (const [specialUse, aliases] of Object.entries(STANDARD_FOLDERS)) {
    for (const alias of aliases) {
      if (normalizedName === alias.toLowerCase()) {
        return specialUse.toLowerCase();
      }
    }
  }

  return undefined;
}

/**
 * Find a folder by its special use
 */
export async function findFolderBySpecialUse(
  connection: ImapSimple,
  specialUse: keyof typeof STANDARD_FOLDERS,
): Promise<ImapFolder | null> {
  const folders = await listFolders(connection);
  return findFolderRecursive(folders, (folder) => {
    // Check by special use attribute
    if (folder.specialUse === specialUse.toLowerCase()) {
      return true;
    }

    // Check by name aliases
    const aliases = STANDARD_FOLDERS[specialUse];
    return aliases.some(
      (alias) => folder.name.toLowerCase() === alias.toLowerCase(),
    );
  });
}

/**
 * Find a folder recursively
 */
function findFolderRecursive(
  folders: ImapFolder[],
  predicate: (folder: ImapFolder) => boolean,
): ImapFolder | null {
  for (const folder of folders) {
    if (predicate(folder)) {
      return folder;
    }

    if (folder.children) {
      const found = findFolderRecursive(folder.children, predicate);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Find a folder by path
 */
export async function findFolderByPath(
  connection: ImapSimple,
  path: string,
): Promise<ImapFolder | null> {
  const folders = await listFolders(connection);
  return findFolderRecursive(
    folders,
    (folder) => folder.path.toLowerCase() === path.toLowerCase(),
  );
}

/**
 * Find a folder by name (searches recursively)
 */
export async function findFolderByName(
  connection: ImapSimple,
  name: string,
): Promise<ImapFolder | null> {
  const folders = await listFolders(connection);
  return findFolderRecursive(
    folders,
    (folder) => folder.name.toLowerCase() === name.toLowerCase(),
  );
}

/**
 * Get inbox folder path
 */
export async function getInboxPath(connection: ImapSimple): Promise<string> {
  // INBOX is always INBOX in IMAP
  return "INBOX";
}

/**
 * Get sent folder path
 */
export async function getSentPath(connection: ImapSimple): Promise<string | null> {
  const folder = await findFolderBySpecialUse(connection, "SENT");
  return folder?.path || null;
}

/**
 * Get drafts folder path
 */
export async function getDraftsPath(connection: ImapSimple): Promise<string | null> {
  const folder = await findFolderBySpecialUse(connection, "DRAFTS");
  return folder?.path || null;
}

/**
 * Get trash folder path
 */
export async function getTrashPath(connection: ImapSimple): Promise<string | null> {
  const folder = await findFolderBySpecialUse(connection, "TRASH");
  return folder?.path || null;
}

/**
 * Get spam/junk folder path
 */
export async function getSpamPath(connection: ImapSimple): Promise<string | null> {
  const folder = await findFolderBySpecialUse(connection, "JUNK");
  return folder?.path || null;
}

/**
 * Get archive folder path
 */
export async function getArchivePath(connection: ImapSimple): Promise<string | null> {
  const folder = await findFolderBySpecialUse(connection, "ARCHIVE");
  return folder?.path || null;
}

/**
 * Create a new folder
 */
export async function createFolder(
  connection: ImapSimple,
  path: string,
): Promise<void> {
  await (connection.imap as any).addBox(path);
}

/**
 * Delete a folder
 */
export async function deleteFolder(
  connection: ImapSimple,
  path: string,
): Promise<void> {
  await (connection.imap as any).delBox(path);
}

/**
 * Rename a folder
 */
export async function renameFolder(
  connection: ImapSimple,
  oldPath: string,
  newPath: string,
): Promise<void> {
  await (connection.imap as any).renameBox(oldPath, newPath);
}

/**
 * Subscribe to a folder
 */
export async function subscribeFolder(
  connection: ImapSimple,
  path: string,
): Promise<void> {
  await (connection.imap as any).subscribeBox(path);
}

/**
 * Unsubscribe from a folder
 */
export async function unsubscribeFolder(
  connection: ImapSimple,
  path: string,
): Promise<void> {
  await (connection.imap as any).unsubscribeBox(path);
}

/**
 * Get or create a folder by path
 */
export async function getOrCreateFolder(
  connection: ImapSimple,
  path: string,
): Promise<ImapFolder> {
  const existing = await findFolderByPath(connection, path);
  if (existing) return existing;

  await createFolder(connection, path);

  return {
    name: path.split("/").pop() || path,
    path,
    delimiter: "/",
    flags: [],
  };
}

/**
 * Convert folders to a flat list with full paths
 */
export function flattenFolders(folders: ImapFolder[]): ImapFolder[] {
  const result: ImapFolder[] = [];

  function flatten(folder: ImapFolder) {
    result.push(folder);
    if (folder.children) {
      for (const child of folder.children) {
        flatten(child);
      }
    }
  }

  for (const folder of folders) {
    flatten(folder);
  }

  return result;
}

/**
 * Get folder statistics
 */
export async function getFolderStats(
  connection: ImapSimple,
  path: string,
): Promise<{
  total: number;
  unseen: number;
  recent: number;
}> {
  const box = await connection.openBox(path, true); // Open read-only

  // Get unseen count
  const unseenResults = await connection.search(["UNSEEN"], { bodies: [] });

  return {
    total: box.messages.total,
    unseen: unseenResults.length,
    recent: box.messages.new,
  };
}
