import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import type { CronJobCreate, CronJobPatch, CronPacing } from "../types.js";
import { add, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pacing-ops" });
const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function makeInput(pacing: CronPacing): CronJobCreate {
  return {
    name: "paced job",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    pacing,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "check" },
  };
}

async function withState(run: (state: ReturnType<typeof createCronServiceState>) => Promise<void>) {
  const { storePath } = await makeStorePath();
  await withEnvAsync({ OPENCLAW_STATE_DIR: path.dirname(path.dirname(storePath)) }, async () => {
    await run(
      createCronServiceState({
        storePath,
        cronEnabled: true,
        log: logger,
        nowMs: () => NOW,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      }),
    );
  });
}

describe("cron pacing validation", () => {
  it("accepts duration strings on create and update", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m", max: "4h" }));
      expect(job.pacing).toEqual({ min: "15m", max: "4h" });

      const updated = await update(state, job.id, { pacing: { min: "30m", max: "2h" } });
      expect(updated.pacing).toEqual({ min: "30m", max: "2h" });
    });
  });

  it.each([
    ["no bounds", {}, /pacing requires at least one of min or max/],
    ["zero minimum", { min: "0s" }, /pacing min must be a positive duration/],
    ["negative maximum", { max: "-1m" }, /pacing max must be a positive duration/],
    ["minimum above maximum", { min: "4h", max: "15m" }, /pacing min must not exceed max/],
  ] as const)("rejects %s on create", async (_label, pacing, error) => {
    await withState(async (state) => {
      await expect(add(state, makeInput(pacing))).rejects.toThrow(error);
    });
  });

  it("rejects invalid pacing on update without changing the stored job", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));

      await expect(update(state, job.id, { pacing: { max: "0m" } })).rejects.toThrow(
        "cron pacing max must be a positive duration",
      );
      expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });
    });
  });

  it("rejects empty pacing on update without changing the stored job", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));

      await expect(update(state, job.id, { pacing: {} })).rejects.toThrow(
        "cron pacing requires at least one of min or max",
      );
      expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });
    });
  });

  it("accepts a nullable pacing patch and clears pacing and its pending slot", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));
      job.state.nextRunAtMs = NOW + 4 * 60 * 60_000;
      job.state.pacedNextRunAtMs = job.state.nextRunAtMs;
      const patch = { pacing: null } satisfies CronJobPatch;

      const updated = await update(state, job.id, patch);

      expect(updated.pacing).toBeUndefined();
      expect(updated.state.nextRunAtMs).toBe(NOW + 60_000);
      expect(updated.state.pacedNextRunAtMs).toBeUndefined();
      expect(state.store?.jobs[0]?.pacing).toBeUndefined();
      expect(state.store?.jobs[0]?.state.pacedNextRunAtMs).toBeUndefined();
    });
  });

  it("preserves a pending paced slot on an unrelated edit", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ max: "4h" }));
      job.state.pacedNextRunAtMs = job.state.nextRunAtMs;

      const updated = await update(state, job.id, { description: "edited" });

      expect(updated.pacing).toEqual({ max: "4h" });
      expect(updated.state.nextRunAtMs).toBe(job.state.nextRunAtMs);
      expect(updated.state.pacedNextRunAtMs).toBe(job.state.pacedNextRunAtMs);
    });
  });

  it("recomputes the natural slot when pacing bounds change", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ max: "4h" }));
      job.state.nextRunAtMs = NOW + 4 * 60 * 60_000;
      job.state.pacedNextRunAtMs = job.state.nextRunAtMs;

      const updated = await update(state, job.id, { pacing: { max: "2h" } });

      expect(updated.state.nextRunAtMs).toBe(NOW + 60_000);
      expect(updated.state.pacedNextRunAtMs).toBeUndefined();
    });
  });

  it.each([
    { kind: "at" as const, at: "2026-07-19T12:00:00.000Z" },
    { kind: "on-exit" as const, command: "true" },
  ])("rejects pacing on a $kind one-shot", async (schedule) => {
    await withState(async (state) => {
      await expect(
        add(state, {
          ...makeInput({ min: "15m" }),
          schedule,
        }),
      ).rejects.toThrow("cron pacing requires an every or cron schedule");
    });
  });

  it("rejects converting a paced recurring job to a one-shot", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));

      await expect(
        update(state, job.id, {
          schedule: { kind: "at", at: "2026-07-19T12:00:00.000Z" },
        }),
      ).rejects.toThrow("cron pacing requires an every or cron schedule");
    });
  });
});
