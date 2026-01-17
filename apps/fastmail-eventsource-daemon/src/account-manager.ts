import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";
import { FastmailEventSourceClient } from "./eventsource-client.js";
import { callWebhook } from "./webhook-caller.js";

/**
 * JMAP Session URL for Fastmail.
 */
const FASTMAIL_JMAP_SESSION_URL = "https://api.fastmail.com/jmap/session";

/**
 * JMAP OAuth token URL for Fastmail.
 */
const FASTMAIL_OAUTH_TOKEN_URL = "https://www.fastmail.com/dev/oidc/token";

/**
 * JMAP Session response containing API URLs and account information.
 */
interface JMAPSession {
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  accounts: Record<
    string,
    {
      name: string;
      isPersonal: boolean;
      isReadOnly: boolean;
      accountCapabilities: Record<string, unknown>;
    }
  >;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
}

/**
 * Managed account with its EventSource client.
 */
interface ManagedAccount {
  emailAccountId: string;
  email: string;
  client: FastmailEventSourceClient;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

/**
 * OAuth token response.
 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Manages EventSource connections for all Fastmail accounts.
 */
export class AccountManager {
  private readonly prisma: PrismaClient;
  private readonly connections = new Map<string, ManagedAccount>();
  private refreshInterval: NodeJS.Timeout | null = null;
  private running = false;

  constructor() {
    this.prisma = new PrismaClient();
  }

  /**
   * Start the account manager.
   */
  async start(): Promise<void> {
    if (this.running) {
      log("Already running");
      return;
    }

    this.running = true;
    log("Starting account manager");

    // Initial account load
    await this.refreshAccounts();

    // Start periodic refresh
    this.refreshInterval = setInterval(
      () => this.refreshAccounts(),
      env.ACCOUNT_REFRESH_INTERVAL,
    );

    log(
      `Started with refresh interval of ${env.ACCOUNT_REFRESH_INTERVAL}ms (${env.ACCOUNT_REFRESH_INTERVAL / 1000 / 60} minutes)`,
    );
  }

  /**
   * Stop the account manager and close all connections.
   */
  async stop(): Promise<void> {
    log("Stopping account manager");
    this.running = false;

    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    // Close all connections
    for (const [id, managed] of this.connections) {
      log(`Closing connection for ${id}`);
      managed.client.close();
    }
    this.connections.clear();

    await this.prisma.$disconnect();
    log("Stopped");
  }

  /**
   * Refresh the account list from the database.
   * Starts new connections and removes stale ones.
   */
  private async refreshAccounts(): Promise<void> {
    try {
      log("Refreshing accounts from database");

      const accounts = await this.getFastmailAccounts();
      log(`Found ${accounts.length} eligible Fastmail accounts`);

      const currentIds = new Set(this.connections.keys());
      const newIds = new Set(accounts.map((a) => a.id));

      // Remove connections for accounts that no longer exist or are ineligible
      for (const id of currentIds) {
        if (!newIds.has(id)) {
          log(`Removing connection for deleted/ineligible account: ${id}`);
          const managed = this.connections.get(id);
          managed?.client.close();
          this.connections.delete(id);
        }
      }

      // Add connections for new accounts
      for (const account of accounts) {
        if (!currentIds.has(account.id)) {
          await this.addConnection(account);
        }
      }
    } catch (error) {
      log(`Error refreshing accounts: ${error}`, "error");
    }
  }

  /**
   * Get Fastmail accounts eligible for EventSource connections.
   * These are accounts with:
   * - Fastmail provider
   * - Valid access token
   * - Premium tier with AI access
   * - At least one enabled rule
   */
  private async getFastmailAccounts() {
    // Query accounts similar to poll-sync.ts but simplified
    // We don't need all the user/rule data, just enough to connect
    return this.prisma.emailAccount.findMany({
      where: {
        account: {
          provider: "fastmail",
          access_token: { not: null },
        },
        // Has at least one enabled rule
        rules: {
          some: { enabled: true },
        },
        // Has premium with AI access (simplified check)
        user: {
          OR: [
            // Has an active Stripe subscription
            { premium: { stripeSubscriptionStatus: "active" } },
            // Has an active Lemon Squeezy subscription
            {
              premium: {
                lemonSqueezyRenewsAt: { gt: new Date() },
              },
            },
            // Self-hosted bypass (if we're querying, assume bypass is set in main app)
            // Users without premium but with AI API key
            { aiApiKey: { not: null } },
          ],
        },
      },
      select: {
        id: true,
        email: true,
        account: {
          select: {
            access_token: true,
            refresh_token: true,
            expires_at: true,
          },
        },
      },
    });
  }

