// Control UI module implements session key behavior.
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";

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
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }
  const agentId = normalizeOptionalString(parts[1]);
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) {
    return null;
  }
  return { agentId, rest };
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

function normalizeMainKey(value: string | undefined | null): string {
  return normalizeOptionalLowercaseString(value) ?? DEFAULT_MAIN_KEY;
}

export function normalizeSessionKeyForUiComparison(sessionKey: string | undefined | null): string {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return "";
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
  opts?: { rowKind?: string | null; requireGlobalRowForMainAlias?: boolean },
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  if (rest === "global") {
    return normalizeAgentId(parsed.agentId);
  }
  if (rest !== DEFAULT_MAIN_KEY && rest !== resolveUiConfiguredMainKey(host)) {
    return null;
  }
  if (opts?.requireGlobalRowForMainAlias && opts.rowKind !== "global") {
    return null;
  }
  return normalizeAgentId(parsed.agentId);
}

export function isUiGlobalSessionKey(sessionKey: string | undefined | null): boolean {
  return normalizeLowercaseStringOrEmpty(sessionKey) === "global";
}

function resolveUiMainAliasAgentId(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): string | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const rest = normalizeLowercaseStringOrEmpty(parsed.rest);
  const mainKey = resolveUiConfiguredMainKey(host);
  return rest === DEFAULT_MAIN_KEY || rest === mainKey ? normalizeAgentId(parsed.agentId) : null;
}

/** True when the configured main session routes to the global stream (session.scope="global"). */
export function isUiGlobalScopeConfigured(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
): boolean {
  const scope = normalizeOptionalLowercaseString(host.agentsList?.scope);
  if (scope) {
    return scope === "global";
  }
  return isUiGlobalSessionKey(resolveUiCanonicalMainSessionKey(host));
}

export function resolveUiCanonicalMainSessionKey(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
): string {
  const defaults = readSessionDefaults(host);
  const advertised = normalizeOptionalString(defaults?.mainSessionKey);
  if (advertised) {
    return advertised;
  }
  // Global scope routes main to the "global" sentinel even when the gateway
  // has not advertised a main session key yet (e.g. pre-hello snapshots).
  if (normalizeOptionalLowercaseString(host.agentsList?.scope) === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({
    agentId: resolveUiDefaultAgentId(host),
    mainKey: resolveUiConfiguredMainKey(host),
  });
}

function normalizeUiSessionEventKey(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): string | null {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return null;
  }
  const mainKey = resolveUiConfiguredMainKey(host);
  const defaultAgentId = resolveUiDefaultAgentId(host);
  const canonicalMain = resolveUiCanonicalMainSessionKey(host);
  const aliases = new Set(
    [
      DEFAULT_MAIN_KEY,
      mainKey,
      canonicalMain,
      buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey: DEFAULT_MAIN_KEY }),
      buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey }),
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizeSessionKeyForUiComparison),
  );
  const normalized = normalizeSessionKeyForUiComparison(raw);
  return aliases.has(normalized) ? normalizeSessionKeyForUiComparison(canonicalMain) : normalized;
}

export function canonicalUiSessionKeyForPersistence(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): string {
  return normalizeUiSessionEventKey(host, sessionKey) ?? "";
}

function areUiSessionKeysEquivalentForHost(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  left: string | undefined | null,
  right: string | undefined | null,
): boolean {
  const normalizedLeft = normalizeUiSessionEventKey(host, left);
  const normalizedRight = normalizeUiSessionEventKey(host, right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function uiSessionEventMatches(
  host: UiSessionDefaultsHost & { sessionKey: string },
  eventSessionKey: string | undefined | null,
  eventAgentId?: string | null,
): boolean {
  const eventKey = normalizeOptionalString(eventSessionKey);
  if (!eventKey) {
    return true;
  }
  const keysMatch = areUiSessionKeysEquivalentForHost(host, eventKey, host.sessionKey);
  const selectedAliasAgentId = resolveUiMainAliasAgentId(host, host.sessionKey);
  const globalAliasMatches =
    selectedAliasAgentId !== null &&
    isUiGlobalSessionKey(eventKey) &&
    selectedAliasAgentId === normalizeAgentId(eventAgentId ?? resolveUiDefaultAgentId(host));
  if (!keysMatch && !globalAliasMatches) {
    return false;
  }
  if (!isUiGlobalSessionKey(host.sessionKey) || !isUiGlobalSessionKey(eventKey)) {
    return true;
  }
  const selectedAgentId = resolveUiSelectedGlobalAgentId(host);
  const normalizedEventAgentId = normalizeOptionalString(eventAgentId);
  return normalizedEventAgentId
    ? normalizeAgentId(normalizedEventAgentId) === selectedAgentId
    : selectedAgentId === resolveUiDefaultAgentId(host);
}

export function isUiSelectedGlobalSessionKey(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  sessionKey: string | undefined | null,
): boolean {
  if (isUiGlobalSessionKey(sessionKey)) {
    return true;
  }
  return resolveUiMainAliasAgentId(host, sessionKey) !== null;
}

export function resolveUiSelectedSessionAgentId(
  host: Pick<UiSessionDefaultsHost, "assistantAgentId" | "agentsList" | "hello"> & {
    sessionKey?: string | null;
  },
  sessionKey: string | undefined | null = host.sessionKey,
): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  return resolveUiKnownSelectedGlobalAgentId(host);
}

export function uiSessionRowMatchesSelectedChat(
  host: Pick<UiSessionDefaultsHost, "agentsList" | "hello">,
  rowKey: string | undefined | null,
  selectedSessionKey: string | undefined | null,
): boolean {
  if (areUiSessionKeysEquivalent(rowKey, selectedSessionKey)) {
    return true;
  }
  return Boolean(
    isUiGlobalSessionKey(rowKey) && resolveUiGlobalAliasAgentId(host, selectedSessionKey),
  );
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
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
