// Qa Lab tests cover cron run wait plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveCronRunPollIntervalMs, waitForCronRunCompletion } from "./cron-run-wait.js";

describe("waitForCronRunCompletion", () => {
  it("ignores older entries and returns the newly finished run", async () => {
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockResolvedValueOnce({
        entries: [{ ts: 100, status: "ok", summary: "older run" }],
      })
      .mockResolvedValueOnce({
        entries: [{ ts: 180, status: "ok", summary: "new run" }],
      });

    const result = await waitForCronRunCompletion({
      callGateway,
      jobId: "dreaming-job",
      afterTs: 150,
      timeoutMs: 100,
      intervalMs: 0,
    });

    expect(result).toEqual({ ts: 180, status: "ok", summary: "new run" });
    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      "cron.runs",
      { id: "dreaming-job", limit: 20, sortDir: "desc" },
      { timeoutMs: 100 },
    );
  });

  it("surfaces recent run history on timeout", async () => {
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockResolvedValue({
        entries: [{ ts: 100, status: "ok", summary: "older run" }],
      });

    await expect(
      waitForCronRunCompletion({
        callGateway,
        jobId: "dreaming-job",
        afterTs: 150,
        timeoutMs: 5,
        intervalMs: 0,
      }),
    ).rejects.toThrow(/timed out waiting for cron run completion/);
  });

  it("clamps oversized poll intervals before sleeping", () => {
    expect(resolveCronRunPollIntervalMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps oversized poll intervals within the overall timeout", async () => {
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockResolvedValue({
        entries: [{ ts: 100, status: "ok", summary: "older run" }],
      });

    await expect(
      waitForCronRunCompletion({
        callGateway,
        jobId: "dreaming-job",
        afterTs: 150,
        timeoutMs: 5,
        intervalMs: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toThrow(/timed out waiting for cron run completion/);
  });
});
