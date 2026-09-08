// Control UI module implements session key behavior.
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeMainKey,
  parseAgentSessionKeyParts,
  type ParsedAgentSessionKey,
} from "@openclaw/session-url-contract";

export { buildAgentMainSessionKey, DEFAULT_MAIN_KEY };
export const DEFAULT_AGENT_ID = "main";

export type UiSessionDefaultsHost = {
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null; scope?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

type UiSessionDefaults = {
  defaultAgentId?: string | null;
  mainKey?: string | null;
  mainSessionKey?: string | null;
  modelConfigured?: boolean;
};

export { normalizeAgentId };

export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  // Display ownership historically tolerates empty segments and folds the tail.
  // Store identities and URL literals apply their own stricter policies.
  return parseAgentSessionKeyParts(
    normalizeLowercaseStringOrEmpty(sessionKey).split(":").filter(Boolean).join(":"),
  );
}

export function parseSessionKeyParts(
  key: string,
): { agentId: string; channel: string; accountId: string } | null {
  const match = /^agent:([^:]+):([^:]+):(.+)$/.exec(key);
  return match
    ? { agentId: match[1] as string, channel: match[2] as string, accountId: match[3] as string }
    : null;
}

export function resolveUiSessionNavigationParentKey(
  row: { parentSessionKey?: string | null; spawnedBy?: string | null } | null | undefined,
): string | undefined {
  return normalizeOptionalString(row?.parentSessionKey) ?? normalizeOptionalString(row?.spawnedBy);
}

// Mirrors the Gateway policy in src/config/sessions/session-pin-policy.ts.
export function isPinnableUiSessionRow(row: {
  key: string;
  parentSessionKey?: string | null;
  spawnedBy?: string | null;
}): boolean {
  return resolveUiSessionNavigationParentKey(row) == null && !isSubagentSessionKey(row.key);
}

export function normalizeSessionKeyForUiComparison(sessionKey: string | undefined | null): string {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return "";
  }
  // Only opaque channel IDs need structural parsing to preserve tail casing.
  if (!/(?:^|:)(?:catalog|matrix|signal)(?=:|$)/i.test(raw)) {
    return raw.toLowerCase();
  }
  const parts = raw.split(":");
  let bodyStart = 0;
  while (parts.length - bodyStart >= 3 && parts[bodyStart]?.toLowerCase() === "agent") {
    parts[bodyStart] = "agent";
    parts[bodyStart + 1] = parts[bodyStart + 1]?.toLowerCase() ?? "";
    bodyStart += 2;
  }
  while (bodyStart < parts.length && !parts[bodyStart]?.trim()) {
    bodyStart += 1;
  }
  const channel = parts[bodyStart]?.toLowerCase();
  // Catalog source identifiers are opaque; only the agent prefix is normalized.
  if (channel === "catalog") {
    return parts.join(":");
  }
  const peerKind = parts[bodyStart + 1]?.toLowerCase();
  const preservesMatrixTail =
    channel === "matrix" && (peerKind === "channel" || peerKind === "group");
  const preservesSignalGroup = channel === "signal" && peerKind === "group";
  if (!preservesMatrixTail && !preservesSignalGroup) {
    return raw.toLowerCase();
  }
  parts[bodyStart] = channel;
  parts[bodyStart + 1] = peerKind;
  if (preservesMatrixTail) {
    for (let index = parts.length - 2; index >= bodyStart + 2; index -= 1) {
      if (parts[index]?.toLowerCase() === "thread") {
        parts[index] = "thread";
        break;
      }
    }
  } else {
    parts[bodyStart + 2] = parts[bodyStart + 2]?.trim() ?? "";
    for (let index = bodyStart + 3; index < parts.length; index += 1) {
      parts[index] = parts[index]?.toLowerCase() ?? "";
    }
  }
  return parts.join(":");
}

export function readSessionDefaults(
  host: Pick<UiSessionDefaultsHost, "hello">,
): UiSessionDefaults | undefined {
  const snapshot = host.hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return undefined;
  }
  const defaults = snapshot.sessionDefaults;
  return defaults && typeof defaults === "object" ? (defaults as UiSessionDefaults) : undefined;
}

export function resolveUiConfiguredMainKey(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
): string {
  return normalizeMainKey(host.agentsList?.mainKey ?? readSessionDefaults(host)?.mainKey);
}

export function resolveUiDefaultAgentId(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
): string {
  return normalizeAgentId(
    host.agentsList?.defaultId ?? readSessionDefaults(host)?.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
}

export function resolveUiKnownSelectedGlobalAgentId(
  host: Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello">,
): string | undefined {
  const selectedAgentId =
    host.assistantAgentId ??
    host.agentsList?.defaultId ??
    readSessionDefaults(host)?.defaultAgentId;
  return selectedAgentId ? normalizeAgentId(selectedAgentId) : undefined;
}

export function resolveUiSelectedGlobalAgentId(
  host: Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello">,
): string {
  return resolveUiKnownSelectedGlobalAgentId(host) ?? DEFAULT_AGENT_ID;
}

export function resolveUiGlobalAliasAgentId(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): string | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw || isUiGlobalSessionKey(raw)) {
    return null;
  }
  const identity = resolveUiConversationIdentity(host, raw);
  return identity.sessionKey === "global" ? (identity.agentId ?? null) : null;
}

