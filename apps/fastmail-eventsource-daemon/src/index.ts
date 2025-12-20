#!/usr/bin/env node
import "dotenv/config";
import { AccountManager } from "./account-manager.js";

/**
 * Fastmail EventSource Daemon
 *
 * This daemon connects to Fastmail's JMAP EventSource API for real-time
 * email notifications and forwards state changes to the main Inbox Zero
 * application webhook.
 *
 * Architecture:
 * - Connects to Fastmail EventSource for each eligible account
 * - Receives real-time state change notifications
 * - Calls /api/fastmail/webhook on the main app to trigger email processing
 *
 * This is designed for self-hosted deployments where long-running connections
 * are supported. For Vercel/serverless, use the polling cron job instead.
 *
 * Future: When Fastmail adds PushSubscription (RFC 8620 section 7.2) support,
 * this daemon will become unnecessary as Fastmail will call our webhook directly.
 */

const _banner = `
╔═══════════════════════════════════════════════════════════════╗
║           Fastmail EventSource Daemon                          ║
║                                                                ║
║  Connects to Fastmail for real-time email notifications        ║
║  and forwards state changes to the main app webhook.           ║
╚═══════════════════════════════════════════════════════════════╝
`;

async function main(): Promise<void> {
  const manager = new AccountManager();

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = async (_signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    try {
      await manager.stop();
      process.exit(0);
    } catch (_error) {
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Handle uncaught errors
  process.on("uncaughtException", (_error) => {
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (_reason) => {
    // Don't shutdown on unhandled rejection, just log it
  });

  // Start the account manager
  try {
    await manager.start();

    // Log stats periodically
    setInterval(() => {
      const _stats = manager.getStats();
    }, 60_000); // Every minute
  } catch (_error) {
    process.exit(1);
  }
}

main().catch((_error) => {
  process.exit(1);
});
