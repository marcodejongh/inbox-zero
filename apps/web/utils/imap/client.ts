/**
 * IMAP Client Connection Management
 *
 * Provides connection pooling and management for IMAP connections.
 */

import imapSimple from "imap-simple";
import type { ImapSimple, ImapSimpleOptions } from "imap-simple";
import type { ImapConfig, ImapCapabilities } from "./types";

// Connection pool to reuse connections
const connectionPool = new Map<string, ImapSimple>();
const connectionLastUsed = new Map<string, number>();

// Connection timeout (5 minutes)
const CONNECTION_TIMEOUT = 5 * 60 * 1000;

// Cleanup interval (1 minute)
const CLEANUP_INTERVAL = 60 * 1000;

// Start cleanup interval
let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

function startCleanupInterval() {
  if (cleanupIntervalId) return;

  cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    for (const [key, lastUsed] of connectionLastUsed.entries()) {
      if (now - lastUsed > CONNECTION_TIMEOUT) {
        const connection = connectionPool.get(key);
        if (connection) {
          try {
            connection.end();
          } catch {
            // Ignore errors when closing
          }
          connectionPool.delete(key);
          connectionLastUsed.delete(key);
        }
      }
    }
  }, CLEANUP_INTERVAL);
}

function getConnectionKey(config: ImapConfig): string {
  return `${config.host}:${config.port}:${config.username}`;
}

/**
 * Create IMAP connection options from config
 */
function createImapOptions(config: ImapConfig): ImapSimpleOptions {
  const useTls = config.security === "tls" || config.security === "ssl";
  const useStartTls = config.security === "tls";

  return {
    imap: {
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      tls: useTls && !useStartTls,
      tlsOptions: {
        rejectUnauthorized: false, // Allow self-signed certificates for self-hosted servers
      },
      autotls: useStartTls ? "always" : "never",
      authTimeout: 30000,
      connTimeout: 30000,
    },
  };
}

/**
 * Connect to an IMAP server
 */
export async function connectImap(config: ImapConfig): Promise<ImapSimple> {
  startCleanupInterval();

  const key = getConnectionKey(config);

  // Check if we have an existing connection
  const existingConnection = connectionPool.get(key);
  if (existingConnection) {
    try {
      // Test if connection is still alive by checking state
      if (existingConnection.imap.state === "authenticated") {
        connectionLastUsed.set(key, Date.now());
        return existingConnection;
      }
    } catch {
      // Connection is dead, remove it
      connectionPool.delete(key);
      connectionLastUsed.delete(key);
    }
  }

  // Create new connection
  const options = createImapOptions(config);
  const connection = await imapSimple.connect(options);

  // Store in pool
  connectionPool.set(key, connection);
  connectionLastUsed.set(key, Date.now());

  // Handle connection end/error
  connection.imap.on("end", () => {
    connectionPool.delete(key);
    connectionLastUsed.delete(key);
  });

  connection.imap.on("error", () => {
    connectionPool.delete(key);
    connectionLastUsed.delete(key);
  });

  return connection;
}

/**
 * Disconnect from IMAP server
 */
export async function disconnectImap(config: ImapConfig): Promise<void> {
  const key = getConnectionKey(config);
  const connection = connectionPool.get(key);

  if (connection) {
    try {
      connection.end();
    } catch {
      // Ignore errors when closing
    }
    connectionPool.delete(key);
    connectionLastUsed.delete(key);
  }
}

/**
 * Get IMAP server capabilities
 */
export async function getImapCapabilities(
  connection: ImapSimple,
): Promise<ImapCapabilities> {
  const imap = connection.imap;

  // Get raw capabilities from the server
  const rawCapabilities = (imap as any).serverSupports
    ? Array.from((imap as any).serverSupports)
    : [];

  return {
    supportsKeywords:
      rawCapabilities.includes("X-KEYWORDS") ||
      rawCapabilities.includes("IMAP4rev1"),
    supportsIdle: rawCapabilities.includes("IDLE"),
    supportsMove: rawCapabilities.includes("MOVE"),
    supportsCondstore: rawCapabilities.includes("CONDSTORE"),
    supportsQresync: rawCapabilities.includes("QRESYNC"),
    supportsUtf8:
      rawCapabilities.includes("UTF8=ACCEPT") ||
      rawCapabilities.includes("UTF8=ALL"),
    supportedFlags: ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"],
    permanentFlags: ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft"],
  };
}

/**
 * Test IMAP connection with credentials
 */
export async function testImapConnection(
  config: ImapConfig,
): Promise<{ success: boolean; error?: string; capabilities?: ImapCapabilities }> {
  try {
    const connection = await connectImap(config);
    const capabilities = await getImapCapabilities(connection);
    await disconnectImap(config);
    return { success: true, capabilities };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown connection error";
    return { success: false, error: message };
  }
}

/**
 * Open a mailbox (folder)
 */
export async function openMailbox(
  connection: ImapSimple,
  mailbox: string = "INBOX",
  readOnly: boolean = false,
): Promise<{
  name: string;
  exists: number;
  recent: number;
  uidvalidity: number;
  uidnext: number;
}> {
  const result = await connection.openBox(mailbox, readOnly);

  return {
    name: result.name,
    exists: result.messages.total,
    recent: result.messages.new,
    uidvalidity: result.uidvalidity,
    uidnext: result.uidnext,
  };
}

/**
 * Close all connections (for cleanup)
 */
export function closeAllConnections(): void {
  for (const connection of connectionPool.values()) {
    try {
      connection.end();
    } catch {
      // Ignore errors when closing
    }
  }
  connectionPool.clear();
  connectionLastUsed.clear();

  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}
