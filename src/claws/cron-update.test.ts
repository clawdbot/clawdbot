import { describe, expect, it, vi } from "vitest";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { applyClawCronUpdate } from "./cron-update.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayInput,
  type PersistedClawCronRef,
} from "./cron.js";
import { CLAW_OUTPUT_STABILITY, type ClawCronJob, type ClawManifest } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

const oldDaily: ClawCronJob = {
  id: "daily",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  session: "main",
  message: "Old daily",
};
const newDaily: ClawCronJob = { ...oldDaily, message: "New daily" };
const legacy: ClawCronJob = {
  id: "legacy",
  schedule: { cron: "0 8 * * *", timezone: "UTC" },
  session: "isolated",
  message: "Legacy",
};
const weekly: ClawCronJob = {
  id: "weekly",
  schedule: { cron: "0 9 * * 1", timezone: "UTC" },
  session: "main",
  message: "Weekly",
};

function ref(job: ClawCronJob, schedulerJobId: string): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: "worker",
    manifestId: job.id,
    declarationKey: `claw:worker:${job.id}`,
    schedulerJobId,
    status: "complete",
    job,
    createdAtMs: 10,
    updatedAtMs: 10,
  };
}

function cronReadView(agentId: string, value: PersistedClawCronRef) {
  const normalized = normalizeCronJobCreate(clawCronGatewayInput(agentId, value));
  if (!normalized || !value.schedulerJobId) {
    throw new Error("expected complete cron provenance");
  }
  return {
    ...normalized,
    id: value.schedulerJobId,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  };
}

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:old" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:new" },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: actions.filter((action) => action.action === "change").length,
      removed: actions.filter((action) => action.action === "remove").length,
      released: actions.filter((action) => action.action === "release").length,
      unchanged: 0,
      manual: 0,
      blocked: 0,
      capabilityChanges: 0,
      capabilityEscalations: 0,
    },
    actions,
    capabilityChanges: [],
    blockers: [],
    diagnostics: [],
  };
}

function manifest(): ClawManifest {
  return {
    schemaVersion: 1,
    agent: { id: "worker" },
    workspace: { bootstrapFiles: {}, files: [] },
    packages: [],
    mcpServers: {},
    cronJobs: [newDaily, weekly],
  };
}

describe("applyClawCronUpdate", () => {
  it("converges changes and reverses add, change, and remove operations", async () => {
    const add = vi.fn(async (input: Record<string, unknown>) => {
      const key = input.declarationKey;
      if (key === "claw:worker:daily") {
        return { id: "scheduler-daily" };
      }
      if (key === "claw:worker:legacy") {
        return { id: "scheduler-legacy-restored" };
      }
      return { id: "scheduler-weekly" };
    });
    const remove = vi.fn(async () => ({ ok: true }));
    const upsertRef = vi.fn();
    const deleteRef = vi.fn();
    const refs = [ref(oldDaily, "scheduler-daily"), ref(legacy, "scheduler-legacy")];
    const execution = await applyClawCronUpdate(
      plan([
        {
          kind: "cronJob",
          id: "daily",
          action: "change",
          target: "scheduler-daily",
          blocked: false,
          reason: "changed",
        },
        {
          kind: "cronJob",
          id: "weekly",
          action: "add",
          target: "claw:worker:weekly",
          blocked: false,
          reason: "added",
        },
        {
          kind: "cronJob",
          id: "legacy",
          action: "remove",
          target: "scheduler-legacy",
          blocked: false,
          reason: "removed",
        },
      ]),
      manifest(),
      {
        cronGateway: {
          add,
          get: async (id) =>
            cronReadView("worker", refs.find((item) => item.schedulerJobId === id)!),
          remove,
        },
        readRefs: () => refs,
        upsertRef,
        deleteRef,
        nowMs: 20,
      },
    );

    expect(execution.appliedIds).toEqual(["daily", "weekly", "legacy"]);
    expect(remove).toHaveBeenCalledWith("scheduler-legacy");
    expect(upsertRef).toHaveBeenCalledTimes(5);
    expect(deleteRef).toHaveBeenCalledTimes(1);

    await execution.rollback();

    expect(remove).toHaveBeenCalledWith("scheduler-weekly");
    expect(add).toHaveBeenCalledTimes(4);
    expect(upsertRef).toHaveBeenCalledTimes(7);
    expect(deleteRef).toHaveBeenCalledTimes(2);
  });

  it("removes a non-converged replacement and fails closed", async () => {
    const remove = vi.fn(async () => ({ ok: true }));
    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "daily",
            action: "change",
            target: "scheduler-daily",
            blocked: false,
            reason: "changed",
          },
        ]),
        manifest(),
        {
          cronGateway: {
            add: async () => ({ id: "unexpected-copy" }),
            get: async () => cronReadView("worker", ref(oldDaily, "scheduler-daily")),
            remove,
          },
          readRefs: () => [ref(oldDaily, "scheduler-daily")],
          upsertRef: vi.fn(),
        },
      ),
    ).rejects.toThrow("did not converge");
    expect(remove).toHaveBeenCalledWith("unexpected-copy");
  });

  it("marks a thrown gateway mutation as uncertain", async () => {
    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "weekly",
            action: "add",
            target: "claw:worker:weekly",
            blocked: false,
            reason: "added",
          },
        ]),
        manifest(),
        {
          cronGateway: {
            add: async () => {
              throw new Error("connection lost");
            },
            get: vi.fn(),
            remove: vi.fn(),
          },
          readRefs: () => [],
          upsertRef: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({ partial: true });
  });

  it("rejects a live cron definition changed after planning", async () => {
    const remove = vi.fn();
    await expect(
      applyClawCronUpdate(
        plan([
          {
            kind: "cronJob",
            id: "legacy",
            action: "remove",
            target: "scheduler-legacy",
            blocked: false,
            reason: "removed",
          },
        ]),
        manifest(),
        {
          cronGateway: {
            add: vi.fn(),
            get: async () => ({
              ...cronReadView("worker", ref(legacy, "scheduler-legacy")),
              payload: { kind: "agentTurn", message: "Operator edit" },
            }),
            remove,
          },
          readRefs: () => [ref(legacy, "scheduler-legacy")],
        },
      ),
    ).rejects.toThrow("changed after planning");
    expect(remove).not.toHaveBeenCalled();
  });
});
