import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { reconcileHeartbeatMonitorJobs } from "./server-cron-heartbeat-jobs.js";

const logger = { warn: vi.fn() };

type AddOptions = { matchesExisting?: (job: CronJob) => boolean };

function monitorJob(agentId: string, id = `job-${agentId}`): CronJob {
  return {
    id,
    declarationKey: `heartbeat:${agentId}`,
    name: `heartbeat-${agentId}`,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    agentId,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "heartbeat" },
    state: {},
  } as CronJob;
}

describe("reconcileHeartbeatMonitorJobs", () => {
  it("converges one monitor per heartbeat agent and prunes unconfigured ones", async () => {
    const add = vi.fn(async (input: { declarationKey?: string }, _options?: AddOptions) => ({
      job: input,
    }));
    const remove = vi.fn(async () => ({ ok: true }));
    const list = vi.fn(async () => [
      monitorJob("stale-agent"),
      {
        ...monitorJob("main"),
        id: "user-job",
        declarationKey: undefined,
        payload: { kind: "systemEvent", text: "user job" },
      } as CronJob,
      // Prefix collision without a heartbeat payload must never be pruned.
      {
        ...monitorJob("collider"),
        id: "prefix-collider",
        payload: { kind: "systemEvent", text: "not a monitor" },
      } as CronJob,
    ]);
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "15m" } },
        list: [{ id: "main" }, { id: "ops" }],
      },
    } as OpenClawConfig;

    await reconcileHeartbeatMonitorJobs({
      cron: { add, list, remove } as never,
      cfg,
      logger,
    });

    const declarationKeys = add.mock.calls.map(
      ([input]) => (input as { declarationKey?: string }).declarationKey,
    );
    expect(declarationKeys.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual([
      "heartbeat:main",
      "heartbeat:ops",
    ]);
    for (const [input] of add.mock.calls) {
      const spec = input as {
        payload: { kind: string };
        schedule: { kind: string; everyMs: number; anchorMs?: number };
        sessionTarget: string;
        enabled: boolean;
      };
      expect(spec.payload).toEqual({ kind: "heartbeat" });
      expect(spec.schedule.kind).toBe("every");
      expect(spec.schedule.everyMs).toBe(15 * 60_000);
      // Deterministic phase anchor spreads multi-agent beats inside the interval.
      expect(spec.schedule.anchorMs).toBeGreaterThanOrEqual(0);
      expect(spec.schedule.anchorMs).toBeLessThan(15 * 60_000);
      expect(spec.sessionTarget).toBe("main");
      expect(spec.enabled).toBe(true);
    }
    // Only the stale monitor is pruned; user jobs without the prefix survive.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("job-stale-agent", { systemOwned: true });
    // Declarative matching is scoped to real monitors so a colliding user job
    // is never adopted by the system upsert.
    for (const call of add.mock.calls) {
      const opts = call[1];
      if (!opts) {
        throw new Error("expected system-owned add options");
      }
      expect(opts.matchesExisting?.(monitorJob("x"))).toBe(true);
      expect(
        opts.matchesExisting?.({
          ...monitorJob("x"),
          payload: { kind: "systemEvent", text: "user" },
        } as CronJob),
      ).toBe(false);
    }
  });

  it("removes all monitors when heartbeats are disabled", async () => {
    const add = vi.fn(async () => ({}));
    const remove = vi.fn(async () => ({ ok: true }));
    const list = vi.fn(async () => [monitorJob("main")]);
    const cfg = {
      agents: { defaults: { heartbeat: { every: "0m" } } },
    } as OpenClawConfig;

    await reconcileHeartbeatMonitorJobs({
      cron: { add, list, remove } as never,
      cfg,
      logger,
    });

    expect(add).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("job-main", { systemOwned: true });
  });

  it("keeps converging other agents when one convergence fails", async () => {
    const add = vi.fn(async () => ({})).mockRejectedValueOnce(new Error("store busy"));
    const remove = vi.fn(async () => ({ ok: true }));
    const list = vi.fn(async () => []);
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [{ id: "a" }, { id: "b" }],
      },
    } as OpenClawConfig;

    await reconcileHeartbeatMonitorJobs({
      cron: { add, list, remove } as never,
      cfg,
      logger,
    });

    expect(add).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
