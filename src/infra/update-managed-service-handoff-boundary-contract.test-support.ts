import type {
  ManagedServiceManagerBoundaryOptions,
  ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";

export type ManagedRepairBoundary = {
  phase: "validating" | "verifying";
  baseUrl: string;
  revoke: boolean;
  inferencePending: Promise<void>;
  releaseInference: () => void;
};

export type ManagedServiceBoundaryOptions = ManagedServiceManagerBoundaryOptions & {
  controlDisconnect?: "transferred" | "unarmed" | "dead-parent";
  relativeInput?: boolean;
  validationResult?: "failed" | "skipped";
  validationClockAdvanceMs?: number;
  cancelDuringValidation?: boolean;
  cancelAtActivation?: "requester" | "inspection";
  runnerFallback?: boolean;
  revokeWhileValidating?: boolean;
  replaceLedgerWriter?: boolean;
  beforeParkNotice?: "acknowledged" | "stalled" | "rejected";
  repair?: ManagedRepairBoundary;
};

export type ManagedServiceManagerBoundaryRunner = (
  kind: "systemd" | "launchd",
  options?: ManagedServiceBoundaryOptions,
) => Promise<ManagedServiceManagerBoundaryResult>;
