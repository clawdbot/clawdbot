/**
 * Trap test for the PendingContinuationDelegate mode-only compat boundary.
 *
 * Bug-shape / risk:
 *   The canonical runtime delegate shape is `PendingContinuationDelegate.mode`,
 *   while booleans are only an on-disk compatibility encoding. A future refactor
 *   can accidentally reintroduce `silent` / `silentWake` as runtime API fields
 *   without breaking today's behavior tests immediately.
 *
 * What this trap guards (load-bearing assertions):
 *   1. RUNTIME OBJECTS: `consumePendingDelegates` / `claimStagedPostCompactionTaskFlowDelegates`
 *      return objects whose only mode-bearing field is `mode`. They MUST NOT
 *      expose `silent` / `silentWake` / `postCompaction` boolean runtime flags.
 *   2. TOOL DESCRIPTOR: the `continue_delegate` parameter schema advertises
 *      `mode` as an enum (normal | silent | silent-wake | post-compaction)
 *      and exposes NO `silent` / `silentWake` boolean parameters.
 *   3. ON-DISK BACK-COMPAT: persisted TaskFlow `stateJson` MAY still contain
 *      legacy boolean flags (`silent`, `silentWake`, `postCompaction`). This is
 *      a positive assertion — the disk shape stays back-compat for historical
 *      rows — and is what justifies the runtime/disk encoding split.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the TaskFlow registry before importing the store. Identical fixture
// shape to delegate-store.test.ts so the runtime path is exercised through
// real production code, not stubs.
const mockFlows = new Map<string, Record<string, unknown>>();
let flowIdCounter = 0;

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn((params: Record<string, unknown>) => {
    const flowId = `flow-${++flowIdCounter}`;
    mockFlows.set(flowId, {
      flowId,
      syncMode: "managed",
      ownerKey: params.ownerKey,
      controllerId: params.controllerId,
      status: "queued",
      stateJson: params.stateJson,
      goal: params.goal,
      currentStep: params.currentStep,
      revision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return mockFlows.get(flowId);
  }),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
    [...mockFlows.values()].filter((f) => f.ownerKey === ownerKey),
  ),
  getTaskFlowById: vi.fn((flowId: string) => mockFlows.get(flowId)),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Record<string, unknown> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      Object.assign(flow, params.patch);
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn((params: { flowId: string }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import {
  claimStagedPostCompactionTaskFlowDelegates,
  stagePostCompactionTaskFlowDelegate,
} from "./delegate-store-post-compaction.js";
import { consumePendingDelegates, enqueuePendingDelegate } from "./delegate-store.js";
import type { PendingContinuationDelegate } from "./types.js";

const SESSION_KEY = "test-session-438";

const RUNTIME_BOOLEAN_FIELDS = ["silent", "silentWake", "postCompaction"] as const;

beforeEach(() => {
  mockFlows.clear();
  flowIdCounter = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("keeps PendingContinuationDelegate mode-only at runtime boundaries", () => {
  describe("runtime objects from consumePendingDelegates", () => {
    it.each([
      ["normal", { mode: undefined as PendingContinuationDelegate["mode"] }],
      ["silent", { mode: "silent" as const }],
      ["silent-wake", { mode: "silent-wake" as const }],
    ])(
      "consume pending (%s mode) returns runtime object with no boolean fields",
      (_label, { mode }) => {
        enqueuePendingDelegate(SESSION_KEY, {
          task: "trap test",
          ...(mode !== undefined ? { mode } : {}),
        });
        const consumed = consumePendingDelegates(SESSION_KEY);
        expect(consumed).toHaveLength(1);
        const delegate = expectDefined(consumed.at(0), "delegate");
        for (const field of RUNTIME_BOOLEAN_FIELDS) {
          expect(
            Object.hasOwn(delegate, field),
            `runtime PendingContinuationDelegate must not expose '${field}' (mode-only encoding)`,
          ).toBe(false);
        }
        if (mode !== undefined) {
          expect(delegate.mode).toBe(mode);
        }
      },
    );

    it("consume staged post-compaction returns runtime object with mode='post-compaction' and no boolean fields", () => {
      stagePostCompactionTaskFlowDelegate(SESSION_KEY, {
        task: "trap test",
        stagedAt: Date.now(),
      });
      const consumed = claimStagedPostCompactionTaskFlowDelegates(SESSION_KEY);
      expect(consumed).toHaveLength(1);
      const delegate = expectDefined(consumed.at(0), "post-compaction delegate");
      expect(delegate.mode).toBe("post-compaction");
      for (const field of RUNTIME_BOOLEAN_FIELDS) {
        expect(
          Object.hasOwn(delegate, field),
          `post-compaction runtime delegate must not expose '${field}'`,
        ).toBe(false);
      }
    });
  });

  describe("on-disk TaskFlow stateJson back-compat (positive assertion)", () => {
    it.each([
      ["silent", "silent"],
      ["silent-wake", "silentWake"],
      ["post-compaction", "postCompaction"],
    ] as const)(
      "persisted stateJson for mode='%s' projects to legacy boolean '%s'=true (back-compat preserved)",
      (mode, expectedBooleanField) => {
        if (mode === "post-compaction") {
          stagePostCompactionTaskFlowDelegate(SESSION_KEY, {
            task: "back-compat",
            stagedAt: Date.now(),
          });
        } else {
          enqueuePendingDelegate(SESSION_KEY, { task: "back-compat", mode });
        }
        const flow = expectDefined([...mockFlows.values()].at(0), "flow");
        const stateJson = flow.stateJson as Record<string, unknown>;
        expect(stateJson[expectedBooleanField]).toBe(true);
      },
    );

    it("persisted stateJson for normal mode projects no boolean mode flags", () => {
      enqueuePendingDelegate(SESSION_KEY, { task: "normal" });
      const flow = expectDefined([...mockFlows.values()].at(0), "flow");
      const stateJson = flow.stateJson as Record<string, unknown>;
      for (const field of RUNTIME_BOOLEAN_FIELDS) {
        expect(stateJson[field]).toBeUndefined();
      }
    });
  });
});

describe("continue_delegate tool descriptor exposes mode enum, not boolean flags", () => {
  it("descriptor advertises mode as enum with the four canonical values and no silent/silentWake parameters", async () => {
    // Stub config used by createContinueDelegateTool's resolveMaxDelegatesPerTurn.
    const tool = (
      await import("../../agents/tools/continue-delegate-tool.js")
    ).createContinueDelegateTool({ agentSessionKey: SESSION_KEY });

    const params = tool.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
    };

    expect(params.type).toBe("object");
    const properties = params.properties ?? {};

    // Must expose `mode` as an enum/string-union.
    expect(properties).toHaveProperty("mode");
    const modeProp = properties.mode as {
      anyOf?: Array<{ const?: string; enum?: string[] }>;
      enum?: string[];
    };
    // optionalStringEnum may render as anyOf [ { const: "normal" }, ... ] OR as enum.
    const enumValues = new Set<string>();
    if (Array.isArray(modeProp.enum)) {
      for (const v of modeProp.enum) {
        enumValues.add(v);
      }
    }
    if (Array.isArray(modeProp.anyOf)) {
      for (const branch of modeProp.anyOf) {
        if (typeof branch.const === "string") {
          enumValues.add(branch.const);
        }
        if (Array.isArray(branch.enum)) {
          for (const v of branch.enum) {
            enumValues.add(v);
          }
        }
      }
    }
    for (const expected of ["normal", "silent", "silent-wake", "post-compaction"]) {
      expect(
        enumValues.has(expected),
        `tool descriptor mode enum must include '${expected}' (got: ${[...enumValues].join(", ")})`,
      ).toBe(true);
    }

    // Must NOT expose boolean `silent` / `silentWake` parameters.
    for (const forbidden of ["silent", "silentWake"]) {
      expect(
        Object.hasOwn(properties, forbidden),
        `continue_delegate tool descriptor must not expose '${forbidden}' parameter (mode-only API surface)`,
      ).toBe(false);
    }
  });
});
