import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";

vi.mock("../../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pid-alive.js")>()),
  getFileLockProcessStartTime: () => null,
}));

const { prepareCronRunReceiptClaim } = await import("./run-receipt-store.js");

describe("cron run receipt process identity", () => {
  it("refuses a null-start-time owner so PID reuse cannot fence the job forever", () => {
    const job: CronJob = {
      id: "missing-process-incarnation",
      agentId: "main",
      name: "missing process incarnation",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "must not run" },
      state: {},
    };

    expect(() =>
      prepareCronRunReceiptClaim({
        storePath: "/tmp/null-start-time-cron.json",
        job,
        agentId: "main",
        startedAtMs: 10,
      }),
    ).toThrow("without process start identity");
  });
});
