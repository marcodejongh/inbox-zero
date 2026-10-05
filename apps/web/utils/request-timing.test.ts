import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  measureRequestStage,
  recordProviderRequest,
  runWithRequestTimer,
  startRequestTimer,
} from "./request-timing";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("request timing", () => {
  it("attributes a slow request to its stages and provider requests", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const timer = startRequestTimer({ logger, requestName: "threads request" });

    await runWithRequestTimer(timer, async () => {
      await measureRequestStage("fetch-threads", async () => {
        vi.advanceTimersByTime(3000);
        recordProviderRequest({ queueWaitMs: 1200, durationMs: 400 });
        recordProviderRequest({ queueWaitMs: 800, durationMs: 600 });
      });
      await measureRequestStage("load-executed-rules", async () => {
        vi.advanceTimersByTime(500);
      });
    });
    timer.logSlowCompletion();
    timer.stop();

    expect(warn).toHaveBeenCalledWith("threads request completed slowly", {
      durationMs: 3500,
      stageDurationsMs: { "fetch-threads": 3000, "load-executed-rules": 500 },
      provider: { requests: 2, queueWaitMs: 2000, requestMs: 1000 },
    });
  });

  it("stays quiet for fast requests and outside a timed request", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const timer = startRequestTimer({ logger, requestName: "threads request" });

    recordProviderRequest({ queueWaitMs: 5000, durationMs: 5000 });
    await expect(measureRequestStage("stage", async () => "ok")).resolves.toBe(
      "ok",
    );
    timer.logSlowCompletion();
    timer.stop();

    expect(warn).not.toHaveBeenCalled();
  });
});
