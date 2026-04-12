import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadExecApprovals,
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  type ExecTarget,
} from "../infra/exec-approvals.js";
import { resolveAgentConfig, resolveSessionAgentId } from "./agent-scope.js";
import { isRequestedExecTargetAllowed, resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

type ResolvedExecConfig = {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
};

function resolveExecConfigState(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
}): {
  cfg: OpenClawConfig;
  host: ExecTarget;
  agentExec?: ResolvedExecConfig;
  globalExec?: ResolvedExecConfig;
} {
  const cfg = params.cfg ?? {};
  const resolvedAgentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: cfg,
    });
  const globalExec = cfg.tools?.exec;
  const agentExec = resolvedAgentId
    ? resolveAgentConfig(cfg, resolvedAgentId)?.tools?.exec
    : undefined;
  const host =
    (params.sessionEntry?.execHost as ExecTarget | undefined) ??
    (agentExec?.host as ExecTarget | undefined) ??
    (globalExec?.host as ExecTarget | undefined) ??
    "auto";
  return {
    cfg,
    host,
    agentExec,
    globalExec,
  };
}

function resolveExecSandboxAvailability(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}) {
  return (
    params.sandboxAvailable ??
    (params.sessionKey
      ? resolveSandboxRuntimeStatus({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }).sandboxed
      : false)
  );
}

export function canExecRequestNode(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}): boolean {
  const { cfg, host } = resolveExecConfigState(params);
  return isRequestedExecTargetAllowed({
    configuredTarget: host,
    requestedTarget: "node",
    sandboxAvailable: resolveExecSandboxAvailability({
      cfg,
      sessionKey: params.sessionKey,
      sandboxAvailable: params.sandboxAvailable,
    }),
  });
}

export function resolveExecDefaults(params: {
  cfg?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  sandboxAvailable?: boolean;
}): {
  host: ExecTarget;
  effectiveHost: ExecHost;
  security: ExecSecurity;
  ask: ExecAsk;
  node?: string;
  canRequestNode: boolean;
} {
  const { cfg, host, agentExec, globalExec } = resolveExecConfigState(params);
  const sandboxAvailable = resolveExecSandboxAvailability({
    cfg,
    sessionKey: params.sessionKey,
    sandboxAvailable: params.sandboxAvailable,
  });
  const resolved = resolveExecTarget({
    configuredTarget: host,
    elevatedRequested: false,
    sandboxAvailable,
  });
  const approvalDefaults = loadExecApprovals().defaults;
  const defaultSecurity = resolved.effectiveHost === "sandbox" ? "deny" : "full";
  return {
    host,
    effectiveHost: resolved.effectiveHost,
    security:
      (params.sessionEntry?.execSecurity as ExecSecurity | undefined) ??
      agentExec?.security ??
      globalExec?.security ??
      approvalDefaults?.security ??
      defaultSecurity,
    ask:
      (params.sessionEntry?.execAsk as ExecAsk | undefined) ??
      agentExec?.ask ??
      globalExec?.ask ??
      approvalDefaults?.ask ??
      "off",
    node: params.sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node,
    canRequestNode: isRequestedExecTargetAllowed({
      configuredTarget: host,
      requestedTarget: "node",
      sandboxAvailable,
    }),
  };
}
