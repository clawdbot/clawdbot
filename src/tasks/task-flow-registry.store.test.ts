import { statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  requestFlowCancel,
  resetTaskFlowRegistryForTests,
  setFlowWaiting,
} from "./task-flow-registry.js";
import {
  resolveTaskFlowRegistryDir,
  resolveTaskFlowRegistrySqlitePath,
} from "./task-flow-registry.paths.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";

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
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();
      try {
        return await run(root);
      } finally {
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function restoreOriginalStateDir(): void {
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
}

describe("task-flow-registry store runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreOriginalStateDir();
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

  it("restores persisted wait-state, revision, and cancel intent from sqlite", async () => {
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
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
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
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

  it("hardens the sqlite flow store directory and file modes", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withFlowRegistryTempDir(async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
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

      const registryDir = resolveTaskFlowRegistryDir(process.env);
      const sqlitePath = resolveTaskFlowRegistrySqlitePath(process.env);
      expect(statSync(registryDir).mode & 0o777).toBe(0o700);
      expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);
    });
  });
});
