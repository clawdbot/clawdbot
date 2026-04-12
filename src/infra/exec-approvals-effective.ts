import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
  maxAsk,
  minSecurity,
  resolveExecApprovalsFromFile,
  type ExecApprovalsFile,
  type ExecAsk,
  type ExecSecurity,
  type ExecTarget,
} from "./exec-approvals.js";

const DEFAULT_REQUESTED_SECURITY: ExecSecurity = "full";
const DEFAULT_REQUESTED_ASK: ExecAsk = "off";
const DEFAULT_HOST_PATH = "~/.openclaw/exec-approvals.json";
const REQUESTED_DEFAULT_LABEL = {
  security: DEFAULT_REQUESTED_SECURITY,
  ask: DEFAULT_REQUESTED_ASK,
} as const;
type ExecPolicyConfig = {
  host?: ExecTarget;
  security?: ExecSecurity;
  ask?: ExecAsk;
};

export type ExecPolicyHostSummary = {
  requested: ExecTarget;
  requestedSource: string;
};

export type ExecPolicyFieldSummary<TValue extends ExecSecurity | ExecAsk> = {
  requested: TValue;
  requestedSource: string;
  host: TValue;
  hostSource: string;
  effective: TValue;
  note: string;
};

export type ExecPolicyScopeSnapshot = {
  scopeLabel: string;
  configPath: string;
  agentId?: string;
  host: ExecPolicyHostSummary;
  security: ExecPolicyFieldSummary<ExecSecurity>;
  ask: ExecPolicyFieldSummary<ExecAsk>;
  askFallback: {
    effective: ExecSecurity;
    source: string;
  };
  allowedDecisions: readonly ExecApprovalDecision[];
};

export type ExecPolicyScopeSummary = Omit<ExecPolicyScopeSnapshot, "allowedDecisions">;

type ExecPolicyRequestedField = "security" | "ask";

function resolveRequestedHost(params: {
  scopeExecConfig?: ExecPolicyConfig;
  globalExecConfig?: ExecPolicyConfig;
}): { value: ExecTarget; sourcePath: string } {
  const scopeValue = params.scopeExecConfig?.host;
  if (scopeValue !== undefined) {
    return {
      value: scopeValue,
      sourcePath: "scope",
    };
  }
  const globalValue = params.globalExecConfig?.host;
  if (globalValue !== undefined) {
    return {
      value: globalValue,
      sourcePath: "tools.exec",
    };
  }
  return {
    value: "auto",
    sourcePath: "__default__",
  };
}

function formatRequestedSource(params: {
  sourcePath: string;
  field: "security" | "ask";
  defaultValue: ExecSecurity | ExecAsk;
}): string {
  return params.sourcePath === "__default__"
    ? `OpenClaw default (${params.defaultValue})`
    : `${params.sourcePath}.${params.field}`;
}

type ExecPolicyField = "security" | "ask" | "askFallback";

function resolveRequestedField<TValue extends ExecSecurity | ExecAsk>(params: {
  field: ExecPolicyRequestedField;
  scopeExecConfig?: ExecPolicyConfig;
  globalExecConfig?: ExecPolicyConfig;
}): { value: TValue; sourcePath: string } {
  const scopeValue = params.scopeExecConfig?.[params.field];
  if (scopeValue !== undefined) {
    return {
      value: scopeValue as TValue,
      sourcePath: "scope",
    };
  }
  const globalValue = params.globalExecConfig?.[params.field];
  if (globalValue !== undefined) {
    return {
      value: globalValue as TValue,
      sourcePath: "tools.exec",
    };
  }
  const defaultValue = REQUESTED_DEFAULT_LABEL[params.field] as TValue;
  return {
    value: defaultValue,
    sourcePath: "__default__",
  };
}

function formatHostFieldSource(params: {
  hostPath: string;
  field: ExecPolicyField;
  sourceSuffix: string | null;
}): string {
  if (params.sourceSuffix) {
    return `${params.hostPath} ${params.sourceSuffix}`;
  }
  if (params.field === "askFallback") {
    return `OpenClaw default (${DEFAULT_EXEC_APPROVAL_ASK_FALLBACK})`;
  }
  return "inherits requested tool policy";
}

function resolveAskNote(params: {
  requestedAsk: ExecAsk;
  hostAsk: ExecAsk;
  effectiveAsk: ExecAsk;
}): string {
  if (params.effectiveAsk === params.requestedAsk) {
    return "requested ask applies";
  }
  return "more aggressive ask wins";
}

