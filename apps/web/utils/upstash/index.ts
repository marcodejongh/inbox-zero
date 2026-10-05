import { Client, type FlowControl, type HeadersInit } from "@upstash/qstash";
import { after } from "next/server";
import PQueue from "p-queue";
import { getInternalApiHeaders, getInternalApiUrl } from "@/utils/internal-api";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { isSafeExternalHttpUrl } from "@inboxzero/network/safe-url";
import { sleep } from "@/utils/sleep";

const logger = createScopedLogger("upstash");

// QStash reports the delivery attempt in this header; the fallback queue does
// the same so handlers can tell a final attempt from one that will be retried.
export const QSTASH_RETRIED_HEADER = "Upstash-Retried";

const FALLBACK_QUEUE_RETRY_DELAY_MS = 15_000;

// Stands in for QStash queue parallelism when QStash is not configured.
const fallbackQueues = new Map<string, PQueue>();

type PublishToQstashOptions = {
  destinationUrl?: string;
};

function getQstashClient(callbackUrl: string = getQstashCallbackBaseUrl()) {
  if (!env.QSTASH_TOKEN) return null;
  if (!isSafeExternalHttpUrl(callbackUrl)) {
    logger.warn(
      "Qstash callback URL is not externally reachable; using fallback",
      {
        qstashCallbackUrl: callbackUrl,
      },
    );
    return null;
  }
  return new Client({ token: env.QSTASH_TOKEN });
}

export async function publishToQstash<T>(
  path: string,
  body: T,
  flowControl?: FlowControl,
  headers?: HeadersInit,
  options?: PublishToQstashOptions,
) {
  const requestHeaders = createHeaders(headers);
  requestHeaders.set("Retry-After", "10");

  const qstashUrl =
    options?.destinationUrl ?? `${getQstashCallbackBaseUrl()}${path}`;
  const client = getQstashClient(qstashUrl);
  if (client) {
    return client.publishJSON({
      url: qstashUrl,
      body,
      flowControl,
      retries: 3,
      headers: requestHeaders,
    });
  }

  const fallbackUrl =
    options?.destinationUrl ?? `${getInternalApiUrl()}${path}`;
  return fallbackPublishToQstash(
    fallbackUrl,
    body,
    requestHeaders,
    !options?.destinationUrl,
  );
}

/**
 * Delivers `body` to `path` no earlier than `notBefore`. Resolves `false` when
 * QStash is unavailable, so callers keep their own fallback, such as the cron.
 */
export async function publishToQstashAt<T>({
  path,
  body,
  notBefore,
  deduplicationId,
}: {
  path: string;
  body: T;
  notBefore: Date;
  deduplicationId: string;
}) {
  const url = `${getQstashCallbackBaseUrl()}${path}`;
  const client = getQstashClient(url);
  if (!client) return false;
  await client.publishJSON({
    url,
    body,
    notBefore: Math.ceil(notBefore.getTime() / 1000),
    deduplicationId,
    retries: 3,
  });
  return true;
}

export async function bulkPublishToQstash<T>({
  items,
}: {
  items: {
    path: string;
    body: T;
    flowControl?: FlowControl;
  }[];
}) {
  const client = getQstashClient();
  if (client) {
    const callbackBase = getQstashCallbackBaseUrl();
    const qstashItems = items.map((item) => ({
      ...item,
      url: `${callbackBase}${item.path}`,
      path: undefined,
    }));

    await client.batchJSON(qstashItems);
    return;
  }

  const internalBase = getInternalApiUrl();
  for (const item of items) {
    await fallbackPublishToQstash(
      `${internalBase}${item.path}`,
      item.body,
      undefined,
    );
  }
}

