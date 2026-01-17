import { env } from "./env.js";

/**
 * Webhook payload sent to the main application.
 */
export interface WebhookPayload {
  emailAccountId: string;
  newState?: string;
}

/**
 * Maximum number of retry attempts for webhook calls.
 */
const MAX_RETRIES = 3;

/**
 * Base delay in ms for exponential backoff.
 */
const BASE_RETRY_DELAY = 1000;

/**
 * Calls the main application's Fastmail webhook endpoint.
 *
 * This triggers the main app to poll the Fastmail account for new emails.
 * Uses exponential backoff retry on transient failures.
 */
export async function callWebhook(
  emailAccountId: string,
  newState?: string,
): Promise<boolean> {
  const webhookUrl = `${env.MAIN_APP_URL}/api/fastmail/webhook`;
  const payload: WebhookPayload = {
    emailAccountId,
    newState,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.FASTMAIL_WEBHOOK_SECRET}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        log(`Webhook called successfully for ${emailAccountId}`);
        return true;
      }

      // Non-retryable error
      if (response.status >= 400 && response.status < 500) {
        const errorText = await response.text();
        log(
          `Webhook call failed with ${response.status}: ${errorText}`,
          "error",
        );
        return false;
      }

      // Retryable error (5xx)
      log(
        `Webhook call failed with ${response.status}, attempt ${attempt + 1}/${MAX_RETRIES + 1}`,
        "warn",
      );
    } catch (error) {
      log(
        `Webhook call error: ${error}, attempt ${attempt + 1}/${MAX_RETRIES + 1}`,
        "error",
      );
    }

    // Wait before retry (exponential backoff)
    if (attempt < MAX_RETRIES) {
      const delay = BASE_RETRY_DELAY * 2 ** attempt;
      await sleep(delay);
    }
  }

  log(`Webhook call failed after ${MAX_RETRIES + 1} attempts`, "error");
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(
  _message: string,
  level: "info" | "warn" | "error" = "info",
): void {
  const timestamp = new Date().toISOString();
  const _prefix = `[${timestamp}] [WebhookCaller]`;

  switch (level) {
    case "error":
      break;
    case "warn":
      break;
    default:
      if (env.DEBUG) {
      }
  }
}
