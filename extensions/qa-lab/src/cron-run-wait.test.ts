// Qa Lab tests cover cron run wait plugin behavior.
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

  it("allows live CLI scenarios to extend the gateway call deadline", async () => {
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockResolvedValue({ entries: [{ ts: 180, status: "ok" }] });

    await waitForCronRunCompletion({
      callGateway,
      jobId: "slow-cli-job",
      afterTs: 150,
      timeoutMs: 120_000,
      gatewayCallTimeoutMs: 90_000,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "cron.runs",
      { id: "slow-cli-job", limit: 20, sortDir: "desc" },
      { timeoutMs: 90_000 },
    );
  });

  it("caps each gateway call at the remaining overall deadline", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const callGateway = vi
      .fn<
        (method: string, rpcParams?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>
      >()
      .mockImplementationOnce(async () => {
        now = 1_080;
        return { entries: [{ ts: 100, status: "ok", summary: "older run" }] };
      })
      .mockResolvedValueOnce({ entries: [{ ts: 180, status: "ok" }] });

    try {
      await waitForCronRunCompletion({
        callGateway,
        jobId: "bounded-call-job",
        afterTs: 150,
        timeoutMs: 100,
        intervalMs: 0,
        gatewayCallTimeoutMs: 90,
      });

      expect(callGateway).toHaveBeenNthCalledWith(
        2,
        "cron.runs",
        { id: "bounded-call-job", limit: 20, sortDir: "desc" },
        { timeoutMs: 20 },
      );
    } finally {
      nowSpy.mockRestore();
    }
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
