// Shared exec approval types and mode normalization.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { CommandExplanationSummary } from "./command-analysis/explain.js";
import type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type ExecHost = "sandbox" | "gateway" | "node";
export type ExecTarget = "auto" | ExecHost;
export type ExecSecurity = "deny" | "allowlist" | "full";
export type ExecAsk = "off" | "on-miss" | "always";
export type ExecMode = "deny" | "allowlist" | "ask" | "auto" | "full";
export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";
export type ExecApprovalUnavailableDecision = "allow-always";

export const EXEC_TARGET_VALUES: readonly ExecTarget[] = ["auto", "sandbox", "gateway", "node"];

export function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

export function normalizeExecTarget(value?: string | null): ExecTarget | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "auto") {
    return normalized;
  }
  return normalizeExecHost(normalized);
}

export function requireValidExecTarget(value?: unknown): ExecTarget | null {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Invalid exec host value type ${typeof value}. Allowed values: ${EXEC_TARGET_VALUES.join(
        ", ",
      )}.`,
    );
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return null;
  }
  const target = normalizeExecTarget(normalized);
  if (target) {
    return target;
  }
  throw new Error(
    `Invalid exec host "${value}". Allowed values: ${EXEC_TARGET_VALUES.join(", ")}.`,
  );
}

export function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

export function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized;
  }
  return null;
}

export function normalizeExecMode(value?: string | null): ExecMode | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (
    normalized === "deny" ||
    normalized === "allowlist" ||
    normalized === "ask" ||
    normalized === "auto" ||
    normalized === "full"
  ) {
    return normalized;
  }
  return null;
}

export function resolveExecModeFromPolicy(params: {
  security: ExecSecurity;
  ask: ExecAsk;
}): ExecMode {
  if (params.security === "deny") {
    return "deny";
  }
  if (params.security === "allowlist" && params.ask === "off") {
    return "allowlist";
  }
  if (params.security === "full" && params.ask !== "always") {
    return "full";
  }
  return "ask";
}

export function resolveExecPolicyForMode(mode: ExecMode): {
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
} {
  switch (mode) {
    case "deny":
      return { security: "deny", ask: "off", autoReview: false };
    case "allowlist":
      return { security: "allowlist", ask: "off", autoReview: false };
    case "ask":
      return { security: "allowlist", ask: "on-miss", autoReview: false };
    case "auto":
      return { security: "allowlist", ask: "on-miss", autoReview: true };
    case "full":
      return { security: "full", ask: "off", autoReview: false };
  }
  const exhaustiveMode: never = mode;
  throw new Error(`Unsupported exec mode: ${String(exhaustiveMode)}`);
}

export function resolveExecModePolicy(params: {
  mode?: ExecMode | null;
  security: ExecSecurity;
  ask: ExecAsk;
}): {
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
  autoReview: boolean;
} {
  if (!params.mode) {
    return {
      mode: resolveExecModeFromPolicy({ security: params.security, ask: params.ask }),
      security: params.security,
      ask: params.ask,
      autoReview: false,
    };
  }
  return {
    mode: params.mode,
    ...resolveExecPolicyForMode(params.mode),
  };
}

export type SystemRunApprovalBinding = {
  argv: string[];
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
  envHash: string | null;
};

export type SystemRunApprovalFileOperand = {
  argvIndex: number;
  path: string;
  sha256: string;
};

export type SystemRunApprovalPlan = {
  argv: string[];
  cwd: string | null;
  commandText: string;
  commandPreview?: string | null;
  agentId: string | null;
  sessionKey: string | null;
  policySnapshot?: ExecApprovalPolicySnapshot;
  mutableFileOperand?: SystemRunApprovalFileOperand | null;
};

export type ExecApprovalCommandSpan = {
  startIndex: number;
  endIndex: number;
};

export type ExecApprovalRequestPayload = {
  command: string;
  commandPreview?: string | null;
  commandArgv?: string[];
  // Optional UI-safe env key preview for approval prompts.
  envKeys?: string[];
  systemRunBinding?: SystemRunApprovalBinding | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  nodeId?: string | null;
  host?: string | null;
  security?: string | null;
  ask?: string | null;
  warningText?: string | null;
  commandAnalysis?: CommandExplanationSummary | null;
  commandSpans?: ExecApprovalCommandSpan[];
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[];
  allowedDecisions?: readonly ExecApprovalDecision[];
  agentId?: string | null;
  resolvedPath?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type ExecApprovalRequest = {
  id: string;
  request: ExecApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: ExecApprovalRequest["request"];
};

export type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
};

export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  file: ExecApprovalsFile;
  hash: string;
};

export type ExecApprovalsResolved = {
  path: string;
  socketPath: string;
  token: string;
  defaults: Required<ExecApprovalsDefaults>;
  agent: Required<ExecApprovalsDefaults>;
  agentSources: {
    security: string | null;
    ask: string | null;
    askFallback: string | null;
  };
  allowlist: ExecAllowlistEntry[];
  file: ExecApprovalsFile;
};

// Keep CLI + gateway defaults in sync.
export const DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1_800_000;
