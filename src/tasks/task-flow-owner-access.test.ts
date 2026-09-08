// Verifies task-flow owner access checks for parent and child sessions.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "./task-flow-owner-access.js";
import { createManagedTaskFlow as createManagedTaskFlowOrNull } from "./task-flow-registry.js";
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

beforeEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
  configureTaskFlowRegistryRuntime({
    store: {
      loadSnapshot: () => ({ flows: new Map() }),
      upsertFlow: () => {},
      deleteFlow: () => {},
    },
  });
});

afterEach(() => {
  resetTaskFlowRegistryForTests({ persist: false });
});

describe("task flow owner access", () => {
  it("returns owner-scoped flows and resolves owner keys to live work", () => {
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
      status: "succeeded",
      createdAt: 200,
      updatedAt: 200,
      endedAt: 200,
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
    ).toBe(older.flowId);
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
});
