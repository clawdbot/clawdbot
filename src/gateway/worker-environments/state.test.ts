import { describe, expect, it } from "vitest";
import {
  canTransitionWorkerEnvironment,
  isWorkerEnvironmentGone,
  parseWorkerEnvironmentState,
  type WorkerEnvironmentState,
} from "./state.js";

const EXPECTED_TRANSITIONS: Record<WorkerEnvironmentState, readonly WorkerEnvironmentState[]> = {
  requested: ["provisioning", "failed"],
  provisioning: ["bootstrapping", "ready", "draining", "failed"],
  bootstrapping: ["ready", "draining", "orphaned"],
  ready: ["bootstrapping", "attached", "idle", "draining", "orphaned"],
  attached: ["idle", "draining", "orphaned"],
  idle: ["bootstrapping", "attached", "draining", "orphaned"],
  draining: ["destroying", "orphaned"],
  destroying: ["destroyed", "failed", "orphaned"],
  destroyed: [],
  failed: [],
  orphaned: [],
};
const STATES = Object.keys(EXPECTED_TRANSITIONS) as WorkerEnvironmentState[];

describe("worker environment state", () => {
  it("accepts exactly the durable lifecycle edges", () => {
    for (const from of STATES) {
      for (const to of STATES) {
        expect(canTransitionWorkerEnvironment(from, to), `${from} -> ${to}`).toBe(
          EXPECTED_TRANSITIONS[from].includes(to),
        );
      }
    }
  });

  it("keeps terminal states terminal", () => {
    for (const from of ["destroyed", "failed", "orphaned"] as const) {
      expect(STATES.some((to) => canTransitionWorkerEnvironment(from, to))).toBe(false);
    }
  });

  it("rejects unknown persisted state", () => {
    expect(() => parseWorkerEnvironmentState("lost")).toThrow(
      "Invalid persisted worker environment state",
    );
  });

  it.each([
    { state: "destroyed", leaseId: "provider-lease", expected: true },
    { state: "failed", leaseId: null, expected: true },
    { state: "failed", leaseId: "provider-lease", expected: false },
    { state: "orphaned", leaseId: "provider-lease", expected: false },
  ] as const)(
    "treats $state with lease $leaseId as physically gone: $expected",
    ({ state, leaseId, expected }) => {
      expect(isWorkerEnvironmentGone({ state, leaseId })).toBe(expected);
    },
  );
});
