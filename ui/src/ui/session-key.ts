// Control UI module implements session key behavior.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "./string-coerce.ts";

export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";

export type UiSessionDefaultsHost = {
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: { snapshot?: unknown } | null;
};

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

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

function normalizeMainKey(value: string | undefined | null): string {
  return normalizeOptionalLowercaseString(value) ?? DEFAULT_MAIN_KEY;
}

function readSessionDefaults(
  host: Pick<UiSessionDefaultsHost, "hello">,
): { defaultAgentId?: string | null; mainKey?: string | null } | undefined {
  const snapshot = host.hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return undefined;
  }
  const defaults = snapshot.sessionDefaults;
  return defaults && typeof defaults === "object"
    ? (defaults as { defaultAgentId?: string | null; mainKey?: string | null })
    : undefined;
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

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  return (
    normalizeLowercaseStringOrEmpty(trimmed)
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
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

function normalizeDefaultMainSessionAliasForUi(sessionKey: string | undefined | null): string {
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
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
