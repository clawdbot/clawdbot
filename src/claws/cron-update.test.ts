import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawCronUpdate } from "./cron-update.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  clawCronGatewayInput,
  readClawCronRefs,
  upsertClawCronRef,
  type PersistedClawCronRef,
} from "./cron.js";
import { CLAW_OUTPUT_STABILITY, type ClawCronJob, type ClawManifest } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

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
  return cronJobReadView({
    ...normalized,
    id: value.schedulerJobId,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: { nextRunAtMs: 100, lastRunAtMs: 50, lastStatus: "ok" },
  });
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
    readiness: { ready: true, requirements: [] },
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
  it.each(["add", "change"] as const)(
    "preserves ownership before a failed readiness wait and permits %s retry",
    async (action) => {
      const env = { OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-readiness-"), "state") };
      const previous = ref(oldDaily, "scheduler-daily");
      if (action === "change") {
        upsertClawCronRef(previous, { env });
      }
      readClawCronRefs("worker", { env });
      const database = openOpenClawStateDatabase({ env });
      const rows = () =>
        JSON.stringify(
          database.db.prepare("SELECT * FROM claw_cron_refs ORDER BY agent_id, manifest_id").all(),
        );
      const before = rows();
      const order: string[] = [];
      const waitUntilAgentAvailable = vi.fn(async () => {
        order.push("wait");
      });
      waitUntilAgentAvailable.mockImplementationOnce(async () => {
        order.push("wait");
        throw new Error("agent not ready");
      });
      const add = vi.fn(async () => ({ id: "scheduler-daily" }));
      const remove = vi.fn();
      const options = {
        env,
        cronGateway: {
          add,
          remove,
          waitUntilAgentAvailable,
          get: async () => {
            order.push("get");
            return cronReadView("worker", previous);
          },
        },
      };
      const updatePlan = plan([
        {
          kind: "cronJob",
          id: "daily",
          action,
          target: "claw:worker:daily",
          blocked: false,
          reason: "target declaration",
        },
      ]);

      await expect(applyClawCronUpdate(updatePlan, manifest(), options)).rejects.toMatchObject({
        message: "agent not ready",
        partial: false,
      });
      expect(order).toEqual(action === "change" ? ["get", "wait"] : ["wait"]);
      expect(add).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(rows()).toBe(before);

      await expect(applyClawCronUpdate(updatePlan, manifest(), options)).resolves.toMatchObject({
        appliedIds: ["daily"],
      });
      expect(add).toHaveBeenCalledOnce();
      expect(readClawCronRefs("worker", { env })).toMatchObject([
        {
          manifestId: "daily",
          status: "complete",
          schedulerJobId: "scheduler-daily",
          job: newDaily,
        },
      ]);
    },
  );

  it("compensates an earlier removal when later readiness fails without introducing a pending addition", async () => {
    const env = {
      OPENCLAW_STATE_DIR: join(tempDirs.make("openclaw-cron-readiness-undo-"), "state"),
    };
    const previous = ref(legacy, "scheduler-legacy");
    upsertClawCronRef(previous, { env });
    const waitUntilAgentAvailable = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("agent not ready"));
    const add = vi.fn(async () => ({ id: "scheduler-restored" }));
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
          env,
          nowMs: 20,
          cronGateway: {
            add,
            remove,
            get: async () => cronReadView("worker", previous),
            waitUntilAgentAvailable,
          },
        },
      ),
    ).rejects.toMatchObject({ message: "agent not ready", partial: false });

    expect(remove).toHaveBeenCalledExactlyOnceWith("scheduler-legacy");
    expect(waitUntilAgentAvailable).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledExactlyOnceWith(clawCronGatewayInput("worker", previous));
    expect(readClawCronRefs("worker", { env })).toEqual([
      { ...previous, schedulerJobId: "scheduler-restored", updatedAtMs: 20 },
    ]);
  });

  it("converges changes and reverses add, change, and remove operations", async () => {
    let agentAvailable = false;
    const waitUntilAgentAvailable = vi.fn(async (agentId: string) => {
      expect(agentId).toBe("worker");
      agentAvailable = true;
    });
    const add = vi.fn(async (input: Record<string, unknown>) => {
      expect(agentAvailable).toBe(true);
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
          waitUntilAgentAvailable,
          get: async (id) =>
            cronReadView(
              "worker",
              refs.find((item) => item.schedulerJobId === id)!,
            ),
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
    expect(waitUntilAgentAvailable).toHaveBeenCalledOnce();
  });

  it("removes without waiting and checks availability before compensating add", async () => {
    const previous = ref(legacy, "scheduler-legacy");
    const waitUntilAgentAvailable = vi.fn(async () => undefined);
    const add = vi.fn(async () => {
      expect(waitUntilAgentAvailable).toHaveBeenCalledWith("worker");
      return { id: "scheduler-restored" };
    });
    const upsertRef = vi.fn();
    const execution = await applyClawCronUpdate(
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
          add,
          get: async () => cronReadView("worker", previous),
          remove: vi.fn(),
          waitUntilAgentAvailable,
        },
        readRefs: () => [previous],
        upsertRef,
        deleteRef: vi.fn(),
      },
    );
    expect(execution.appliedIds).toEqual(["legacy"]);
    expect(waitUntilAgentAvailable).not.toHaveBeenCalled();
    await execution.rollback();
    expect(add).toHaveBeenCalledOnce();
    expect(upsertRef).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "complete", schedulerJobId: "scheduler-restored" }),
      expect.any(Object),
    );
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
