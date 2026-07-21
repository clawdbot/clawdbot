// Resolves normalized exec approval policy without persistence side effects.
import {
  DEFAULT_ASK,
  DEFAULT_AUTO_ALLOW_SKILLS,
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  DEFAULT_SECURITY,
  normalizeExecApprovalsInternal,
  resolveExecApprovalsPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
import type {
  ExecApprovalsAgent,
  ExecApprovalsDefaults,
  ExecApprovalsFile,
  ExecApprovalsResolved,
  ExecAsk,
  ExecSecurity,
} from "./exec-approvals-core.js";
import { expandHomePrefix } from "./home-dir.js";

function isExecSecurity(value: unknown): value is ExecSecurity {
  return value === "allowlist" || value === "full" || value === "deny";
}

function isExecAsk(value: unknown): value is ExecAsk {
  return value === "always" || value === "off" || value === "on-miss";
}

function normalizeSecurity(value: unknown, fallback: ExecSecurity): ExecSecurity {
  return isExecSecurity(value) ? value : fallback;
}

function normalizeAsk(value: unknown, fallback: ExecAsk): ExecAsk {
  return isExecAsk(value) ? value : fallback;
}

type ResolvedExecPolicyField<TValue extends ExecSecurity | ExecAsk> = {
  value: TValue;
  source: string | null;
};

function resolveDefaultSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const defaultValue = params.defaults[params.field];
  if (isExecSecurity(defaultValue)) {
    return {
      value: defaultValue,
      source: `defaults.${params.field}`,
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveDefaultAskField(params: {
  defaults: ExecApprovalsDefaults;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  if (isExecAsk(params.defaults.ask)) {
    return {
      value: params.defaults.ask,
      source: "defaults.ask",
    };
  }
  return {
    value: params.fallback,
    source: null,
  };
}

function resolveAgentSecurityField(params: {
  field: "security" | "askFallback";
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecSecurity;
}): ResolvedExecPolicyField<ExecSecurity> {
  const fallbackField = resolveDefaultSecurityField({
    field: params.field,
    defaults: params.defaults,
    fallback: params.fallback,
  });
  const rawAgentValue = params.rawAgent[params.field];
  if (rawAgentValue != null) {
    if (isExecSecurity(params.agent[params.field])) {
      return {
        value: params.agent[params.field] as ExecSecurity,
        source: `agents.${params.agentKey}.${params.field}`,
      };
    }
    return fallbackField;
  }
  const rawWildcardValue = params.rawWildcard[params.field];
  if (rawWildcardValue != null) {
    if (isExecSecurity(params.wildcard[params.field])) {
      return {
        value: params.wildcard[params.field] as ExecSecurity,
        source: `agents.*.${params.field}`,
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

function resolveAgentAskField(params: {
  defaults: ExecApprovalsDefaults;
  agent: ExecApprovalsAgent;
  rawAgent: ExecApprovalsAgent;
  wildcard: ExecApprovalsAgent;
  rawWildcard: ExecApprovalsAgent;
  agentKey: string;
  fallback: ExecAsk;
}): ResolvedExecPolicyField<ExecAsk> {
  const fallbackField = resolveDefaultAskField({
    defaults: params.defaults,
    fallback: params.fallback,
  });
  if (params.rawAgent.ask != null) {
    if (isExecAsk(params.agent.ask)) {
      return {
        value: params.agent.ask,
        source: `agents.${params.agentKey}.ask`,
      };
    }
    return fallbackField;
  }
  if (params.rawWildcard.ask != null) {
    if (isExecAsk(params.wildcard.ask)) {
      return {
        value: params.wildcard.ask,
        source: "agents.*.ask",
      };
    }
    return fallbackField;
  }
  return fallbackField;
}

export function resolveExecApprovalsFromFilePrepared(params: {
  rawFile: ExecApprovalsFile;
  file: ExecApprovalsFile;
  token: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
}): ExecApprovalsResolved {
  const rawFile = params.rawFile;
  const file = params.file;
  const defaults = file.defaults ?? {};
  const agentKey = params.agentId;
  if (!agentKey) {
    throw new Error("Exec approvals resolution requires an explicit agent id.");
  }
  const agent = file.agents?.[agentKey] ?? {};
  const wildcard = file.agents?.["*"] ?? {};
  const rawAgent = rawFile.agents?.[agentKey] ?? {};
  const rawWildcard = rawFile.agents?.["*"] ?? {};
  const fallbackSecurity = params.overrides?.security ?? DEFAULT_SECURITY;
  const fallbackAsk = params.overrides?.ask ?? DEFAULT_ASK;
  const fallbackAskFallback = params.overrides?.askFallback ?? DEFAULT_EXEC_APPROVAL_ASK_FALLBACK;
  const fallbackAutoAllowSkills = params.overrides?.autoAllowSkills ?? DEFAULT_AUTO_ALLOW_SKILLS;
  const resolvedDefaults: Required<ExecApprovalsDefaults> = {
    security: normalizeSecurity(defaults.security, fallbackSecurity),
    ask: normalizeAsk(defaults.ask, fallbackAsk),
    askFallback: normalizeSecurity(
      defaults.askFallback ?? fallbackAskFallback,
      fallbackAskFallback,
    ),
    autoAllowSkills: defaults.autoAllowSkills ?? fallbackAutoAllowSkills,
  };
  const resolvedAgentSecurity = resolveAgentSecurityField({
    field: "security",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.security,
  });
  const resolvedAgentAsk = resolveAgentAskField({
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.ask,
  });
  const resolvedAgentAskFallback = resolveAgentSecurityField({
    field: "askFallback",
    defaults,
    agent,
    rawAgent,
    wildcard,
    rawWildcard,
    agentKey,
    fallback: resolvedDefaults.askFallback,
  });
  const resolvedAgent: Required<ExecApprovalsDefaults> = {
    security: resolvedAgentSecurity.value,
    ask: resolvedAgentAsk.value,
    askFallback: resolvedAgentAskFallback.value,
    autoAllowSkills:
      agent.autoAllowSkills ?? wildcard.autoAllowSkills ?? resolvedDefaults.autoAllowSkills,
  };
  const allowlist = [
    ...(Array.isArray(wildcard.allowlist) ? wildcard.allowlist : []),
    ...(Array.isArray(agent.allowlist) ? agent.allowlist : []),
  ];
  return {
    path: params.path ?? resolveExecApprovalsPath(),
    socketPath: expandHomePrefix(
      params.socketPath ?? file.socket?.path ?? resolveExecApprovalsSocketPath(),
    ),
    token: params.token,
    defaults: resolvedDefaults,
    agent: resolvedAgent,
    agentSources: {
      security: resolvedAgentSecurity.source,
      ask: resolvedAgentAsk.source,
      askFallback: resolvedAgentAskFallback.source,
    },
    allowlist,
    file,
  };
}

export function resolveExecApprovalsFromFileInternal(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovalsInternal(params.file);
  const { token: socketToken } = file.socket ?? {};
  return resolveExecApprovalsFromFilePrepared({
    ...params,
    rawFile,
    file,
    token: params.token ?? socketToken ?? "",
  });
}