export function isUiGlobalSessionKey(sessionKey: string | undefined | null): boolean {
  return normalizeLowercaseStringOrEmpty(sessionKey) === "global";
}

/** True when the configured main session routes to the global stream (session.scope="global"). */
export function isUiGlobalScopeConfigured(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
): boolean {
  const scope = normalizeOptionalLowercaseString(host.agentsList?.scope);
  if (scope) {
    return scope === "global";
  }
  return isUiGlobalSessionKey(readSessionDefaults(host)?.mainSessionKey);
}

/** Admission identity shared by browser outboxes and visible conversation matching. */
export function resolveUiConversationIdentity(
  host: UiSessionDefaultsHost,
  sessionKey: string,
  agentIdOverride?: string,
): { sessionKey: string; agentId?: string } {
  const raw = sessionKey.trim();
  const parsed = parseAgentSessionKey(raw);
  const knownDefaults = hasUiSessionDefaults(host);
  const mainKey = resolveUiConfiguredMainKey(host);
  const mainCandidate = parsed?.rest ?? raw.toLowerCase();
  const isMain = mainCandidate === DEFAULT_MAIN_KEY || (knownDefaults && mainCandidate === mainKey);
  if (isUiGlobalSessionKey(raw)) {
    const agentId = agentIdOverride?.trim()
      ? normalizeAgentId(agentIdOverride)
      : resolveUiKnownSelectedGlobalAgentId(host);
    return { sessionKey: "global", ...(agentId ? { agentId } : {}) };
  }
  if (!parsed && (!isMain || !knownDefaults)) {
    return { sessionKey: raw };
  }
  const agentId = normalizeAgentId(
    parsed?.agentId ?? normalizeOptionalString(agentIdOverride) ?? resolveUiDefaultAgentId(host),
  );
  let canonicalKey = normalizeSessionKeyForUiComparison(raw);
  if (isMain && knownDefaults) {
    const defaults = readSessionDefaults(host);
    const advertised = normalizeOptionalString(defaults?.mainSessionKey);
    // Hello's explicit target owns default-agent aliases only while its routing
    // facts still agree with the current roster. Never redirect another agent.
    const advertisedApplies =
      advertised &&
      agentId === resolveUiDefaultAgentId(host) &&
      agentId === normalizeAgentId(defaults?.defaultAgentId) &&
      agentId === parseAgentSessionKey(advertised)?.agentId &&
      mainKey === normalizeMainKey(defaults?.mainKey);
    canonicalKey = isUiGlobalScopeConfigured(host)
      ? "global"
      : advertisedApplies
        ? normalizeSessionKeyForUiComparison(advertised)
        : buildAgentMainSessionKey({ agentId, mainKey });
  }
  return { sessionKey: canonicalKey, agentId };
}

export function hasUiSessionDefaults(host: UiSessionDefaultsHost): boolean {
  return host.agentsList != null || readSessionDefaults(host) !== undefined;
}

/** Artifact snapshots and events retain global in their owner-qualified wire key. */
export function scopedSessionArtifactKey(sessionKey: string, agentId?: string): string {
  const key = sessionKey.trim();
  if (!key || parseAgentSessionKey(key) || !agentId?.trim()) {
    return key;
  }
  return `agent:${normalizeAgentId(agentId)}:${key}`;
}

export function canonicalUiSessionKeyForPersistence(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): string {
  const raw = normalizeOptionalString(sessionKey);
  return raw ? resolveUiConversationIdentity(host, raw).sessionKey : "";
}

/** Compare selected conversation ownership, rejecting contradictory captured agent facts. */
export function uiConversationMatches(
  host: UiSessionDefaultsHost,
  selectedKey: string | undefined | null,
  candidateKey: string | undefined | null,
  candidateAgentId?: string | null,
): boolean {
  const selected = normalizeOptionalString(selectedKey);
  const candidate = normalizeOptionalString(candidateKey);
  if (!selected || !candidate) {
    return false;
  }
  const current = resolveUiConversationIdentity(host, selected);
  const explicitAgent = normalizeOptionalString(candidateAgentId);
  const defaultAgent = resolveUiDefaultAgentId(host);
  const other = resolveUiConversationIdentity(host, candidate, explicitAgent ?? defaultAgent);
  const currentAgent = current.agentId ?? defaultAgent;
  const otherAgent = other.agentId ?? defaultAgent;
  return (
    (!explicitAgent || normalizeAgentId(explicitAgent) === otherAgent) &&
    current.sessionKey === other.sessionKey &&
    currentAgent === otherAgent
  );
}

