// Shared type contracts for exec approval policy and durable persistence.
import type { AllowAlwaysPattern } from "./exec-approvals-allowlist.js";
import type { ExecAsk, ExecSecurity } from "./exec-approvals-core.js";

export type ExecApprovalsDefaultOverrides = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
  requireSocket?: boolean;
};

export type AllowAlwaysPersistenceReason =
  | "no-reusable-pattern"
  | "prompt-only"
  | "runtime-payload"
  | "unplanned";

export type AllowAlwaysPersistenceDecision =
  | { kind: "patterns"; patterns: readonly AllowAlwaysPattern[]; commandText?: string }
  | { kind: "exact-command"; commandText: string }
  | { kind: "one-shot"; reasons: AllowAlwaysPersistenceReason[] };
