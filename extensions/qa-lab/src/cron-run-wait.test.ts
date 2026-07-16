import { describe, expect, it, vi } from "vitest";
import { waitForCronRunCompletion } from "./cron-run-wait.js";

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

    expect(result).toMatchObject({ ts: 180, status: "ok", summary: "new run" });
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
});