export async function publishToQstashQueue<T>({
  queueName,
  parallelism,
  path,
  body,
  headers,
  deduplicationId,
  retries,
}: {
  queueName: string;
  parallelism: number;
  path: string;
  body: T;
  headers?: HeadersInit;
  deduplicationId?: string;
  retries?: number;
}) {
  const client = getQstashClient();
  if (client) {
    const qstashUrl = `${getQstashCallbackBaseUrl()}${path}`;

    try {
      const queue = client.queue({ queueName });
      await queue.upsert({ parallelism });
      return await queue.enqueueJSON({
        url: qstashUrl,
        body,
        headers,
        deduplicationId,
        retries,
      });
    } catch (error) {
      logger.error("Failed to publish to Qstash queue", {
        qstashUrl,
        queueName,
        error,
      });
      throw error;
    }
  }

  return publishToFallbackQueue<T>({
    queueName,
    parallelism,
    url: `${getInternalApiUrl()}${path}`,
    body,
    headers,
    retries,
  });
}

export async function publishToInternalApiInBackground<T>({
  path,
  body,
  headers,
}: {
  path: string;
  body: T;
  headers?: HeadersInit;
}) {
  const fallbackUrl = `${getInternalApiUrl()}${path}`;
  return fallbackPublishToQstash<T>(fallbackUrl, body, headers);
}

async function fallbackPublishToQstash<T>(
  url: string,
  body: T,
  headers?: HeadersInit,
  includeInternalApiHeaders = true,
) {
  logger.warn("Qstash client not found");

  const internalHeaders = createFallbackHeaders(
    headers,
    includeInternalApiHeaders,
  );

  after(async () => {
    try {
      await fetch(url, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify(body),
      });
    } catch (error) {
      logger.error("Fallback QStash fetch failed", { url, error });
    }
  });
}

function publishToFallbackQueue<T>({
  queueName,
  parallelism,
  url,
  body,
  headers,
  retries = 0,
}: {
  queueName: string;
  parallelism: number;
  url: string;
  body: T;
  headers?: HeadersInit;
  retries?: number;
}) {
  logger.warn("Qstash client not found");

  const requestHeaders = createFallbackHeaders(headers, true);
  const queue =
    fallbackQueues.get(queueName) ?? new PQueue({ concurrency: parallelism });
  fallbackQueues.set(queueName, queue);

  after(async () => {
    await queue.add(async () => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        // The slot stays held while waiting, so a struggling backend gets
        // less traffic, not the same burst again.
        if (attempt > 0)
          await sleep(FALLBACK_QUEUE_RETRY_DELAY_MS * 4 ** (attempt - 1));

        requestHeaders.set(QSTASH_RETRIED_HEADER, String(attempt));
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(body),
          });
          if (response.ok) return;
          logger.warn("Fallback queue delivery failed", {
            url,
            queueName,
            status: response.status,
            attempt,
            retries,
          });
        } catch (error) {
          logger.error("Fallback QStash fetch failed", { url, error });
        }
      }
    });

    if (queue.size === 0 && queue.pending === 0)
      fallbackQueues.delete(queueName);
  });
}

function createFallbackHeaders(
  headers: HeadersInit | undefined,
  includeInternalApiHeaders: boolean,
) {
  const fallbackHeaders = createHeaders(headers);
  fallbackHeaders.set("Content-Type", "application/json");
  if (includeInternalApiHeaders) {
    for (const [key, value] of Object.entries(getInternalApiHeaders())) {
      fallbackHeaders.set(key, value);
    }
  }
  return fallbackHeaders;
}

export async function listQueues() {
  const client = getQstashClient();
  if (client) {
    return await client.queue().list();
  }
  return [];
}

export async function deleteQueue(queueName: string) {
  const client = getQstashClient();
  if (client) {
    logger.info("Deleting queue", { queueName });
    await client.queue({ queueName }).delete();
  }
}

function normalizeBaseUrl(url: string) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function getQstashCallbackBaseUrl() {
  const candidateUrls = [
    env.INTERNAL_API_URL,
    env.WEBHOOK_URL,
    env.NEXT_PUBLIC_BASE_URL,
  ].filter((value): value is string => Boolean(value));

  const safeExternalUrl = candidateUrls.find((value) =>
    isSafeExternalHttpUrl(value),
  );
  if (safeExternalUrl) return normalizeBaseUrl(safeExternalUrl);

  return normalizeBaseUrl(getInternalApiUrl());
}

function createHeaders(headers?: HeadersInit) {
  if (headers && Symbol.iterator in headers) {
    return new Headers(Array.from(headers));
  }

  return new Headers(headers);
}
