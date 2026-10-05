import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "@/utils/logger";

const DEFAULT_RUNNING_WARN_AFTER_MS = 10_000;
const DEFAULT_SLOW_WARN_AFTER_MS = 3000;

type RequestTimer = ReturnType<typeof startRequestTimer>;

const requestTimerStorage = new AsyncLocalStorage<RequestTimer>();

export function startRequestTimer({
  logger,
  requestName,
  runningWarnAfterMs = DEFAULT_RUNNING_WARN_AFTER_MS,
  slowWarnAfterMs = DEFAULT_SLOW_WARN_AFTER_MS,
}: {
  logger: Logger;
  requestName: string;
  runningWarnAfterMs?: number;
  slowWarnAfterMs?: number;
}) {
  const startedAt = Date.now();
  const stageDurationsMs: Record<string, number> = {};
  // Provider requests run in parallel, so these sums can exceed the wall time.
  const provider = { requests: 0, queueWaitMs: 0, requestMs: 0 };
  const runningTimeout = setTimeout(() => {
    logger.warn(`${requestName} still running`, {
      elapsedMs: Date.now() - startedAt,
    });
  }, runningWarnAfterMs);

  return {
    durationMs: () => Date.now() - startedAt,
    recordStage: (stage: string, durationMs: number) => {
      stageDurationsMs[stage] = (stageDurationsMs[stage] ?? 0) + durationMs;
    },
    recordProviderRequest: ({
      queueWaitMs,
      durationMs,
    }: {
      queueWaitMs: number;
      durationMs: number;
    }) => {
      provider.requests++;
      provider.queueWaitMs += queueWaitMs;
      provider.requestMs += durationMs;
    },
    logSlowCompletion: (metadata?: Record<string, unknown>) => {
      const durationMs = Date.now() - startedAt;
      if (durationMs > slowWarnAfterMs) {
        logger.warn(`${requestName} completed slowly`, {
          durationMs,
          stageDurationsMs,
          ...(provider.requests ? { provider } : {}),
          ...metadata,
        });
      }
      return durationMs;
    },
    stop: () => clearTimeout(runningTimeout),
  };
}

export function runWithRequestTimer<T>(
  timer: RequestTimer | undefined,
  operation: () => T,
): T {
  return timer ? requestTimerStorage.run(timer, operation) : operation();
}

export async function measureRequestStage<T>(
  stage: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await operation();
  } finally {
    requestTimerStorage.getStore()?.recordStage(stage, Date.now() - startedAt);
  }
}

export function recordProviderRequest(timing: {
  queueWaitMs: number;
  durationMs: number;
}) {
  requestTimerStorage.getStore()?.recordProviderRequest(timing);
}
