/**
 * Resolves default exec tool settings from session and config context.
 */
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadExecApprovals,
  type ExecAsk,
  type ExecHost,
  type ExecMode,
  type ExecSecurity,
  type ExecTarget,
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
  resolveExecApprovalsFromFile,
  resolveExecModeFromPolicy,
  resolveExecModePolicy,
} from "../infra/exec-approvals.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";
import { isRequestedExecTargetAllowed, resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

/** Session-scoped exec fields that may be carried across an isolated runtime boundary. */
export type ExecSessionDefaults = Pick<
  SessionEntry,
  "execHost" | "execSecurity" | "execAsk" | "execNode" | "execCwd"
>;

// Resolved exec config layers come from global config, agent config, legacy
// session fields, and per-call overrides.
type ResolvedExecConfig = {
  host?: ExecTarget;
  mode?: ExecMode;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
};

export type ExecPolicyOverrides = Omit<ResolvedExecConfig, "mode">;

// Layering keeps the most specific mode/security/ask while preserving policy
// bounds from approvals and sandbox availability later in resolution.
type LayeredExecPolicy = {
  mode?: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
};

function applySessionLegacyExecPolicyLayer(
  base: LayeredExecPolicy,
  sessionEntry?: ExecSessionDefaults,
): LayeredExecPolicy {
  const security = normalizeExecSecurity(sessionEntry?.execSecurity);
  const ask = normalizeExecAsk(sessionEntry?.execAsk);
  if (security !== null || ask !== null) {
    return {
      security: security ?? base.security,
      ask: ask ?? base.ask,
    };
  }
  return base;
}

// Gather the shared config state once so exec resolution applies one
// agent/global/session precedence order.
function resolveExecConfigState(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  agentId?: string;
  sessionKey?: string;
  scope?: { kind: "defaults" };
}): {
  cfg: OpenClawConfig;
  host: ExecTarget;
  agentId: string | undefined;
  agentExec?: ResolvedExecConfig;
  globalExec?: ResolvedExecConfig;
} {
  const cfg = params.cfg ?? {};
  const resolvedAgentId =
    params.scope?.kind === "defaults"
      ? undefined
      : (params.agentId ??
        resolveSessionAgentId({
          sessionKey: params.sessionKey,
          config: cfg,
        }));
  const globalExec = cfg.tools?.exec;
  const agentExec = resolvedAgentId
    ? resolveAgentConfig(cfg, resolvedAgentId)?.tools?.exec
    : undefined;
  const host =
    params.execOverrides?.host ??
    normalizeExecTarget(params.sessionEntry?.execHost) ??
    (agentExec?.host as ExecTarget | undefined) ??
    (globalExec?.host as ExecTarget | undefined) ??
    "auto";
  return {
    cfg,
    host,
    agentId: resolvedAgentId,
    agentExec,
    globalExec,
  };
}

/** Resolves whether node exec is usable and any effective node binding. */
export function resolveNodeExecEligibility(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}): { canExec: boolean; node?: string } {
  const defaults = resolveExecDefaults(params);
  const systemRunDenied = params.cfg?.gateway?.nodes?.commands?.deny?.some(
    (command) => command.trim() === "system.run",
  );
  return {
    canExec: defaults.canRequestNode && defaults.security !== "deny" && !systemRunDenied,
    ...(defaults.node ? { node: defaults.node } : {}),
  };
}

/** Resolves effective exec host, mode, approval policy, and node availability. */
export function resolveExecDefaults(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  agentId?: string;
  sessionKey?: string;
  /** Resolve agents.defaults/tools.exec without applying any roster entry override. */
  scope?: { kind: "defaults" };
  sandboxAvailable?: boolean;
  elevatedRequested?: boolean;
}): {
  host: ExecTarget;
  effectiveHost: ExecHost;
  mode: ExecMode;
  security: ExecSecurity;
  ask: ExecAsk;
  node?: string;
  canRequestNode: boolean;
} {
  const {
    cfg,
    host,
    agentId: resolvedAgentId,
    agentExec,
    globalExec,
  } = resolveExecConfigState(params);
  const sandboxAvailable =
    params.sandboxAvailable ??
    (params.sessionKey
      ? resolveSandboxRuntimeStatus({
          cfg,
          sessionKey: params.sessionKey,
        }).sandboxed
      : false);
  const resolved = resolveExecTarget({
    configuredTarget: host,
    elevatedRequested: params.elevatedRequested === true,
    sandboxAvailable,
  });
  const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
  const approvalDefaults =
    resolved.effectiveHost === "sandbox"
      ? undefined
      : resolveExecApprovalsFromFile({
          file: loadExecApprovals(),
          agentId: resolvedAgentId,
          overrides: {
            security: defaultSecurity,
            ask: "off",
          },
        }).agent;
  const basePolicy: LayeredExecPolicy = {
    security: approvalDefaults?.security ?? defaultSecurity,
    ask: approvalDefaults?.ask ?? "off",
  };
  const layeredPolicy = applyExecPolicyLayer(
    applySessionLegacyExecPolicyLayer(
      applyExecPolicyLayer(applyExecPolicyLayer(basePolicy, globalExec), agentExec),
      params.sessionEntry,
    ),
    params.execOverrides,
  );
  const modePolicy = resolveExecModePolicy(layeredPolicy);
  // Approval files are safety bounds: they can only reduce security/ask from
  // config-derived policy, never grant a less restrictive effective mode.
  const security =
    approvalDefaults?.security !== undefined
      ? minSecurity(modePolicy.security, approvalDefaults.security)
      : modePolicy.security;
  const ask =
    approvalDefaults?.ask !== undefined
      ? maxAsk(modePolicy.ask, approvalDefaults.ask)
      : modePolicy.ask;
  const mode =
    security === modePolicy.security && ask === modePolicy.ask
      ? modePolicy.mode
      : resolveExecModeFromPolicy({ security, ask });
  return {
    host,
    effectiveHost: resolved.effectiveHost,
    mode,
    security,
    ask,
    node:
      params.execOverrides?.node ??
      params.sessionEntry?.execNode ??
      agentExec?.node ??
      globalExec?.node,
    canRequestNode: isRequestedExecTargetAllowed({
      configuredTarget: host,
      requestedTarget: "node",
      sandboxAvailable,
    }),
  };
}
