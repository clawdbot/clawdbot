// Verifies task-flow owner access checks for parent and child sessions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "./task-flow-owner-access.js";
import {
  createManagedTaskFlow as createManagedTaskFlowOrNull,
  finishFlow,
} from "./task-flow-registry.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
} from "./task-runtime.test-helpers.js";

function createManagedTaskFlow(
  params: Parameters<typeof createManagedTaskFlowOrNull>[0],
): TaskFlowRecord {
  const flow = createManagedTaskFlowOrNull(params);
  if (!flow) {
    throw new Error("expected managed TaskFlow creation to succeed");
  }
  return flow;
}

function requireAppliedFinish(flow: TaskFlowRecord): TaskFlowRecord {
  const result = finishFlow({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  });
  if (!result.applied) {
    throw new Error(`expected finishFlow to apply, got ${result.reason}`);
  }
  return result.flow;
}

beforeEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
  configureTaskFlowRegistryRuntime({
    store: {
      loadSnapshot: () => ({ flows: new Map() }),
      saveSnapshot: () => {},
      upsertFlow: () => {},
      deleteFlow: () => {},
    },
  });
});

afterEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("task flow owner access", () => {
  it("returns owner-scoped flows for direct and owner-key lookups", () => {
    const older = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Older flow",
      createdAt: 100,
      updatedAt: 100,
    });
    const latest = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Latest flow",
      createdAt: 200,
      updatedAt: 200,
    });

    expect(
      getTaskFlowByIdForOwner({
        flowId: older.flowId,
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(older.flowId);
    expect(
      findLatestTaskFlowForOwner({
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(latest.flowId);
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        token: "agent:main:main",
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(latest.flowId);
    expect(
      listTaskFlowsForOwner({
        callerOwnerKey: "agent:main:main",
      }).map((flow) => flow.flowId),
    ).toEqual([latest.flowId, older.flowId]);
  });

  it("denies cross-owner flow reads", () => {
    const flow = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Hidden flow",
    });

    expect(
      getTaskFlowByIdForOwner({
        flowId: flow.flowId,
        callerOwnerKey: "agent:main:other",
      }),
    ).toBeUndefined();
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        token: flow.flowId,
        callerOwnerKey: "agent:main:other",
      }),
    ).toBeUndefined();
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        token: "agent:main:main",
        callerOwnerKey: "agent:main:other",
      }),
    ).toBeUndefined();
    expect(
      listTaskFlowsForOwner({
        callerOwnerKey: "agent:main:other",
      }),
    ).toStrictEqual([]);
  });

  it("prefers the newest non-terminal flow for owner-key lookups", () => {
    const running = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Still running flow",
      status: "running",
      createdAt: 100,
      updatedAt: 100,
    });
    const newerTerminal = createManagedTaskFlow({
      ownerKey: "agent:main:main",
      controllerId: "tests/owner-access",
      goal: "Newer finished flow",
      status: "succeeded",
      createdAt: 200,
      updatedAt: 200,
    });

    // The newest flow is terminal, but the older flow is still active, so an
    // owner-key lookup must resolve to the running flow, not the finished one.
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        token: "agent:main:main",
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(running.flowId);
    expect(
      findLatestTaskFlowForOwner({
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(newerTerminal.flowId);

    // When every flow is terminal, the lookup falls back to the newest overall.
    const finished = requireAppliedFinish(running);
    expect(
      resolveTaskFlowForLookupTokenForOwner({
        token: "agent:main:main",
        callerOwnerKey: "agent:main:main",
      })?.flowId,
    ).toBe(newerTerminal.flowId);
    expect(finished.flowId).toBe(running.flowId);
  });
});
