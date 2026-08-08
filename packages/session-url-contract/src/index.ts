// Control UI session URL grammar shared by browser and plugin consumers.
export type ControlUiSessionNamespace = "chat" | "dashboard";

type BuildControlUiSessionPathParams = {
  namespace: ControlUiSessionNamespace;
  sessionKey: string;
  fallbackAgentId?: string;
  basePath?: string;
  displayName?: string;
  mainKey?: string;
  shortIdLength?: number;
};

export const SESSION_UUID_SUFFIX_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
export const SHORT_SESSION_ID_RE = /^[0-9a-f]{8,32}$/iu;
const SHORT_SESSION_REF_RE = /^(?:.*-)?([0-9a-f]{8,32})$/iu;
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/giu;
const SESSION_SLUG_MAX_LENGTH = 48;
const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";
const FIXED_RESERVED_SESSION_RESTS = new Set(["main", "global", "boot", "sessions"]);

function optionalString(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_AGENT_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_AGENT_ID_CHARS_RE, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = basePath?.trim().replace(/^\/+|\/+$/gu, "") ?? "";
  return trimmed ? `/${trimmed}` : "";
}

function agentSessionKeyParts(sessionKey: string): { agentId: string; rest: string } | null {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0]?.toLowerCase() !== "agent") {
    return null;
  }
  const agentId = optionalString(parts[1]);
  const restSegments = parts.slice(2);
  if (!agentId || restSegments.some((segment) => !segment)) {
    return null;
  }
  return { agentId: normalizeAgentId(agentId), rest: restSegments.join(":") };
}

function encodePathSegment(segment: string): string {
  if (segment === ".") {
    return "~dot";
  }
  if (segment === "..") {
    return "~dotdot";
  }
  // encodeURIComponent leaves "." alone, so a key segment like "release.js" would
  // reach the server looking like a static asset request and never hit the SPA.
  // pathForWorkboardBoard escapes dots for the same reason.
  const encoded = encodeURIComponent(segment).replaceAll(".", "%2E");
  return encoded.startsWith("~") ? `~${encoded}` : encoded;
}

function isReservedSessionRest(rest: string, mainKey: string | undefined): boolean {
  const normalized = rest.toLowerCase();
  return (
    FIXED_RESERVED_SESSION_RESTS.has(normalized) ||
    normalized === (optionalString(mainKey)?.toLowerCase() ?? DEFAULT_MAIN_KEY)
  );
}

export function controlUiSessionSlug(displayName: string | undefined | null): string {
  const tokens = (displayName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .split("-")
    .filter(Boolean);
  while (tokens.length > 0 && /^[0-9a-f]+$/u.test(tokens.at(-1) ?? "")) {
    tokens.pop();
  }
  return tokens.join("-").slice(0, SESSION_SLUG_MAX_LENGTH).replace(/-+$/gu, "");
}

function controlUiShortIdFromSessionRef(sessionRef: string): string | null {
  return sessionRef.match(SHORT_SESSION_REF_RE)?.[1]?.toLowerCase() ?? null;
}

export function buildControlUiSessionPath(params: BuildControlUiSessionPathParams): string | null {
  const rawKey = optionalString(params.sessionKey);
  const parsed = rawKey ? agentSessionKeyParts(rawKey) : null;
  const fallbackAgentId = optionalString(params.fallbackAgentId);
  const agentId = parsed?.agentId ?? (fallbackAgentId ? normalizeAgentId(fallbackAgentId) : null);
  if (!rawKey || !agentId || (!parsed && rawKey.toLowerCase().startsWith("agent:"))) {
    return null;
  }
  const namespace = `${normalizeBasePath(params.basePath)}/${params.namespace}`;
  const encodedAgentId = encodePathSegment(agentId);
  const rest = parsed?.rest ?? rawKey;
  const normalizedRest = rest.toLowerCase();
  const mainKey = optionalString(params.mainKey)?.toLowerCase() ?? DEFAULT_MAIN_KEY;
  if (
    (!parsed && normalizedRest === DEFAULT_MAIN_KEY) ||
    normalizedRest === mainKey ||
    normalizedRest === "global"
  ) {
    return `${namespace}/${encodedAgentId}`;
  }
  const matchedUuid = parsed?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
  const uuid = matchedUuid?.toLowerCase().replaceAll("-", "") ?? null;
  if (uuid) {
    const requestedLength = params.shortIdLength ?? 8;
    let length = Math.min(uuid.length, Math.max(8, Math.floor(requestedLength)));
    const slug = controlUiSessionSlug(params.displayName);
    let sessionRef = `${slug ? `${slug}-` : ""}${uuid.slice(0, length)}`;
    while (length < uuid.length && isReservedSessionRest(sessionRef, params.mainKey)) {
      length += 1;
      sessionRef = `${slug ? `${slug}-` : ""}${uuid.slice(0, length)}`;
    }
    return isReservedSessionRest(sessionRef, params.mainKey)
      ? null
      : `${namespace}/${encodedAgentId}/${sessionRef}`;
  }
  const segments = rest.split(":");
  if (segments.some((segment) => !segment)) {
    return null;
  }
  if (segments.length === 1) {
    const segment = segments[0] ?? "";
    if (
      !isReservedSessionRest(segment, params.mainKey) &&
      controlUiShortIdFromSessionRef(segment)
    ) {
      return `${namespace}/${encodedAgentId}/~key/${encodePathSegment(segment)}`;
    }
  }
  return `${namespace}/${encodedAgentId}/${segments.map(encodePathSegment).join("/")}`;
}
