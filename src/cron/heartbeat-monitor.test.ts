import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "./heartbeat-monitor.js";
import type { CronJob, CronJobCreate } from "./types.js";

function monitorJob(input: CronJobCreate, id = `job-${input.agentId}`): CronJob {
  return {
    ...input,
    id,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  } as CronJob;
}

describe("heartbeat monitor desired-state planning", () => {
  it("creates no monitor jobs for an ownerless explicit multi-agent roster", () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    } as OpenClawConfig;

    expect(resolveHeartbeatMonitorPlan(cfg, [], { schedulerSeed: "test-seed" }).specs).toEqual([]);
  });

  it("plans changed monitors once without adopting colliding user jobs", () => {
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "15m" } },
        list: [{ id: "main" }, { id: "ops" }, { id: "new" }],
      },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const initial = resolveHeartbeatMonitorPlan(cfg, [], options).specs;
    const main = initial.find((spec) => spec.agentId === "main");
    const ops = initial.find((spec) => spec.agentId === "ops");
    if (!main || !ops) {
      throw new Error("expected configured heartbeat monitor specs");
    }
    const jobs = [
      monitorJob(main.input),
      monitorJob({ ...ops.input, enabled: false }),
      monitorJob({ ...main.input, agentId: "stale", declarationKey: "heartbeat:stale" }),
      monitorJob({
        ...main.input,
        agentId: "collider",
        declarationKey: "heartbeat:collider",
        payload: { kind: "systemEvent", text: "user-owned" },
      }),
    ];

    const plan = resolveHeartbeatMonitorPlan(cfg, jobs, options);

    expect(plan.changes.map(({ kind, agentId }) => ({ kind, agentId }))).toEqual([
      { kind: "update", agentId: "ops" },
      { kind: "create", agentId: "new" },
      { kind: "remove", agentId: "stale" },
    ]);
  });

  it("retains a disabled monitor and its existing cadence", () => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "0m" } } },
    } as OpenClawConfig;
    const input = resolveHeartbeatMonitorPlan(cfg, [], { schedulerSeed: "test-seed" }).specs[0]
      ?.input;
    if (!input) {
      throw new Error("expected a disabled heartbeat monitor");
    }
    const existing = monitorJob({
      ...input,
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
    });

    const plan = resolveHeartbeatMonitorPlan(cfg, [existing], { schedulerSeed: "test-seed" });

    expect(plan.changes).toEqual([
      expect.objectContaining({
        kind: "update",
        agentId: "main",
        input: expect.objectContaining({
          enabled: false,
          schedule: expect.objectContaining({ kind: "every", everyMs: 60_000 }),
        }),
      }),
    ]);
  });

  it("removes duplicate monitors before updating the retained row", () => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "15m" } } },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const input = resolveHeartbeatMonitorPlan(cfg, [], options).specs[0]?.input;
    if (!input) {
      throw new Error("expected configured heartbeat monitor spec");
    }
    const older = { ...monitorJob(input, "older"), updatedAtMs: 1 };
    const newer = {
      ...monitorJob({ ...input, enabled: false }, "newer"),
      updatedAtMs: 2,
    };

    const plan = resolveHeartbeatMonitorPlan(cfg, [older, newer], options);

    expect(plan.changes).toEqual([
      { kind: "remove", agentId: "main", job: older },
      expect.objectContaining({ kind: "update", agentId: "main" }),
    ]);
  });

  it.each([
    { field: "name", value: "stale-name", changes: ["update"] },
    { field: "agentId", value: "stale-agent", changes: ["update"] },
    { field: "sessionTarget", value: "isolated", changes: ["update"] },
    { field: "wakeMode", value: "now", changes: ["update"] },
    { field: "declarationKey", value: "heartbeat:stale", changes: ["create", "remove"] },
  ] as const)("repairs a monitor with drifted $field", ({ field, value, changes }) => {
    const cfg = {
      agents: { defaults: { heartbeat: { every: "15m" } } },
    } as OpenClawConfig;
    const options = { schedulerSeed: "test-seed" };
    const input = resolveHeartbeatMonitorPlan(cfg, [], options).specs[0]?.input;
    if (!input) {
      throw new Error("expected configured heartbeat monitor spec");
    }

    const plan = resolveHeartbeatMonitorPlan(
      cfg,
      [monitorJob({ ...input, [field]: value })],
      options,
    );

    expect(plan.changes.map((change) => change.kind)).toEqual(changes);
  });
});
