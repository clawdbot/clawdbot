/**
 * Resolves whether Codex app-server native execution can own shell/file work,
 * or whether OpenClaw must keep exec/process on a configured node host.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSandboxRuntimeStatus } from "openclaw/plugin-sdk/sandbox";
import { getSessionEntry, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

type ExecHost = "sandbox" | "gateway" | "node";
type ExecTarget = "auto" | ExecHost;

type ExecHostOverride = {
  host?: string;
  node?: string;
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

const DEFAULT_AGENT_ID = "main";
const VALID_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_PATTERN = /[^a-z0-9_-]+/g;
const LEADING_DASH_PATTERN = /^-+/;
const TRAILING_DASH_PATTERN = /-+$/;

/** Effective execution-host policy for the Codex app-server native tool surface. */
export type CodexNativeExecutionPolicy = {
  nativeToolSurfaceAllowed: boolean;
  requestedExecHost: ExecTarget;
  effectiveExecHost: ExecHost;
  node?: string;
  blockReason?: string;
};

/** Projects node execution ownership into the runtime tool factory options. */
export function resolveCodexNodeExecToolOverrides(
  policy: CodexNativeExecutionPolicy,
): { host: "node"; node?: string } | undefined {
  if (policy.effectiveExecHost !== "node") {
    return undefined;
  }
  const node = policy.node?.trim();
  return { host: "node", ...(node ? { node } : {}) };
}

/** Resolves node/gateway/sandbox execution ownership from overrides, session, agent, and config. */
export function resolveCodexNativeExecutionPolicy(params: {
  config?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  execOverrides?: ExecHostOverride;
  sandboxAvailable?: boolean;
  readRuntimeSessionEntry?: boolean;
}): CodexNativeExecutionPolicy {
  const config = params.config ?? {};
  const sessionKey = params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
  const agentId = resolvePolicyAgentId({ config, sessionKey, agentId: params.agentId });
  const canReadSessionEntry =
    params.readRuntimeSessionEntry &&
    shouldReadRuntimeSessionEntry({ config, sessionKey, agentId: params.agentId });
  const sessionEntry =
    params.sessionEntry ??
    (canReadSessionEntry && sessionKey
      ? readRuntimeSessionEntryBestEffort({ sessionKey, agentId })
      : undefined);
  const sandboxAvailable =
    params.sandboxAvailable ??
    (sessionKey
      ? resolveSandboxRuntimeStatus({
          cfg: config,
          sessionKey,
        }).sandboxed
      : false);
  const agentExec = resolvePolicyAgentExec({ config, agentId });
  const globalExec = config.tools?.exec;
  const requestedExecHost =
    normalizeExecTarget(params.execOverrides?.host) ??
    normalizeExecTarget(sessionEntry?.execHost) ??
    normalizeExecTarget(agentExec?.host) ??
    normalizeExecTarget(globalExec?.host) ??
    "auto";
  const effectiveExecHost = resolveEffectiveExecHost({
    requestedExecHost,
    sandboxAvailable,
  });
  const node =
    params.execOverrides?.node ?? sessionEntry?.execNode ?? agentExec?.node ?? globalExec?.node;
  if (effectiveExecHost !== "node") {
    return {
      nativeToolSurfaceAllowed: true,
      requestedExecHost,
      effectiveExecHost,
      node,
    };
  }
  return {
    nativeToolSurfaceAllowed: false,
    requestedExecHost,
    effectiveExecHost,
    node,
    blockReason:
      "OpenClaw exec host=node is active for this session. Codex app-server native execution cannot route shell, filesystem, MCP, or app-backed work through the selected OpenClaw node.",
  };
}

/** Formats the user-facing explanation shown when native tools are blocked by exec host=node. */
export function formatCodexNativeNodeExecBlock(params: {
  surface: string;
  reason?: string;
}): string {
  return [
    `Codex-native ${params.surface} is unavailable because OpenClaw exec host=node is active for this session.`,
    params.reason ??
      "Codex app-server native execution cannot route execution through the selected OpenClaw node.",
    "Use a normal Codex harness turn so OpenClaw exec/process tools run on the node, or switch exec host to gateway for native Codex app-server execution.",
  ].join(" ");
}

function resolvePolicyAgentId(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): string {
  const explicitAgentId = normalizeAgentIdOrDefault(params.agentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const sessionAgentId = parseAgentIdFromSessionKey(params.sessionKey);
  if (sessionAgentId) {
    return sessionAgentId;
  }
  const agents = listAgentEntries(params.config);
  return resolveDefaultPolicyAgentId(agents);
}

function resolvePolicyAgentExec(params: {
  config: OpenClawConfig;
  agentId: string;
}): ExecHostOverride | undefined {
  return listAgentEntries(params.config).find(
    (entry) => normalizeAgentId(entry?.id) === params.agentId,
  )?.tools?.exec;
}

function listAgentEntries(config: OpenClawConfig): AgentEntry[] {
  return (config.agents?.list ?? []).filter(
    (entry): entry is AgentEntry => entry !== null && typeof entry === "object",
  );
}

function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const parts = raw.toLowerCase().split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent" || !parts[2]) {
    return undefined;
  }
  return normalizeAgentIdOrDefault(parts[1]);
}

function shouldReadRuntimeSessionEntry(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): boolean {
  if (!params.sessionKey) {
    return false;
  }
  const explicitAgentId = normalizeAgentIdOrDefault(params.agentId);
  if (!explicitAgentId) {
    return true;
  }
  const sessionAgentId = parseAgentIdFromSessionKey(params.sessionKey);
  if (!sessionAgentId) {
    return isDefaultAgentSessionKeyForAgent({ config: params.config, agentId: explicitAgentId });
  }
  return sessionAgentId === explicitAgentId;
}

function isDefaultAgentSessionKeyForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
}): boolean {
  return (
    normalizeAgentId(params.agentId) ===
    resolveDefaultPolicyAgentId(listAgentEntries(params.config))
  );
}

function resolveDefaultPolicyAgentId(agents: AgentEntry[]): string {
  const defaultEntry = agents.find((entry) => entry?.default) ?? agents[0];
  return normalizeAgentId(defaultEntry?.id);
}

function normalizeAgentIdOrDefault(value?: string | null): string | undefined {
  const normalized = normalizeAgentId(value);
  return normalized === DEFAULT_AGENT_ID && !(value ?? "").trim() ? undefined : normalized;
}

function normalizeAgentId(value?: string | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  const normalized = trimmed.toLowerCase();
  if (VALID_AGENT_ID_PATTERN.test(trimmed)) {
    return normalized;
  }
  return (
    normalized
      .replace(INVALID_AGENT_ID_CHARS_PATTERN, "-")
      .replace(LEADING_DASH_PATTERN, "")
      .replace(TRAILING_DASH_PATTERN, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function normalizeExecTarget(value?: string | null): ExecTarget | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "sandbox" ||
    normalized === "gateway" ||
    normalized === "node"
  ) {
    return normalized;
  }
  return undefined;
}

function resolveEffectiveExecHost(params: {
  requestedExecHost: ExecTarget;
  sandboxAvailable: boolean;
}): ExecHost {
  if (params.requestedExecHost === "auto") {
    return params.sandboxAvailable ? "sandbox" : "gateway";
  }
  return params.requestedExecHost;
}

function readRuntimeSessionEntryBestEffort(params: {
  sessionKey: string;
  agentId: string;
}): SessionEntry | undefined {
  try {
    return getSessionEntry({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      hydrateSkillPromptRefs: false,
    });
  } catch {
    return undefined;
  }
}
