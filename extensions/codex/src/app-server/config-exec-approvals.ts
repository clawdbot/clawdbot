import {
  execPolicy,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
} from "openclaw/plugin-sdk/exec-approvals-runtime";
import type {
  OpenClawExecApprovalFloorsForCodexAppServer,
  OpenClawExecMode,
  OpenClawExecPolicy,
  OpenClawExecPolicyForCodexAppServer,
} from "./config-contracts.js";
import { readExecAsk, readExecSecurity, readRecord } from "./config-utils.js";

function resolveOpenClawExecPolicyFromConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): OpenClawExecPolicy {
  const globalExec = readRecord(params.config?.tools?.exec);
  const globalPolicy = applyOpenClawExecPolicyLayer(createDefaultOpenClawExecPolicy(), globalExec);
  const agentId = params.agentId?.trim();
  const agentExec = agentId
    ? readRecord(resolveAgentConfig(params.config ?? {}, agentId)?.tools?.exec)
    : undefined;
  return applyOpenClawExecPolicyLayer(globalPolicy, agentExec);
}

export function resolveOpenClawExecPolicyForCodexAppServer(params: {
  permissionMode?: EmbeddedRunAttemptParamsV2["permissionMode"];
  execOverrides?: {
    mode?: unknown;
    security?: unknown;
    ask?: unknown;
  };
  approvals?: ExecApprovalsFile;
  config?: OpenClawConfig;
  agentId?: string;
}): OpenClawExecPolicyForCodexAppServer {
  if (params.permissionMode === "full") {
    return { ...resolveOpenClawExecPolicyForMode("full"), touched: true };
  }
  const basePolicy = resolveOpenClawExecPolicyFromConfig({
    config: params.config,
    agentId: params.agentId,
  });
  const overridePolicy = applyOpenClawExecPolicyLayer(basePolicy, params.execOverrides);
  const approvalFloors = resolveOpenClawExecApprovalFloorsForCodexAppServer({
    approvals: params.approvals,
    agentId: params.agentId,
    policy: overridePolicy,
  });
  return applyOpenClawExecApprovalFloors(overridePolicy, approvalFloors);
}

function createDefaultOpenClawExecPolicy(): OpenClawExecPolicy {
  return {
    ...resolveOpenClawExecPolicyForMode("full"),
    touched: false,
  };
}

function applyOpenClawExecPolicyLayer(
  base: OpenClawExecPolicy,
  exec?: { mode?: unknown; security?: unknown; ask?: unknown },
): OpenClawExecPolicy {
  if (!exec) {
    return base;
  }
  const mode = readExecMode(exec.mode);
  if (mode !== undefined) {
    return {
      ...resolveOpenClawExecPolicyForMode(mode),
      touched: true,
    };
  }
  const security = readExecSecurity(exec.security);
  const ask = readExecAsk(exec.ask);
  if (security === undefined && ask === undefined) {
    return base;
  }
  const nextSecurity = security ?? base.security;
  const nextAsk = ask ?? base.ask;
  return {
    mode: execPolicy.resolveExecModePolicy({ security: nextSecurity, ask: nextAsk }).mode,
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveOpenClawExecApprovalFloorsForCodexAppServer(params: {
  approvals?: ExecApprovalsFile;
  agentId?: string;
  policy: OpenClawExecPolicy;
}): OpenClawExecApprovalFloorsForCodexAppServer | undefined {
  if (!params.approvals) {
    return undefined;
  }
  return resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: params.policy.security,
      ask: params.policy.ask,
    },
  }).agent;
}

function applyOpenClawExecApprovalFloors(
  base: OpenClawExecPolicy,
  approvalFloors?: OpenClawExecApprovalFloorsForCodexAppServer,
): OpenClawExecPolicy {
  if (!approvalFloors) {
    return base;
  }
  const nextSecurity = approvalFloors.security
    ? execPolicy.minSecurity(base.security, approvalFloors.security)
    : base.security;
  const nextAsk = approvalFloors.ask ? execPolicy.maxAsk(base.ask, approvalFloors.ask) : base.ask;
  if (nextSecurity === base.security && nextAsk === base.ask) {
    return base;
  }
  return {
    mode: execPolicy.resolveExecModePolicy({ security: nextSecurity, ask: nextAsk }).mode,
    security: nextSecurity,
    ask: nextAsk,
    touched: true,
  };
}

function resolveOpenClawExecPolicyForMode(
  mode: OpenClawExecMode,
): Omit<OpenClawExecPolicy, "touched"> {
  const { security, ask } = execPolicy.resolveExecModePolicy({
    mode,
    security: "full",
    ask: "off",
  });
  return { mode, security, ask };
}

function readExecMode(value: unknown): OpenClawExecMode | undefined {
  return value === "deny" ||
    value === "allowlist" ||
    value === "ask" ||
    value === "auto" ||
    value === "full"
    ? value
    : undefined;
}
