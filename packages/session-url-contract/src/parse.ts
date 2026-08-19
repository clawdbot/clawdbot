import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  isReservedSessionRest,
  normalizeControlUiBasePath,
  parseShortSessionRef,
} from "./grammar.js";

export type ControlUiSessionPathTarget =
  | { namespace: "chat" | "dashboard"; kind: "main"; agentId: string }
  | {
      namespace: "chat" | "dashboard";
      kind: "short";
      agentId: string;
      shortId: string;
      /** Exact decoded key candidate for route resolution after a short lookup misses. */
      literalSessionKey: string;
      /**
       * Display-name slug that preceded the id, when the reference carried one. The id
       * stays authoritative; this only breaks a tie between sessions whose ids share the
       * given prefix, so a short link keeps resolving to one session.
       */
      slugHint?: string;
    }
  | {
      namespace: "chat" | "dashboard";
      kind: "literal";
      agentId: string;
      sessionKey: string;
      slugCandidate?: string;
    };

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

function literalSessionKey(agentId: string, restSegments: readonly string[]): string | null {
  const normalizedAgentId = normalizeNullableString(agentId);
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
    const prefix = `${normalizeControlUiBasePath(basePath)}/${namespace}/`;
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
    const shortRef = parseShortSessionRef(segment);
    if (!shortRef) {
      return { namespace, kind: "literal", agentId, sessionKey, slugCandidate: segment };
    }
    return { namespace, kind: "short", agentId, literalSessionKey: sessionKey, ...shortRef };
  }
  return null;
}
