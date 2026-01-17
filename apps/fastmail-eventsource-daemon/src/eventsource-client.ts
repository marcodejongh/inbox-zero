import { EventSource } from "eventsource";
import { env } from "./env.js";

/**
 * JMAP StateChange event structure per RFC 8620 section 7.1
 */
export interface JMAPStateChange {
  "@type": "StateChange";
  changed: Record<string, Record<string, string>>; // accountId -> { typeName: newState }
}

export interface EventSourceClientOptions {
  eventSourceUrl: string;
  accessToken: string;
  accountId: string;
  emailAccountId: string;
  onStateChange: (emailAccountId: string, newState: string) => void;
  onError?: (emailAccountId: string, error: Error) => void;
  onConnected?: (emailAccountId: string) => void;
  onDisconnected?: (emailAccountId: string) => void;
}

/**
 * JMAP EventSource client for Fastmail push notifications.
 *
 * Implements RFC 8620 section 7.3 EventSource push.
 * Connects to Fastmail's EventSource URL and receives real-time
 * notifications when email state changes.
 */
export class FastmailEventSourceClient {
  private eventSource: EventSource | null = null;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelay = 1000; // 1 second
  private readonly maxReconnectDelay = 300_000; // 5 minutes

  private readonly options: EventSourceClientOptions;

  constructor(options: EventSourceClientOptions) {
    this.options = options;
  }

  /**
   * Build the EventSource URL with required parameters.
   * Per RFC 8620 section 7.3:
   * - types: Comma-separated list of type names to receive updates for
   * - ping: Interval in seconds for server to send ping events
   */
  private buildUrl(): string {
    const url = new URL(this.options.eventSourceUrl);
    url.searchParams.set("types", "Email"); // Only subscribe to Email changes
    url.searchParams.set("ping", "60"); // Keepalive every 60 seconds
    return url.toString();
  }

  /**
   * Connect to the EventSource endpoint.
   */
  connect(): void {
    if (this.closed) {
      this.log("Client is closed, not connecting");
      return;
    }

    if (this.eventSource) {
      this.log("Already connected, disconnecting first");
      this.disconnect();
    }

    const url = this.buildUrl();
    this.log(`Connecting to EventSource: ${url}`);

    // Create custom fetch with auth header
    const accessToken = this.options.accessToken;
    const customFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${accessToken}`);
      return fetch(input, { ...init, headers });
    };

    this.eventSource = new EventSource(url, {
      fetch: customFetch,
    });

    this.eventSource.onopen = () => {
      this.log("EventSource connected");
      this.reconnectAttempts = 0;
      this.options.onConnected?.(this.options.emailAccountId);
    };

    this.eventSource.onerror = (_event: Event) => {
      this.log("EventSource error");

      // The eventsource package auto-reconnects, but we may want custom handling
      if (this.eventSource?.readyState === EventSource.CLOSED) {
        this.handleDisconnect();
      }
    };

    // Listen for 'state' events (JMAP state changes)
    this.eventSource.addEventListener("state", (event) => {
      this.handleStateEvent(event as MessageEvent);
    });

    // Listen for 'ping' events (keepalive)
    this.eventSource.addEventListener("ping", () => {
      this.log("Received ping");
    });
  }

  /**
   * Handle a state change event from the EventSource.
   */
  private handleStateEvent(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data) as JMAPStateChange;

      if (data["@type"] !== "StateChange") {
        this.log(`Unexpected event type: ${data["@type"]}`);
        return;
      }

      // Check if our account has Email state changes
      const accountChanges = data.changed[this.options.accountId];
      if (!accountChanges) {
        this.log("No changes for our account");
        return;
      }

      const emailState = accountChanges.Email;
      if (!emailState) {
        this.log("No Email state change");
        return;
      }

      this.log(`Email state changed to: ${emailState}`);
      this.options.onStateChange(this.options.emailAccountId, emailState);
    } catch (error) {
      this.log(`Error parsing state event: ${error}`);
      this.options.onError?.(
        this.options.emailAccountId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Handle disconnection and schedule reconnect.
   */
  private handleDisconnect(): void {
    this.options.onDisconnected?.(this.options.emailAccountId);

    if (this.closed) {
      this.log("Client is closed, not reconnecting");
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log(`Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      this.options.onError?.(
        this.options.emailAccountId,
        new Error("Max reconnect attempts reached"),
      );
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s... up to maxReconnectDelay
    const delay = Math.min(
      this.baseReconnectDelay * 2 ** this.reconnectAttempts,
      this.maxReconnectDelay,
    );

    this.reconnectAttempts++;
    this.log(
      `Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Disconnect from the EventSource.
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * Close the client permanently (no reconnection).
   */
  close(): void {
    this.closed = true;
    this.disconnect();
    this.log("Client closed");
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }

  /**
   * Update the access token (for token refresh).
   */
  updateAccessToken(newToken: string): void {
    const wasConnected = this.isConnected();
    this.disconnect();
    (this.options as { accessToken: string }).accessToken = newToken;
    if (wasConnected) {
      this.reconnectAttempts = 0; // Reset on token refresh
      this.connect();
    }
  }

  private log(_message: string): void {
    if (env.DEBUG) {
    }
  }
}
