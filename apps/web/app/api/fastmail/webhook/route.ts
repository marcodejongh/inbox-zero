import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import { pollFastmailAccount } from "@/utils/fastmail/poll-sync";
import type { Logger } from "@/utils/logger";
import type { RequestWithLogger } from "@/utils/middleware";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes max

/**
 * Webhook payload schema for Fastmail push notifications.
 *
 * This endpoint is designed to work with:
 * 1. EventSource daemon (current) - separate process POSTs state changes here
 * 2. Future Fastmail PushSubscription (RFC 8620 section 7.2) - when Fastmail
 *    supports webhooks, they will POST directly to this endpoint
 */
const webhookPayloadSchema = z.object({
  emailAccountId: z.string().min(1),
  newState: z.string().optional(), // State token from JMAP EventSource
});

export type FastmailWebhookPayload = z.infer<typeof webhookPayloadSchema>;

/**
 * Validate the webhook secret from the Authorization header.
 */
function hasWebhookSecret(request: RequestWithLogger): boolean {
  if (!env.FASTMAIL_WEBHOOK_SECRET) {
    request.logger.error(
      "FASTMAIL_WEBHOOK_SECRET not set, rejecting webhook request",
    );
    return false;
  }

  const authHeader = request.headers.get("authorization");
  const valid = authHeader === `Bearer ${env.FASTMAIL_WEBHOOK_SECRET}`;

  if (!valid) {
    request.logger.error("Invalid webhook secret", { authHeader });
  }

  return valid;
}

export const POST = withError("fastmail/webhook", async (request) => {
  // Validate auth using dedicated webhook secret
  if (!hasWebhookSecret(request)) {
    captureException(
      new Error("Unauthorized fastmail webhook request: api/fastmail/webhook"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse and validate payload
  const body = await request.json();
  const parseResult = webhookPayloadSchema.safeParse(body);

  if (!parseResult.success) {
    request.logger.error("Invalid webhook payload", {
      errors: parseResult.error.errors,
    });
    return NextResponse.json(
      { error: "Invalid payload", details: parseResult.error.errors },
      { status: 400 },
    );
  }

  const { emailAccountId, newState } = parseResult.data;

  request.logger.info("Received Fastmail webhook - acknowledging immediately", {
    emailAccountId,
    newState,
  });

  // Process asynchronously using after() to respond quickly
  // This is important for the daemon to know the webhook was received
  after(() => processWebhookAsync(emailAccountId, newState, request.logger));

  return NextResponse.json({ success: true });
});

async function processWebhookAsync(
  emailAccountId: string,
  newState: string | undefined,
  logger: Logger,
) {
  const log = logger.with({
    emailAccountId,
    newState,
    action: "processWebhookAsync",
  });

  try {
    log.info("Processing Fastmail webhook");

    const result = await pollFastmailAccount({
      emailAccountId,
      logger: log,
      forceSync: true, // Skip the 2-minute cooldown since we know there's a change
    });

    log.info("Fastmail webhook processed", { result });
  } catch (error) {
    log.error("Failed to process Fastmail webhook", { error });
    captureException(error);
  }
}
