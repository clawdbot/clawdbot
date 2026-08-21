import {
  asNonArrayRecord,
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  collectPolicyConfiguredAgents,
  ocPathSegment,
  policyAgentPathSegment,
} from "./policy-state-helpers.js";
import type { PolicyToolPostureEvidence } from "./policy-state-types.js";

export function scanPolicyToolPosture(
  cfg: Record<string, unknown>,
): readonly PolicyToolPostureEvidence[] {
  const globalTools = asNonArrayRecord(cfg.tools);
  const agents = asNonArrayRecord(cfg.agents);
  const defaults = asNonArrayRecord(agents.defaults);
  const defaultSandbox = asNonArrayRecord(defaults.sandbox);
  const entries: PolicyToolPostureEvidence[] = [];
  pushToolPostureEvidence(entries, {
    id: "tools",
    scope: "global",
    tools: globalTools,
    inheritedTools: {},
    sandbox: defaultSandbox,
    inheritedSandbox: {},
    sourceBase: "oc://openclaw.config/tools",
    inheritedSourceBase: "oc://openclaw.config/tools",
  });

  collectPolicyConfiguredAgents(agents).forEach((configured) => {
    const agent = configured.value;
    if (!isRecord(agent)) {
      return;
    }
    const agentId = configured.agentId;
    pushToolPostureEvidence(entries, {
      id: agentId,
      scope: "agent",
      agentId,
      tools: asNonArrayRecord(agent.tools),
      inheritedTools: globalTools,
      sandbox: asNonArrayRecord(agent.sandbox),
      inheritedSandbox: defaultSandbox,
      sourceBase: `oc://openclaw.config/agents/${configured.container}/${policyAgentPathSegment(configured)}/tools`,
      inheritedSourceBase: "oc://openclaw.config/tools",
    });
  });

  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function pushToolPostureEvidence(
  entries: PolicyToolPostureEvidence[],
  params: {
    readonly id: string;
    readonly scope: "global" | "agent";
    readonly agentId?: string;
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly sandbox: Record<string, unknown>;
    readonly inheritedSandbox: Record<string, unknown>;
    readonly sourceBase: string;
    readonly inheritedSourceBase: string;
  },
): void {
  const localProfile = readString(params.tools.profile);
  const inheritedProfile = readString(params.inheritedTools.profile);
  pushToolPostureValue(entries, params, {
    suffix: "profile",
    kind: "profile",
    value: localProfile ?? inheritedProfile ?? "full",
    explicit: localProfile !== undefined || inheritedProfile !== undefined,
    inherited: localProfile === undefined && inheritedProfile !== undefined,
  });

  pushToolPostureList(entries, params, "allow");
  pushToolAlsoAllowPostureList(entries, params);
  pushToolPostureList(entries, params, "deny");
  pushToolFsPosture(entries, params);
  pushToolExecPosture(entries, params);
  pushToolElevatedPosture(entries, params);
}

function pushToolFsPosture(entries: PolicyToolPostureEvidence[], params: ToolPostureParams): void {
  const localFs = asNonArrayRecord(params.tools.fs);
  const inheritedFs = asNonArrayRecord(params.inheritedTools.fs);
  const localWorkspaceOnly = readBoolean(localFs.workspaceOnly);
  const inheritedWorkspaceOnly = readBoolean(inheritedFs.workspaceOnly);
  pushToolPostureValue(entries, params, {
    suffix: "fs/workspaceOnly",
    kind: "fsWorkspaceOnly",
    value: localWorkspaceOnly ?? inheritedWorkspaceOnly ?? false,
    explicit: localWorkspaceOnly !== undefined || inheritedWorkspaceOnly !== undefined,
    inherited: localWorkspaceOnly === undefined && inheritedWorkspaceOnly !== undefined,
  });
}

function pushToolExecPosture(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localExec = asNonArrayRecord(params.tools.exec);
  const inheritedExec = asNonArrayRecord(params.inheritedTools.exec);
  const localHost = readString(localExec.host);
  const inheritedHost = readString(inheritedExec.host);
  const host = localHost ?? inheritedHost ?? "auto";
  pushToolPostureValue(entries, params, {
    suffix: "exec/host",
    kind: "execHost",
    value: host,
    explicit: localHost !== undefined || inheritedHost !== undefined,
    inherited: localHost === undefined && inheritedHost !== undefined,
  });

  const localSecurity = readString(localExec.security);
  const inheritedSecurity = readString(inheritedExec.security);
  // Config conformance intentionally ignores exec-approvals.json runtime/operator state.
  const sandboxMode = readString(params.sandbox.mode) ?? readString(params.inheritedSandbox.mode);
  const sandboxCanApply = sandboxMode === "all";
  pushToolPostureValue(entries, params, {
    suffix: "exec/security",
    kind: "execSecurity",
    value:
      localSecurity ??
      inheritedSecurity ??
      (host === "sandbox" || (host === "auto" && sandboxCanApply) ? "deny" : "full"),
    explicit: localSecurity !== undefined || inheritedSecurity !== undefined,
    inherited: localSecurity === undefined && inheritedSecurity !== undefined,
  });

  const localAsk = readString(localExec.ask);
  const inheritedAsk = readString(inheritedExec.ask);
  pushToolPostureValue(entries, params, {
    suffix: "exec/ask",
    kind: "execAsk",
    value: localAsk ?? inheritedAsk ?? "off",
    explicit: localAsk !== undefined || inheritedAsk !== undefined,
    inherited: localAsk === undefined && inheritedAsk !== undefined,
  });
}

function pushToolElevatedPosture(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localElevated = asNonArrayRecord(params.tools.elevated);
  const inheritedElevated = isRecord(params.inheritedTools.elevated)
    ? params.inheritedTools.elevated
    : {};
  const localEnabled = readBoolean(localElevated.enabled);
  const inheritedEnabled = readBoolean(inheritedElevated.enabled);
  const effectiveEnabled =
    inheritedEnabled === false ? false : (localEnabled ?? inheritedEnabled ?? true);
  pushToolPostureValue(entries, params, {
    suffix: "elevated/enabled",
    kind: "elevatedEnabled",
    value: effectiveEnabled,
    explicit: localEnabled !== undefined || inheritedEnabled !== undefined,
    inherited:
      (inheritedEnabled === false && localEnabled !== false) ||
      (localEnabled === undefined && inheritedEnabled !== undefined),
  });

  const localAllowFrom = asNonArrayRecord(localElevated.allowFrom);
  const inheritedAllowFrom = isRecord(inheritedElevated.allowFrom)
    ? inheritedElevated.allowFrom
    : {};
  const providers = [
    ...new Set([...Object.keys(inheritedAllowFrom), ...Object.keys(localAllowFrom)]),
  ].toSorted((a, b) => a.localeCompare(b));
  for (const provider of providers) {
    const localEntries = readStringOrNumberArray(localAllowFrom[provider]);
    const inheritedEntries = readStringOrNumberArray(inheritedAllowFrom[provider]);
    const inherited = localEntries.length === 0 && inheritedEntries.length > 0;
    entries.push({
      id: `${params.id}-elevated-allow-from-${ocPathSegment(provider)}`,
      kind: "elevatedAllowFrom",
      source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/elevated/allowFrom/${ocPathSegment(provider)}`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      entries: localEntries.length > 0 ? localEntries : inheritedEntries,
      explicit: localEntries.length > 0 || inheritedEntries.length > 0,
    });
  }
}

type ToolPostureParams = {
  readonly id: string;
  readonly scope: "global" | "agent";
  readonly agentId?: string;
  readonly tools: Record<string, unknown>;
  readonly inheritedTools: Record<string, unknown>;
  readonly sandbox: Record<string, unknown>;
  readonly inheritedSandbox: Record<string, unknown>;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
};

function pushToolPostureValue(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
  entry: {
    readonly suffix: string;
    readonly kind: PolicyToolPostureEvidence["kind"];
    readonly value: boolean | string | undefined;
    readonly explicit: boolean;
    readonly inherited: boolean;
  },
): void {
  entries.push({
    id: `${params.id}-${entry.suffix.replaceAll("/", "-")}`,
    kind: entry.kind,
    source: `${entry.inherited ? params.inheritedSourceBase : params.sourceBase}/${entry.suffix}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
    explicit: entry.explicit,
  });
}

function pushToolPostureList(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
  key: "allow" | "deny",
): void {
  const localEntries = readStringArray(params.tools[key]);
  const inheritedEntries = readStringArray(params.inheritedTools[key]);
  const inherited = localEntries.length === 0 && inheritedEntries.length > 0;
  entries.push({
    id: `${params.id}-${key}`,
    kind: key,
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/${key}`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    entries: [...inheritedEntries, ...localEntries],
    explicit: localEntries.length > 0 || inheritedEntries.length > 0,
  });
}

function pushToolAlsoAllowPostureList(
  entries: PolicyToolPostureEvidence[],
  params: ToolPostureParams,
): void {
  const localValue = params.tools.alsoAllow;
  const inheritedValue = params.inheritedTools.alsoAllow;
  const localConfigured = Array.isArray(localValue);
  const inheritedConfigured = Array.isArray(inheritedValue);
  const localEntries = localConfigured ? readStringArray(localValue) : [];
  const inheritedEntries = inheritedConfigured ? readStringArray(inheritedValue) : [];
  const inherited = !localConfigured && inheritedConfigured;
  entries.push({
    id: `${params.id}-alsoAllow`,
    kind: "alsoAllow",
    source: `${inherited ? params.inheritedSourceBase : params.sourceBase}/alsoAllow`,
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    entries: inherited ? inheritedEntries : localEntries,
    explicit: localConfigured || inheritedConfigured,
  });
}

export const AGENT_WORKSPACE_POLICY_TOOLS = [
  "exec",
  "process",
  "write",
  "edit",
  "apply_patch",
] as const;

export const IMPLICIT_DEFAULT_ACCOUNT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  discord: ["token"],
  googlechat: ["serviceAccount", "serviceAccountFile"],
  imessage: ["cliPath", "dbPath"],
  "qa-channel": ["baseUrl"],
  qqbot: ["appId", "clientSecret", "clientSecretFile"],
  signal: ["account"],
  slack: ["appToken", "botToken", "signingSecret"],
  "synology-chat": ["token"],
  telegram: ["botToken", "tokenFile"],
  tlon: ["ship"],
  twitch: ["username"],
  whatsapp: ["authDir"],
  zalo: ["botToken", "tokenFile"],
  zalouser: ["profile"],
};

export function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readStringOrNumberArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      entries.push(entry.trim());
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      entries.push(String(entry));
    }
  }
  return entries;
}
