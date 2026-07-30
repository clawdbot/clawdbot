import type { WorkerEnvironmentState } from "../../../packages/gateway-protocol/src/schema/environments.js";

export type { WorkerEnvironmentState } from "../../../packages/gateway-protocol/src/schema/environments.js";
export type WorkerEnvironmentUnleasedState = "requested" | "provisioning" | "failed";
export type WorkerEnvironmentLeasedState = Exclude<
  WorkerEnvironmentState,
  WorkerEnvironmentUnleasedState
>;

const TRANSITIONS = {
  requested: ["provisioning", "failed"],
  provisioning: ["bootstrapping", "failed"],
  bootstrapping: ["ready", "draining", "orphaned"],
  ready: ["bootstrapping", "attached", "idle", "draining", "orphaned"],
  attached: ["idle", "draining", "orphaned"],
  idle: ["bootstrapping", "attached", "draining", "orphaned"],
  draining: ["destroying", "orphaned"],
  destroying: ["destroyed", "failed", "orphaned"],
  destroyed: [],
  failed: [],
  orphaned: [],
} as const satisfies Record<WorkerEnvironmentState, readonly WorkerEnvironmentState[]>;

export function parseWorkerEnvironmentState(value: unknown): WorkerEnvironmentState {
  if (typeof value !== "string" || !Object.hasOwn(TRANSITIONS, value)) {
    throw new Error(`Invalid persisted worker environment state: ${String(value)}`);
  }
  return value as WorkerEnvironmentState;
}

export function canTransitionWorkerEnvironment(
  from: WorkerEnvironmentState,
  to: WorkerEnvironmentState,
): boolean {
  return TRANSITIONS[from].some((candidate) => candidate === to);
}

export function workerEnvironmentStateRequiresLease(
  state: WorkerEnvironmentState,
): state is WorkerEnvironmentLeasedState {
  return state !== "requested" && state !== "provisioning" && state !== "failed";
}
