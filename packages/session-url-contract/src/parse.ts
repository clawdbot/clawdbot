export type ControlUiSessionPathTarget =
  | { namespace: "chat" | "dashboard"; kind: "main"; agentId: string }
  | {
      namespace: "chat" | "dashboard";
      kind: "short";
      agentId: string;
      shortId: string;
    }
  | {
      namespace: "chat" | "dashboard";
      kind: "literal";
      agentId: string;
      sessionKey: string;
      slugCandidate?: string;
    };

const SHORT_SESSION_REF_RE = /^(?:.*-)?([0-9a-f]{8,32})$/iu;
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/giu;
const FIXED_RESERVED_SESSION_RESTS = new Set(["main", "global", "boot", "sessions"]);

function optionalString(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "main";
  }
  if (VALID_AGENT_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_AGENT_ID_CHARS_RE, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "main"
  );
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/^\/+|\/+$/gu, "");
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

function isReservedSessionRest(rest: string, mainKey: string | undefined): boolean {
  const normalized = rest.toLowerCase();
  return (
    FIXED_RESERVED_SESSION_RESTS.has(normalized) ||
    normalized === (optionalString(mainKey)?.toLowerCase() ?? "main")
  );
}

function literalSessionKey(agentId: string, restSegments: readonly string[]): string | null {
  const normalizedAgentId = optionalString(agentId);
  if (!normalizedAgentId || restSegments.length === 0 || restSegments.some((segment) => !segment)) {
    return null;
  }
  return `agent:${normalizeAgentId(normalizedAgentId)}:${restSegments.join(":")}`;
}

export function parseControlUiSessionPath(
  pathname: string,
  basePath = "",
  mainKey?: string,
): ControlUiSessionPathTarget | null {
  const normalizedPath = normalizePath(pathname);
  for (const namespace of ["chat", "dashboard"] as const) {
    const prefix = `${normalizeBasePath(basePath)}/${namespace}/`;
    if (!normalizedPath.startsWith(prefix)) {
      continue;
    }
    const rawSegments = normalizedPath.slice(prefix.length).split("/");
    const rawAgentId = decodePathSegment(rawSegments[0] ?? "");
    if (!rawAgentId) {
      return null;
    }
    const agentId = normalizeAgentId(rawAgentId);
    if (rawSegments.length === 1) {
      return { namespace, kind: "main", agentId };
    }
    const forceLiteral = rawSegments[1] === "~key";
    const restSegments = rawSegments.slice(forceLiteral ? 2 : 1).map(decodePathSegment);
    if (restSegments.some((segment) => segment === null)) {
      return null;
    }
    const literalRestSegments = restSegments as string[];
    const sessionKey = literalSessionKey(agentId, literalRestSegments);
    if (!sessionKey) {
      return null;
    }
    if (forceLiteral) {
      return { namespace, kind: "literal", agentId, sessionKey };
    }
    if (literalRestSegments.length !== 1) {
      return { namespace, kind: "literal", agentId, sessionKey };
    }
    const segment = literalRestSegments[0] ?? "";
    if (isReservedSessionRest(segment, mainKey)) {
      return { namespace, kind: "literal", agentId, sessionKey };
    }
    const shortId = segment.match(SHORT_SESSION_REF_RE)?.[1]?.toLowerCase();
    return shortId
      ? { namespace, kind: "short", agentId, shortId }
      : { namespace, kind: "literal", agentId, sessionKey, slugCandidate: segment };
  }
  return null;
}
