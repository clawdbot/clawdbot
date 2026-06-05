// Memory Host SDK tests cover batch runner behavior.
import { describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../../gateway-client/src/timeouts.js";
import { buildEmbeddingBatchGroupOptions, runEmbeddingBatchGroups } from "./batch-runner.js";

describe("buildEmbeddingBatchGroupOptions", () => {
  it("clamps oversized embedding batch poll intervals to the timeout budget", () => {
    const options = buildEmbeddingBatchGroupOptions(
      {
        requests: ["request-1"],
        wait: true,
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 60_000,
        concurrency: 1,
      },
      {
        maxRequests: 100,
        debugLabel: "embedding batch submit",
      },
    );

    expect(options.pollIntervalMs).toBe(60_000);
  });

  it("passes clamped poll intervals into batch group runners", async () => {
    const runGroup = vi.fn(async () => {});

    await runEmbeddingBatchGroups({
      requests: ["request-1"],
      maxRequests: 100,
      wait: true,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
      timeoutMs: 60_000,
      concurrency: 1,
      debugLabel: "embedding batch submit",
      runGroup,
    });

    expect(runGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        pollIntervalMs: 60_000,
        timeoutMs: 60_000,
      }),
    );
  });

  it("keeps timeout-safe oversized embedding batch poll intervals bounded", () => {
    const options = buildEmbeddingBatchGroupOptions(
      {
        requests: ["request-1"],
        wait: true,
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: Number.MAX_SAFE_INTEGER,
        concurrency: 1,
      },
      {
        maxRequests: 100,
        debugLabel: "embedding batch submit",
      },
    );

    expect(options.pollIntervalMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});
