import type {
  AllowAlwaysPattern,
  ExecAsk,
  ExecSecurity,
  SystemRunApprovalPlan,
} from "./exec-approvals.js";
import { normalizeSystemRunApprovalPlan } from "./system-run-approval-binding.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "./system-run-command.js";
import { normalizeNonEmptyString, normalizeStringArray } from "./system-run-normalize.js";

export type PreparedRunExecPolicy = {
  security: ExecSecurity;
  ask: ExecAsk;
};

type PreparedRunPayload = {
  plan: SystemRunApprovalPlan;
  execPolicy?: PreparedRunExecPolicy;
  allowAlwaysCoverage?: {
    complete: boolean;
    patterns: AllowAlwaysPattern[];
  };
};

type SystemRunApprovalRequestContext = {
  plan: SystemRunApprovalPlan | null;
  commandArgv: string[] | undefined;
  commandText: string;
  commandPreview: string | null;
  cwd: string | null;
  agentId: string | null;
  sessionKey: string | null;
};

type SystemRunApprovalRuntimeContext =
  | {
      ok: true;
      plan: SystemRunApprovalPlan | null;
      argv: string[];
      cwd: string | null;
      agentId: string | null;
      sessionKey: string | null;
      commandText: string;
    }
  | {
      ok: false;
      message: string;
      details?: Record<string, unknown>;
    };

function normalizeCommandText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCommandPreview(
  value: string | null | undefined,
  authoritative: string,
): string | null {
  const preview = normalizeNonEmptyString(value);
  if (!preview || preview === authoritative) {
    return null;
  }
  return preview;
}

function normalizePreparedRunExecPolicy(value: unknown): PreparedRunExecPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as { security?: unknown; ask?: unknown };
  const security = raw.security;
  const ask = raw.ask;
  if (
    (security === "deny" || security === "allowlist" || security === "full") &&
    (ask === "off" || ask === "on-miss" || ask === "always")
  ) {
    return { security, ask };
  }
  return undefined;
}

function normalizeAllowAlwaysCoverage(value: unknown): PreparedRunPayload["allowAlwaysCoverage"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as { complete?: unknown; patterns?: unknown };
  if (!Array.isArray(raw.patterns)) {
    return undefined;
  }
  const patterns = raw.patterns.flatMap((entry): AllowAlwaysPattern[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const pattern = normalizeNonEmptyString((entry as { pattern?: unknown }).pattern);
    if (!pattern) {
      return [];
    }
    const argPattern = normalizeNonEmptyString((entry as { argPattern?: unknown }).argPattern);
    return [{ pattern, ...(argPattern ? { argPattern } : {}) }];
  });
  return {
    complete: raw.complete === true,
    patterns,
  };
}

export function parsePreparedSystemRunPayload(payload: unknown): PreparedRunPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as {
    plan?: unknown;
    commandText?: unknown;
    cmdText?: unknown;
    execPolicy?: unknown;
    allowAlwaysCoverage?: unknown;
  };
  const execPolicy = normalizePreparedRunExecPolicy(raw.execPolicy);
  const allowAlwaysCoverage = normalizeAllowAlwaysCoverage(raw.allowAlwaysCoverage);
  const plan = normalizeSystemRunApprovalPlan(raw.plan);
  if (plan) {
    return {
      plan,
      ...(execPolicy ? { execPolicy } : {}),
      ...(allowAlwaysCoverage ? { allowAlwaysCoverage } : {}),
    };
  }
  if (!raw.plan || typeof raw.plan !== "object" || Array.isArray(raw.plan)) {
    return null;
  }
  const legacyPlan = raw.plan as Record<string, unknown>;
  const argv = normalizeStringArray(legacyPlan.argv);
  const commandText =
    normalizeNonEmptyString(legacyPlan.rawCommand) ??
    normalizeNonEmptyString(raw.commandText) ??
    normalizeNonEmptyString(raw.cmdText);
  if (argv.length === 0 || !commandText) {
    return null;
  }
  return {
    plan: {
      argv,
      cwd: normalizeNonEmptyString(legacyPlan.cwd),
      commandText,
      commandPreview: normalizeNonEmptyString(legacyPlan.commandPreview),
      agentId: normalizeNonEmptyString(legacyPlan.agentId),
      sessionKey: normalizeNonEmptyString(legacyPlan.sessionKey),
    },
    ...(execPolicy ? { execPolicy } : {}),
    ...(allowAlwaysCoverage ? { allowAlwaysCoverage } : {}),
  };
}

export function resolveSystemRunApprovalRequestContext(params: {
  host?: unknown;
  command?: unknown;
  commandArgv?: unknown;
  systemRunPlan?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRequestContext {
  const host = normalizeNonEmptyString(params.host) ?? "";
  const normalizedPlan =
    host === "node" ? normalizeSystemRunApprovalPlan(params.systemRunPlan) : null;
  const fallbackArgv = normalizeStringArray(params.commandArgv);
  const fallbackCommand = normalizeCommandText(params.command);
  const commandText = normalizedPlan
    ? normalizedPlan.commandText || formatExecCommand(normalizedPlan.argv)
    : fallbackCommand;
  const commandPreview = normalizedPlan
    ? normalizeCommandPreview(normalizedPlan.commandPreview ?? fallbackCommand, commandText)
    : null;
  const plan = normalizedPlan ? { ...normalizedPlan, commandPreview } : null;
  return {
    plan,
    commandArgv: plan?.argv ?? (fallbackArgv.length > 0 ? fallbackArgv : undefined),
    commandText,
    commandPreview,
    cwd: plan?.cwd ?? normalizeNonEmptyString(params.cwd),
    agentId: plan?.agentId ?? normalizeNonEmptyString(params.agentId),
    sessionKey: plan?.sessionKey ?? normalizeNonEmptyString(params.sessionKey),
  };
}

export function resolveSystemRunApprovalRuntimeContext(params: {
  plan?: unknown;
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): SystemRunApprovalRuntimeContext {
  const normalizedPlan = normalizeSystemRunApprovalPlan(params.plan ?? null);
  if (normalizedPlan) {
    return {
      ok: true,
      plan: normalizedPlan,
      argv: [...normalizedPlan.argv],
      cwd: normalizedPlan.cwd,
      agentId: normalizedPlan.agentId,
      sessionKey: normalizedPlan.sessionKey,
      commandText: normalizedPlan.commandText,
    };
  }
  const command = resolveSystemRunCommandRequest({
    command: params.command,
    rawCommand: params.rawCommand,
  });
  if (!command.ok) {
    return { ok: false, message: command.message, details: command.details };
  }
  return {
    ok: true,
    plan: null,
    argv: command.argv,
    cwd: normalizeNonEmptyString(params.cwd),
    agentId: normalizeNonEmptyString(params.agentId),
    sessionKey: normalizeNonEmptyString(params.sessionKey),
    commandText: command.commandText,
  };
}