export function collectExecPolicyScopeSnapshots(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
  hostPath?: string;
}): ExecPolicyScopeSnapshot[] {
  const snapshots = [
    resolveExecPolicyScopeSnapshot({
      approvals: params.approvals,
      scopeExecConfig: params.cfg.tools?.exec,
      configPath: "tools.exec",
      hostPath: params.hostPath,
      scopeLabel: "tools.exec",
    }),
  ];
  const globalExecConfig = params.cfg.tools?.exec;
  const configAgentIds = new Set(
    (params.cfg.agents?.list ?? [])
      .filter((agent) => agent.id !== DEFAULT_AGENT_ID || agent.tools?.exec !== undefined)
      .map((agent) => agent.id),
  );
  const approvalAgentIds = Object.keys(params.approvals.agents ?? {}).filter(
    (agentId) => agentId !== "*" && agentId !== "default" && agentId !== DEFAULT_AGENT_ID,
  );
  const agentIds = Array.from(new Set([...configAgentIds, ...approvalAgentIds])).toSorted();
  for (const agentId of agentIds) {
    const agentConfig = params.cfg.agents?.list?.find((agent) => agent.id === agentId);
    snapshots.push(
      resolveExecPolicyScopeSnapshot({
        approvals: params.approvals,
        scopeExecConfig: agentConfig?.tools?.exec,
        globalExecConfig,
        configPath: `agents.list.${agentId}.tools.exec`,
        hostPath: params.hostPath,
        scopeLabel: `agent:${agentId}`,
        agentId,
      }),
    );
  }
  return snapshots;
}

export function resolveExecPolicyScopeSummary(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSummary {
  const snapshot = resolveExecPolicyScopeSnapshot(params);
  const { allowedDecisions: _allowedDecisions, ...summary } = snapshot;
  return summary;
}

export function resolveExecPolicyScopeSnapshot(params: {
  approvals: ExecApprovalsFile;
  scopeExecConfig?: ExecPolicyConfig | undefined;
  globalExecConfig?: ExecPolicyConfig | undefined;
  configPath: string;
  scopeLabel: string;
  agentId?: string;
  hostPath?: string;
}): ExecPolicyScopeSnapshot {
  const requestedSecurity = resolveRequestedField<ExecSecurity>({
    field: "security",
    scopeExecConfig: params.scopeExecConfig,
    globalExecConfig: params.globalExecConfig,
  });
  const requestedHost = resolveRequestedHost({
    scopeExecConfig: params.scopeExecConfig,
    globalExecConfig: params.globalExecConfig,
  });
  const requestedAsk = resolveRequestedField<ExecAsk>({
    field: "ask",
    scopeExecConfig: params.scopeExecConfig,
    globalExecConfig: params.globalExecConfig,
  });
  const resolved = resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: params.agentId,
    overrides: {
      security: requestedSecurity.value,
      ask: requestedAsk.value,
    },
  });
  const hostPath = params.hostPath ?? DEFAULT_HOST_PATH;
  const effectiveSecurity = minSecurity(requestedSecurity.value, resolved.agent.security);
  const effectiveAsk = maxAsk(requestedAsk.value, resolved.agent.ask);
  const effectiveAskFallback = minSecurity(effectiveSecurity, resolved.agent.askFallback);
  return {
    scopeLabel: params.scopeLabel,
    configPath: params.configPath,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    host: {
      requested: requestedHost.value,
      requestedSource:
        requestedHost.sourcePath === "__default__"
          ? "OpenClaw default (auto)"
          : `${requestedHost.sourcePath === "scope" ? params.configPath : requestedHost.sourcePath}.host`,
    },
    security: {
      requested: requestedSecurity.value,
      requestedSource: formatRequestedSource({
        sourcePath:
          requestedSecurity.sourcePath === "scope"
            ? params.configPath
            : requestedSecurity.sourcePath,
        field: "security",
        defaultValue: DEFAULT_REQUESTED_SECURITY,
      }),
      host: resolved.agent.security,
      hostSource: formatHostFieldSource({
        hostPath,
        field: "security",
        sourceSuffix: resolved.agentSources.security,
      }),
      effective: effectiveSecurity,
      note:
        effectiveSecurity === requestedSecurity.value
          ? "requested security applies"
          : "stricter host security wins",
    },
    ask: {
      requested: requestedAsk.value,
      requestedSource: formatRequestedSource({
        sourcePath:
          requestedAsk.sourcePath === "scope" ? params.configPath : requestedAsk.sourcePath,
        field: "ask",
        defaultValue: DEFAULT_REQUESTED_ASK,
      }),
      host: resolved.agent.ask,
      hostSource: formatHostFieldSource({
        hostPath,
        field: "ask",
        sourceSuffix: resolved.agentSources.ask,
      }),
      effective: effectiveAsk,
      note: resolveAskNote({
        requestedAsk: requestedAsk.value,
        hostAsk: resolved.agent.ask,
        effectiveAsk,
      }),
    },
    askFallback: {
      effective: effectiveAskFallback,
      source: formatHostFieldSource({
        hostPath,
        field: "askFallback",
        sourceSuffix: resolved.agentSources.askFallback,
      }),
    },
    allowedDecisions: resolveExecApprovalAllowedDecisions({ ask: effectiveAsk }),
  };
}