  /**
   * Add a new EventSource connection for an account.
   */
  private async addConnection(account: {
    id: string;
    email: string;
    account: {
      access_token: string | null;
      refresh_token: string | null;
      expires_at: Date | null;
    } | null;
  }): Promise<void> {
    if (!account.account?.access_token) {
      log(`No access token for ${account.email}`, "warn");
      return;
    }

    try {
      log(`Adding connection for ${account.email}`);

      // Get the JMAP session to find the eventSourceUrl
      const session = await this.getJMAPSession(account.account.access_token);
      if (!session) {
        log(`Failed to get JMAP session for ${account.email}`, "error");
        return;
      }

      const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
      if (!accountId) {
        log(`No mail account in session for ${account.email}`, "error");
        return;
      }

      const client = new FastmailEventSourceClient({
        eventSourceUrl: session.eventSourceUrl,
        accessToken: account.account.access_token,
        accountId,
        emailAccountId: account.id,
        onStateChange: (emailAccountId, newState) => {
          this.handleStateChange(emailAccountId, newState);
        },
        onError: (emailAccountId, error) => {
          log(`EventSource error for ${emailAccountId}: ${error}`, "error");
          // Check if it's an auth error and try to refresh
          if (error.message.includes("401")) {
            this.handleTokenRefresh(emailAccountId);
          }
        },
        onConnected: (emailAccountId) => {
          log(`Connected: ${emailAccountId}`);
        },
        onDisconnected: (emailAccountId) => {
          log(`Disconnected: ${emailAccountId}`);
        },
      });

      this.connections.set(account.id, {
        emailAccountId: account.id,
        email: account.email,
        client,
        accessToken: account.account.access_token,
        refreshToken: account.account.refresh_token,
        expiresAt: account.account.expires_at,
      });

      client.connect();
    } catch (error) {
      log(`Failed to add connection for ${account.email}: ${error}`, "error");
    }
  }

  /**
   * Get the JMAP session for an account.
   */
  private async getJMAPSession(
    accessToken: string,
  ): Promise<JMAPSession | null> {
    try {
      const response = await fetch(FASTMAIL_JMAP_SESSION_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        log(`Failed to get JMAP session: ${response.status}`, "error");
        return null;
      }

      return (await response.json()) as JMAPSession;
    } catch (error) {
      log(`Error fetching JMAP session: ${error}`, "error");
      return null;
    }
  }

  /**
   * Handle a state change event from an EventSource client.
   */
  private async handleStateChange(
    emailAccountId: string,
    newState: string,
  ): Promise<void> {
    log(`State change for ${emailAccountId}: ${newState}`);

    const success = await callWebhook(emailAccountId, newState);
    if (!success) {
      log(`Failed to notify webhook for ${emailAccountId}`, "error");
    }
  }

  /**
   * Handle token refresh for an account.
   */
  private async handleTokenRefresh(emailAccountId: string): Promise<void> {
    const managed = this.connections.get(emailAccountId);
    if (!managed) {
      log(`No managed account for ${emailAccountId}`, "warn");
      return;
    }

    if (!managed.refreshToken) {
      log(`No refresh token for ${emailAccountId}`, "warn");
      return;
    }

    if (!env.FASTMAIL_CLIENT_ID || !env.FASTMAIL_CLIENT_SECRET) {
      log("Missing Fastmail OAuth credentials for token refresh", "error");
      return;
    }

    try {
      log(`Refreshing token for ${emailAccountId}`);

      const response = await fetch(FASTMAIL_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: managed.refreshToken,
          client_id: env.FASTMAIL_CLIENT_ID,
          client_secret: env.FASTMAIL_CLIENT_SECRET,
        }),
      });

      if (!response.ok) {
        log(
          `Token refresh failed for ${emailAccountId}: ${response.status}`,
          "error",
        );
        return;
      }

      const tokens = (await response.json()) as TokenResponse;
      const newAccessToken = tokens.access_token;

      // Update the client with the new token
      managed.accessToken = newAccessToken;
      managed.refreshToken = tokens.refresh_token || managed.refreshToken;
      managed.expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : null;

      managed.client.updateAccessToken(newAccessToken);

      log(`Token refreshed for ${emailAccountId}`);
    } catch (error) {
      log(`Error refreshing token for ${emailAccountId}: ${error}`, "error");
    }
  }

  /**
   * Get connection stats.
   */
  getStats(): { total: number; connected: number } {
    let connected = 0;
    for (const managed of this.connections.values()) {
      if (managed.client.isConnected()) {
        connected++;
      }
    }
    return { total: this.connections.size, connected };
  }
}

function log(
  _message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  const timestamp = new Date().toISOString();
  const _prefix = `[${timestamp}] [AccountManager]`;

  switch (level) {
    case "error":
      break;
    case "warn":
      break;
    default:
  }
}
