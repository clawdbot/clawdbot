import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findLatestTaskFlowForOwner,
  getTaskFlowByIdForOwner,
  listTaskFlowsForOwner,
  resolveTaskFlowForLookupTokenForOwner,
} from "./task-flow-owner-access.js";
import { createManagedTaskFlow, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { configureTaskFlowRegistryRuntime } from "./task-flow-registry.store.js";

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
});
