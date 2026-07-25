import type { CLAW_OUTPUT_STABILITY, ClawDiagnostic, ClawSourceIdentity } from "./types.js";
import type { ClawUpdateCapabilityChange } from "./update-capability-changes.js";

export const CLAW_UPDATE_PLAN_SCHEMA_VERSION = "openclaw.clawUpdatePlan.v1" as const;

export type ClawUpdateAction = {
  kind: "agent" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "add" | "change" | "remove" | "release" | "unchanged" | "manual";
  target: string;
  blocked: boolean;
  reason: string;
  currentDigest?: string;
  currentPresent?: boolean;
  desiredDigest?: string;
};

export type ClawUpdatePlan = {
  schemaVersion: typeof CLAW_UPDATE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  found: boolean;
  agentId: string;
  currentClaw?: { name: string; version: string; integrity: string };
  targetClaw?: Pick<ClawSourceIdentity, "name" | "version" | "integrity">;
  summary: {
    totalActions: number;
    added: number;
    changed: number;
    removed: number;
    released: number;
    unchanged: number;
    manual: number;
    blocked: number;
    capabilityChanges: number;
    capabilityEscalations: number;
  };
  actions: ClawUpdateAction[];
  capabilityChanges: ClawUpdateCapabilityChange[];
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
};
