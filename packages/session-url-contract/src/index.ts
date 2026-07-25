// Control UI session URL grammar shared by browser and plugin consumers.
export const CONTROL_UI_SESSION_NAMESPACES = ["chat", "dashboard"] as const;

export type ControlUiSessionNamespace = (typeof CONTROL_UI_SESSION_NAMESPACES)[number];

export type ControlUiSessionPathTarget =
  | { namespace: ControlUiSessionNamespace; kind: "main"; agentId: string }
  | {
      namespace: ControlUiSessionNamespace;
      kind: "short";
      agentId: string;
      shortId: string;
      literalSessionKey: string;
    }
  | {
      namespace: ControlUiSessionNamespace;
      kind: "literal";
      agentId: string;
      sessionKey: string;
    };

export type BuildControlUiSessionPathParams = {
  namespace: ControlUiSessionNamespace;
  sessionKey: string;
  fallbackAgentId?: string;
  basePath?: string;
  displayName?: string;
  mainKey?: string;
  shortIdLength?: number;
};

const SESSION_UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const SHORT_SESSION_REF_RE = /^(?:.*-)?([0-9a-f]{8,32})$/iu;
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/giu;
const SESSION_SLUG_MAX_LENGTH = 48;
const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";

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

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
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

function decodePathSegment(segment: string): string | null {
  if (segment === "~dot") {
    return ".";
  }
  if (segment === "~dotdot") {
    return "..";
  }
  try {
    return decodeURIComponent(segment.startsWith("~~") ? segment.slice(1) : segment) || null;
  } catch {
    return null;
  }
}

function encodePathSegment(segment: string): string {
  if (segment === ".") {
    return "~dot";
  }
  if (segment === "..") {
    return "~dotdot";
  }
  const encoded = encodeURIComponent(segment);
  return encoded.startsWith("~") ? `~${encoded}` : encoded;
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

export function controlUiSessionKeyUuid(sessionKey: string | undefined | null): string | null {
  const rawKey = optionalString(sessionKey);
  const rest = rawKey ? agentSessionKeyParts(rawKey)?.rest : undefined;
  const uuid = rest?.match(SESSION_UUID_SUFFIX_RE)?.[1];
  return uuid ? uuid.toLowerCase().replaceAll("-", "") : null;
}

export function controlUiShortIdFromSessionRef(sessionRef: string): string | null {
  return sessionRef.match(SHORT_SESSION_REF_RE)?.[1]?.toLowerCase() ?? null;
}

export function controlUiUniqueShortIdPrefix(
  value: string,
  candidates: readonly string[],
  truncated = false,
): string | null {
  const uuid = value.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{8,32}$/u.test(uuid)) {
    return null;
  }
  if (truncated) {
    return uuid;
  }
  const normalizedCandidates = candidates.map((candidate) =>
    candidate.toLowerCase().replaceAll("-", ""),
  );
  for (let length = 8; length <= uuid.length; length += 1) {
    const prefix = uuid.slice(0, length);
    if (normalizedCandidates.filter((candidate) => candidate.startsWith(prefix)).length === 1) {
      return prefix;
    }
  }
  return uuid;
}

export function buildControlUiLiteralSessionKey(
  agentId: string,
  restSegments: readonly string[],
): string | null {
  const normalizedAgentId = optionalString(agentId);
  if (!normalizedAgentId || restSegments.length === 0 || restSegments.some((segment) => !segment)) {
    return null;
  }
  return `agent:${normalizeAgentId(normalizedAgentId)}:${restSegments.join(":")}`;
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
  const encodedAgentId = encodeURIComponent(agentId);
  const rest = parsed?.rest ?? rawKey;
  const normalizedRest = rest.toLowerCase();
  const mainKey = optionalString(params.mainKey)?.toLowerCase() ?? DEFAULT_MAIN_KEY;
  if (
    normalizedRest === DEFAULT_MAIN_KEY ||
    normalizedRest === mainKey ||
    normalizedRest === "global"
  ) {
    return `${namespace}/${encodedAgentId}`;
  }
  const uuid = parsed ? controlUiSessionKeyUuid(rawKey) : null;
  if (uuid) {
    const requestedLength = params.shortIdLength ?? 8;
    const length = Math.min(uuid.length, Math.max(8, Math.floor(requestedLength)));
    const shortId = uuid.slice(0, length);
    const slug = controlUiSessionSlug(params.displayName);
    return `${namespace}/${encodedAgentId}/${slug ? `${slug}-` : ""}${shortId}`;
  }
  const segments = rest.split(":");
  if (segments.some((segment) => !segment)) {
    return null;
  }
  return `${namespace}/${encodedAgentId}/${segments.map(encodePathSegment).join("/")}`;
}

export function parseControlUiSessionPath(
  pathname: string,
  basePath = "",
): ControlUiSessionPathTarget | null {
  const normalizedPath = normalizePath(pathname);
  for (const namespace of CONTROL_UI_SESSION_NAMESPACES) {
    const prefix = `${normalizeBasePath(basePath)}/${namespace}/`;
    if (!normalizedPath.startsWith(prefix)) {
      continue;
    }
    const segments = normalizedPath.slice(prefix.length).split("/").map(decodePathSegment);
    const rawAgentId = segments[0];
    if (!rawAgentId || segments.some((segment) => segment === null)) {
      return null;
    }
    const agentId = normalizeAgentId(rawAgentId);
    if (segments.length === 1) {
      return { namespace, kind: "main", agentId };
    }
    const restSegments = segments.slice(1) as string[];
    const sessionKey = buildControlUiLiteralSessionKey(agentId, restSegments);
    if (!sessionKey) {
      return null;
    }
    const shortId =
      restSegments.length === 1 ? controlUiShortIdFromSessionRef(restSegments[0] ?? "") : null;
    return shortId
      ? { namespace, kind: "short", agentId, shortId, literalSessionKey: sessionKey }
      : { namespace, kind: "literal", agentId, sessionKey };
  }
  return null;
}
