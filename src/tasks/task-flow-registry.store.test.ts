// Covers task-flow registry store persistence, events, and state queries.
import { statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  getTaskFlowById,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import {
  loadTaskFlowRegistryStateFromSqlite,
  saveTaskFlowRegistryStateToSqlite,
} from "./task-flow-registry.store.sqlite.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type TaskFlowRecord,
} from "./task-flow-registry.types.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

type TaskFlowRegistryTestDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;

function createStoredFlow(): TaskFlowRecord {
  return {
    flowId: "flow-restored",
    syncMode: "managed",
    ownerKey: "agent:main:main",
    controllerId: "tests/restored-controller",
    revision: 4,
    status: "blocked",
    notifyPolicy: "done_only",
    goal: "Restored flow",
    currentStep: "spawn_task",
    blockedTaskId: "task-restored",
    blockedSummary: "Writable session required.",
    stateJson: { lane: "triage", done: 3 },
    waitJson: { kind: "task", taskId: "task-restored" },
    cancelRequestedAt: 115,
    createdAt: 100,
    updatedAt: 120,
    endedAt: 120,
  };
}

async function withFlowRegistryTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    {
      layout: "state-only",
      prefix: "openclaw-task-flow-store-",
    },
    async (state) => {
      const root = state.stateDir;
      resetTaskFlowRegistryForTests();
      try {
        return await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => await run(root));
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("task-flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTaskFlowRegistryForTests();
  });

  it("uses the configured flow store for restore and save", () => {
    const storedFlow = createStoredFlow();
    const loadSnapshot = vi.fn(() => ({
      flows: new Map([[storedFlow.flowId, storedFlow]]),
    }));
    const saveSnapshot = vi.fn();
    configureTaskFlowRegistryRuntime({
      store: {
        loadSnapshot,
        saveSnapshot,
      },
    });

    const restored = getTaskFlowById("flow-restored");
    expect(restored?.flowId).toBe("flow-restored");
    expect(restored?.syncMode).toBe("managed");
    expect(restored?.controllerId).toBe("tests/restored-controller");
    expect(restored?.revision).toBe(4);
    expect(restored?.stateJson).toEqual({ lane: "triage", done: 3 });
    expect(restored?.waitJson).toEqual({ kind: "task", taskId: "task-restored" });
    expect(restored?.cancelRequestedAt).toBe(115);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/new-flow",
      goal: "New flow",
      status: "running",
      currentStep: "wait_for",
    });

    expect(saveSnapshot).toHaveBeenCalled();
    const latestCall = saveSnapshot.mock.calls[saveSnapshot.mock.calls.length - 1];
    if (!latestCall) {
      throw new Error("Expected task flow snapshot save call");
    }
    const latestSnapshot = latestCall[0] as {
      flows: ReadonlyMap<string, TaskFlowRecord>;
    };
    expect(latestSnapshot.flows.size).toBe(2);
    const restoredFlow = latestSnapshot.flows.get("flow-restored");
    if (!restoredFlow) {
      throw new Error("Expected restored task flow");
    }
    expect(restoredFlow.goal).toBe("Restored flow");
  });

  it("rejects invalid persisted flow enum values", () => {
    expect(parseOptionalTaskFlowSyncMode("managed")).toBe("managed");
    expect(parseOptionalTaskFlowSyncMode(null)).toBeUndefined();
    expect(parseTaskFlowStatus("waiting")).toBe("waiting");
    expect(parseTaskNotifyPolicy("state_changes")).toBe("state_changes");

    expect(() => parseOptionalTaskFlowSyncMode("legacy")).toThrow(
      "Invalid persisted task flow sync mode",
    );
    expect(() => parseTaskFlowStatus("done")).toThrow("Invalid persisted task flow status");
    expect(() => parseTaskNotifyPolicy("verbose")).toThrow("Invalid persisted task notify policy");
  });

  it("rejects corrupt persisted flow rows during sqlite restore", async () => {
    await withFlowRegistryTempDir(async () => {
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/corrupt-flow",
        goal: "Corrupt flow",
        status: "running",
      });

      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<TaskFlowRegistryTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.updateTable("flow_runs").set({ status: "done" }).where("flow_id", "=", created.flowId),
      );

      expect(() => loadTaskFlowRegistryStateFromSqlite()).toThrow(
        "Invalid persisted task flow status",
      );
    });
  });

  it("drops invalid requester origins during sqlite restore", async () => {
    await withFlowRegistryTempDir(async () => {
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/invalid-origin-flow",
        goal: "Invalid origin flow",
        requesterOrigin: {
          channel: "test-channel",
          to: "C1234567890",
        },
      });

      const database = openOpenClawStateDatabase();
      const db = getNodeSqliteKysely<TaskFlowRegistryTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("flow_runs")
          .set({ requester_origin_json: '{"channel":42}' })
          .where("flow_id", "=", created.flowId),
      );

      const restored = loadTaskFlowRegistryStateFromSqlite();
      expect(restored.flows.get(created.flowId)?.requesterOrigin).toBeUndefined();
    });
  });

  it("restores persisted wait-state, revision, and cancel intent from sqlite", async () => {
    await withFlowRegistryTempDir(async () => {
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/persisted-flow",
        goal: "Persisted flow",
        status: "running",
        currentStep: "spawn_task",
        stateJson: { phase: "spawn" },
      });
      const waiting = setFlowWaiting({
        flowId: created.flowId,
        expectedRevision: created.revision,
        currentStep: "ask_user",
        stateJson: { phase: "ask_user" },
        waitJson: { kind: "external_event", topic: "forum" },
      });
      expect(waiting.applied).toBe(true);
      if (!waiting.applied) {
        throw new Error("Expected wait state update to apply");
      }
      const cancelRequested = requestFlowCancel({
        flowId: created.flowId,
        expectedRevision: waiting.flow.revision,
        cancelRequestedAt: 444,
      });
      expect(cancelRequested.applied).toBe(true);

      resetTaskFlowRegistryForTests({ persist: false });

      const restored = getTaskFlowById(created.flowId);
      expect(restored?.flowId).toBe(created.flowId);
      expect(restored?.syncMode).toBe("managed");
      expect(restored?.controllerId).toBe("tests/persisted-flow");
      expect(restored?.revision).toBe(2);
      expect(restored?.status).toBe("waiting");
      expect(restored?.currentStep).toBe("ask_user");
      expect(restored?.stateJson).toEqual({ phase: "ask_user" });
      expect(restored?.waitJson).toEqual({ kind: "external_event", topic: "forum" });
      expect(restored?.cancelRequestedAt).toBe(444);
    });
  });

  it("round-trips explicit json null through sqlite", async () => {
    await withFlowRegistryTempDir(async () => {
      resetTaskFlowRegistryForTests();

      const created = createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/null-roundtrip",
        goal: "Persist null payloads",
        stateJson: null,
        waitJson: null,
      });

      resetTaskFlowRegistryForTests({ persist: false });

      const restored = getTaskFlowById(created.flowId);
      expect(restored?.flowId).toBe(created.flowId);
      expect(restored?.stateJson).toBeNull();
      expect(restored?.waitJson).toBeNull();
    });
  });

  it("prunes large sqlite snapshots without binding every flow id at once", async () => {
    await withFlowRegistryTempDir(async () => {
      resetTaskFlowRegistryForTests();

      const flows = new Map<string, TaskFlowRecord>();
      for (let index = 0; index < 1_200; index++) {
        const flow: TaskFlowRecord = {
          ...createStoredFlow(),
          flowId: `flow-large-${index}`,
          controllerId: `tests/large-flow-${index}`,
          createdAt: index,
          updatedAt: index,
        };
        flows.set(flow.flowId, flow);
      }

      saveTaskFlowRegistryStateToSqlite({ flows });
      const retainedFlows = new Map([...flows].slice(100));
      saveTaskFlowRegistryStateToSqlite({ flows: retainedFlows });

      const restored = loadTaskFlowRegistryStateFromSqlite();
      expect(restored.flows.size).toBe(1_100);
      expect(restored.flows.has("flow-large-0")).toBe(false);
      expect(restored.flows.has("flow-large-1199")).toBe(true);
    });
  });

  it("hardens the sqlite flow store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withFlowRegistryTempDir(async () => {
      resetTaskFlowRegistryForTests();

      createManagedTaskFlow({
        ownerKey: "agent:main:main",
        controllerId: "tests/secured-flow",
        goal: "Secured flow",
        status: "blocked",
        blockedTaskId: "task-secured",
        blockedSummary: "Need auth.",
        waitJson: { kind: "task", taskId: "task-secured" },
      });

      const databasePath = resolveOpenClawStateSqlitePath(process.env);
      const registryDir = path.dirname(databasePath);
      expect(databasePath.endsWith(path.join("state", "openclaw.sqlite"))).toBe(true);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    });
  });
});
