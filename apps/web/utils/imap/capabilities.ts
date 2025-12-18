/**
 * IMAP Server Capability Detection
 *
 * Detects and stores server capabilities for optimized operations.
 */

import type { ImapSimple } from "imap-simple";
import type { ImapCapabilities, ImapFolder } from "./types";
import {
  listFolders,
  findFolderBySpecialUse,
  STANDARD_FOLDERS,
} from "./folder";

/**
 * Known IMAP server types and their quirks
 */
export type ImapServerType =
  | "gmail"
  | "outlook"
  | "fastmail"
  | "yahoo"
  | "dovecot"
  | "exchange"
  | "cyrus"
  | "unknown";

export interface ServerInfo {
  type: ImapServerType;
  capabilities: ImapCapabilities;
  folders: {
    inbox: string;
    sent: string | null;
    drafts: string | null;
    trash: string | null;
    spam: string | null;
    archive: string | null;
  };
  supportsLabels: boolean;
  supportsSearch: boolean;
  supportsSort: boolean;
}

/**
 * Detect all server capabilities
 */
export async function detectCapabilities(
  connection: ImapSimple,
): Promise<ImapCapabilities> {
  const imap = connection.imap;

  // Try to get capabilities from the server
  let rawCapabilities: string[] = [];

  try {
    // Access the server's capability list
    const caps = (imap as any).serverSupports;
    if (caps) {
      rawCapabilities = Array.from(caps);
    }
  } catch {
    // Fallback: try to get capabilities manually
    rawCapabilities = [];
  }

  // Check for specific capabilities
  const capabilities: ImapCapabilities = {
    supportsKeywords: hasCapability(rawCapabilities, [
      "X-KEYWORDS",
      "IMAP4rev1",
      "PERMANENTFLAGS",
    ]),
    supportsIdle: hasCapability(rawCapabilities, ["IDLE"]),
    supportsMove: hasCapability(rawCapabilities, ["MOVE"]),
    supportsCondstore: hasCapability(rawCapabilities, ["CONDSTORE"]),
    supportsQresync: hasCapability(rawCapabilities, ["QRESYNC"]),
    supportsUtf8: hasCapability(rawCapabilities, ["UTF8=ACCEPT", "UTF8=ALL"]),
    supportedFlags: ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"],
    permanentFlags: [],
  };

  // Try to get permanent flags from INBOX
  try {
    const box = await connection.openBox("INBOX", true);
    if (box.permFlags) {
      capabilities.permanentFlags = box.permFlags;
      // Check if server supports custom keywords
      if (box.permFlags.includes("\\*")) {
        capabilities.supportsKeywords = true;
      }
    }
  } catch {
    // Ignore errors
  }

  return capabilities;
}

/**
 * Check if any of the given capabilities are present
 */
function hasCapability(
  serverCapabilities: string[],
  lookFor: string[],
): boolean {
  const upperCaps = serverCapabilities.map((c) => c.toUpperCase());
  return lookFor.some((cap) => upperCaps.includes(cap.toUpperCase()));
}

/**
 * Detect server type based on greeting and capabilities
 */
export async function detectServerType(
  connection: ImapSimple,
): Promise<ImapServerType> {
  const imap = connection.imap;

  // Check for known server identifiers
  const greeting = (imap as any)._greeting || "";
  const caps = (imap as any).serverSupports
    ? Array.from((imap as any).serverSupports).join(" ")
    : "";

  const combined = `${greeting} ${caps}`.toLowerCase();

  if (combined.includes("gimap") || combined.includes("[gmail]")) {
    return "gmail";
  }

  if (
    combined.includes("outlook") ||
    combined.includes("office365") ||
    combined.includes("microsoft")
  ) {
    return "outlook";
  }

  if (combined.includes("fastmail")) {
    return "fastmail";
  }

  if (combined.includes("yahoo")) {
    return "yahoo";
  }

  if (combined.includes("dovecot")) {
    return "dovecot";
  }

  if (combined.includes("exchange")) {
    return "exchange";
  }

  if (combined.includes("cyrus")) {
    return "cyrus";
  }

  return "unknown";
}

/**
 * Get complete server information including capabilities and folder mapping
 */