export function uiSessionEventMatches(
  host: UiSessionDefaultsHost & { sessionKey: string },
  eventSessionKey: string | undefined | null,
  eventAgentId?: string | null,
): boolean {
  // Some broadcasts intentionally omit a target; their caller owns run/session fencing.
  return (
    !normalizeOptionalString(eventSessionKey) ||
    uiConversationMatches(host, host.sessionKey, eventSessionKey, eventAgentId)
  );
}

export function isUiSelectedGlobalSessionKey(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): boolean {
  return canonicalUiSessionKeyForPersistence(host, sessionKey) === "global";
}

export function resolveUiSelectedSessionAgentId(
  host: Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello"> & {
    sessionKey?: string | null;
  },
  sessionKey: string | undefined | null = host.sessionKey,
): string | undefined {
  return resolveUiConversationIdentity(host, sessionKey ?? "").agentId;
}

export function uiSessionRowMatchesSelectedChat(
  host: UiSessionDefaultsHost,
  rowKey: string | undefined | null,
  selectedSessionKey: string | undefined | null,
  rowAgentId?: string | null,
): boolean {
  // Rows without an explicit agent are already scoped by their owning list.
  const selected = selectedSessionKey
    ? resolveUiConversationIdentity(host, selectedSessionKey)
    : null;
  return uiConversationMatches(
    host,
    selectedSessionKey,
    rowKey,
    rowAgentId ?? (isUiGlobalSessionKey(rowKey) ? selected?.agentId : undefined),
  );
}

export function normalizeDefaultMainSessionAliasForUi(
  sessionKey: string | undefined | null,
): string {
  const normalized = normalizeSessionKeyForUiComparison(sessionKey);
  return normalized === DEFAULT_MAIN_KEY
    ? buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey: DEFAULT_MAIN_KEY })
    : normalized;
}

export function areUiSessionKeysEquivalent(
  left: string | undefined | null,
  right: string | undefined | null,
): boolean {
  const normalizedLeft = normalizeDefaultMainSessionAliasForUi(left);
  const normalizedRight = normalizeDefaultMainSessionAliasForUi(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

function isProtectedSessionLifecycleKey(
  row: { key: string; kind?: string },
  configuredMainKey: string,
): boolean {
  const normalizedKey = normalizeLowercaseStringOrEmpty(row.key);
  if (
    row.kind === "global" ||
    row.kind === "unknown" ||
    normalizedKey === "global" ||
    normalizedKey === "unknown"
  ) {
    return true;
  }
  return (
    row.key === "main" ||
    normalizeLowercaseStringOrEmpty(parseAgentSessionKey(row.key)?.rest) ===
      normalizeMainKey(configuredMainKey)
  );
}

// Archive policy shared by the chat picker, sidebar recents, and Sessions
// table: Gateway drains live work; main/global/unknown rows stay protected.
export function canArchiveSessionRow(
  row: { key: string; kind?: string; sessionId?: string },
  configuredMainKey: string,
): boolean {
  return Boolean(row.sessionId?.trim() && !isProtectedSessionLifecycleKey(row, configuredMainKey));
}

/** Preserve Delete's prior all-idle-or-all-archived batch policy independently of Archive. */
export function canDeleteSessionRows(
  rows: ReadonlyArray<{
    key: string;
    kind?: string;
    hasActiveRun?: boolean;
    archived?: boolean;
  }>,
  configuredMainKey: string,
): boolean {
  return (
    rows.every((row) => row.archived === true) ||
    rows.every(
      (row) => row.hasActiveRun !== true && !isProtectedSessionLifecycleKey(row, configuredMainKey),
    )
  );
}

export function isSessionKeyTiedToAgent(
  sessionKey: string | undefined | null,
  agentId: string,
  defaultAgentId: string = DEFAULT_AGENT_ID,
): boolean {
  const normalizedAgentId = normalizeAgentId(agentId);
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed) {
    return normalizeAgentId(parsed.agentId) === normalizedAgentId;
  }
  return normalizedAgentId === normalizeAgentId(defaultAgentId);
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey) ?? "";
  if (!raw) {
    return false;
  }
  if (normalizeLowercaseStringOrEmpty(raw).startsWith("subagent:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeLowercaseStringOrEmpty(parsed?.rest).startsWith("subagent:");
}

/** ACP-backed sessions (`agent:<id>:acp:<uuid>`) belong to the Coding zone, not chat threads. */
export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey) ?? "";
  if (!raw) {
    return false;
  }
  if (normalizeLowercaseStringOrEmpty(raw).startsWith("acp:")) {
    return true;
  }
  const parsed = parseAgentSessionKey(raw);
  return normalizeLowercaseStringOrEmpty(parsed?.rest).startsWith("acp:");
}