export async function getServerInfo(
  connection: ImapSimple,
): Promise<ServerInfo> {
  const serverType = await detectServerType(connection);
  const capabilities = await detectCapabilities(connection);

  // Find standard folders
  const inboxFolder = await findFolderBySpecialUse(connection, "INBOX");
  const sentFolder = await findFolderBySpecialUse(connection, "SENT");
  const draftsFolder = await findFolderBySpecialUse(connection, "DRAFTS");
  const trashFolder = await findFolderBySpecialUse(connection, "TRASH");
  const spamFolder = await findFolderBySpecialUse(connection, "JUNK");
  const archiveFolder = await findFolderBySpecialUse(connection, "ARCHIVE");

  return {
    type: serverType,
    capabilities,
    folders: {
      inbox: inboxFolder?.path || "INBOX",
      sent: sentFolder?.path || null,
      drafts: draftsFolder?.path || null,
      trash: trashFolder?.path || null,
      spam: spamFolder?.path || null,
      archive: archiveFolder?.path || null,
    },
    supportsLabels: capabilities.supportsKeywords,
    supportsSearch: true, // All IMAP servers support basic SEARCH
    supportsSort: hasServerCapability(connection, ["SORT"]),
  };
}

/**
 * Check if server has a specific capability
 */
function hasServerCapability(
  connection: ImapSimple,
  capabilities: string[],
): boolean {
  const serverCaps = (connection.imap as any).serverSupports;
  if (!serverCaps) return false;

  const upperCaps = Array.from(serverCaps).map((c: any) =>
    c.toString().toUpperCase(),
  );
  return capabilities.some((cap) => upperCaps.includes(cap.toUpperCase()));
}

/**
 * Cache key for server info
 */
function getServerCacheKey(host: string, username: string): string {
  return `${host}:${username}`;
}

// In-memory cache for server info (would be moved to database in production)
const serverInfoCache = new Map<string, { info: ServerInfo; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get cached server info or detect it
 */
export async function getCachedServerInfo(
  connection: ImapSimple,
  host: string,
  username: string,
): Promise<ServerInfo> {
  const cacheKey = getServerCacheKey(host, username);
  const cached = serverInfoCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.info;
  }

  const info = await getServerInfo(connection);
  serverInfoCache.set(cacheKey, { info, timestamp: Date.now() });

  return info;
}

/**
 * Clear cached server info
 */
export function clearServerInfoCache(host: string, username: string): void {
  const cacheKey = getServerCacheKey(host, username);
  serverInfoCache.delete(cacheKey);
}

/**
 * Convert capabilities to JSON for database storage
 */
export function capabilitiesToJson(
  capabilities: ImapCapabilities,
): Record<string, any> {
  return {
    supportsKeywords: capabilities.supportsKeywords,
    supportsIdle: capabilities.supportsIdle,
    supportsMove: capabilities.supportsMove,
    supportsCondstore: capabilities.supportsCondstore,
    supportsQresync: capabilities.supportsQresync,
    supportsUtf8: capabilities.supportsUtf8,
    supportedFlags: capabilities.supportedFlags,
    permanentFlags: capabilities.permanentFlags,
  };
}

/**
 * Parse capabilities from JSON (from database)
 */
export function capabilitiesFromJson(
  json: Record<string, any>,
): ImapCapabilities {
  return {
    supportsKeywords: json.supportsKeywords ?? false,
    supportsIdle: json.supportsIdle ?? false,
    supportsMove: json.supportsMove ?? false,
    supportsCondstore: json.supportsCondstore ?? false,
    supportsQresync: json.supportsQresync ?? false,
    supportsUtf8: json.supportsUtf8 ?? false,
    supportedFlags: json.supportedFlags ?? [],
    permanentFlags: json.permanentFlags ?? [],
  };
}

/**
 * Get optimized fetch options based on server capabilities
 */
export function getOptimizedFetchOptions(
  capabilities: ImapCapabilities,
): {
  usePeek: boolean;
  batchSize: number;
  usePartialFetch: boolean;
} {
  return {
    // Use BODY.PEEK to avoid marking messages as read
    usePeek: true,
    // Batch size for fetching messages
    batchSize: capabilities.supportsCondstore ? 100 : 50,
    // Use partial fetch for large messages
    usePartialFetch: true,
  };
}
