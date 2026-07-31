/** Full-text search over visible session transcripts. */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import {
  agentSessionKeysMatchByRequestKey,
  isIncognitoSessionKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveDefaultAgentId } from "../agent-scope-config.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionsSearchTool,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readPositiveIntegerParam, readStringParam, ToolInputError } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
const SESSIONS_SEARCH_MAX_LIMIT = 25;
const SESSIONS_SEARCH_MAX_SESSION_KEYS = 200;
// Bounds FTS token expansion on the synchronous gateway path while leaving ample query context.
const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;
const SESSIONS_SEARCH_MAX_BYTES = 32 * 1024;
const SESSIONS_SEARCH_SNIPPET_MAX_CHARS = 300;

const SessionsSearchToolSchema = Type.Object({
  query: Type.String({ maxLength: SESSIONS_SEARCH_MAX_QUERY_CHARS }),
  sessionKey: Type.Optional(Type.String()),
  limit: optionalPositiveIntegerSchema({ maximum: SESSIONS_SEARCH_MAX_LIMIT }),
});

const SessionsSearchHitSchema = Type.Object(
  {
    sessionKey: Type.String(),
    timestamp: Type.Number(),
    role: Type.Union([Type.Literal("assistant"), Type.Literal("user")]),
    snippet: Type.String(),
    score: Type.Number(),
    sessionId: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const SessionsSearchOutputSchema = Type.Union([
  Type.Object(
    {
      results: Type.Array(SessionsSearchHitSchema),
      indexing: Type.Optional(Type.Literal(true)),
      truncated: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

type GatewayCaller = typeof callGateway;

type GatewaySearchHit = {
  sessionKey?: unknown;
  sessionId?: unknown;
  messageId?: unknown;
  role?: unknown;
  timestamp?: unknown;
  snippet?: unknown;
  score?: unknown;
};

type SanitizedSearchHit = {
  sessionKey: string;
  timestamp: number;
  role: "assistant" | "user";
  snippet: string;
  score: number;
  sessionId?: string;
  messageId?: string;
};

type SearchSessionCandidate = {
  key: string;
  access: "direct" | "row";
  agentId?: string;
  ownerSessionKey?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
};

function sanitizeHit(params: {
  alias: string;
  hit: GatewaySearchHit;
  mainKey: string;
}): SanitizedSearchHit | undefined {
  const { hit } = params;
  if (
    typeof hit.sessionKey !== "string" ||
    (hit.role !== "user" && hit.role !== "assistant") ||
    typeof hit.timestamp !== "number" ||
    typeof hit.snippet !== "string" ||
    typeof hit.score !== "number"
  ) {
    return undefined;
  }
  const sanitized = redactToolPayloadText(hit.snippet);
  const snippet =
    sanitized.length > SESSIONS_SEARCH_SNIPPET_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, SESSIONS_SEARCH_SNIPPET_MAX_CHARS)}…`
      : sanitized;
  return {
    sessionKey: resolveDisplaySessionKey({
      key: hit.sessionKey,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    timestamp: hit.timestamp,
    role: hit.role,
    snippet,
    score: hit.score,
    ...(typeof hit.sessionId === "string" ? { sessionId: hit.sessionId } : {}),
    ...(typeof hit.messageId === "string" ? { messageId: hit.messageId } : {}),
  };
}

function capSearchHits(items: SanitizedSearchHit[]): {
  items: SanitizedSearchHit[];
  truncated: boolean;
} {
  const selected: SanitizedSearchHit[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = jsonUtf8Bytes(item);
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + itemBytes > SESSIONS_SEARCH_MAX_BYTES) {
      return { items: selected, truncated: true };
    }
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated: false };
}

async function listVisibleSearchSessions(params: {
  unscopedAgentId: string;
  effectiveRequesterAgentId?: string;
  effectiveRequesterKey: string;
  gatewayCall: GatewayCaller;
  rowGuard: {
    check: (row: {
      key: string;
      agentId?: string;
      ownerSessionKey?: string;
      parentSessionKey?: string;
      spawnedBy?: string;
    }) => { allowed: boolean };
  };
  restrictToSpawned: boolean;
}): Promise<SearchSessionCandidate[]> {
  const candidates = new Map<string, SearchSessionCandidate>();
  const candidateId = (candidate: Pick<SearchSessionCandidate, "agentId" | "key">) =>
    parseAgentSessionKey(candidate.key)
      ? candidate.key
      : `${candidate.agentId ?? ""}\0${candidate.key}`;
  if (
    params.rowGuard.check({
      key: params.effectiveRequesterKey,
      ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
    }).allowed
  ) {
    const requesterCandidate = {
      key: params.effectiveRequesterKey,
      access: "row",
      ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
    } satisfies SearchSessionCandidate;
    candidates.set(candidateId(requesterCandidate), requesterCandidate);
  }
  const listPages = async (agentId?: string) => {
    for (const archived of [false, true]) {
      let offset = 0;
      while (true) {
        const page = await params.gatewayCall<{
          sessions?: Array<{
            key?: unknown;
            agentId?: unknown;
            ownerSessionKey?: unknown;
            parentSessionKey?: unknown;
            spawnedBy?: unknown;
          }>;
          hasMore?: boolean;
          nextOffset?: number;
        }>({
          method: "sessions.list",
          params: {
            limit: 200,
            offset,
            archived,
            includeGlobal: !params.restrictToSpawned,
            includeUnknown: false,
            ...(agentId ? { agentId } : {}),
            ...(params.restrictToSpawned ? { spawnedBy: params.effectiveRequesterKey } : {}),
          },
        });
        for (const row of Array.isArray(page.sessions) ? page.sessions : []) {
          if (typeof row.key !== "string" || (!agentId && parseAgentSessionKey(row.key) === null)) {
            continue;
          }
          const visibilityRow = {
            key: row.key,
            ...(typeof row.agentId === "string"
              ? { agentId: row.agentId }
              : agentId
                ? { agentId }
                : {}),
            ...(typeof row.ownerSessionKey === "string"
              ? { ownerSessionKey: row.ownerSessionKey }
              : {}),
            ...(typeof row.parentSessionKey === "string"
              ? { parentSessionKey: row.parentSessionKey }
              : {}),
            ...(typeof row.spawnedBy === "string"
              ? { spawnedBy: row.spawnedBy }
              : params.restrictToSpawned
                ? { spawnedBy: params.effectiveRequesterKey }
                : {}),
          };
          if (params.rowGuard.check(visibilityRow).allowed) {
            const id = candidateId(visibilityRow);
            candidates.set(id, {
              ...candidates.get(id),
              ...visibilityRow,
              access: "row",
            });
          }
        }
        if (
          page.hasMore !== true ||
          typeof page.nextOffset !== "number" ||
          page.nextOffset <= offset
        ) {
          break;
        }
        offset = page.nextOffset;
      }
    }
  };
  await listPages();
  if (!params.restrictToSpawned) {
    // Unscoped keys cannot encode a foreign owner for a follow-up sessions_history call. Only the
    // requester's agent-scoped listing may contribute them; combined rows supply scoped keys.
    await listPages(params.unscopedAgentId);
  }
  return [...candidates.values()].toSorted((left, right) => left.key.localeCompare(right.key));
}

function compareSearchHits(left: SanitizedSearchHit, right: SanitizedSearchHit): number {
  return (
    right.score - left.score ||
    right.timestamp - left.timestamp ||
    left.sessionKey.localeCompare(right.sessionKey) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "")
  );
}

function resolveHitVisibilityKey(params: {
  candidateAgentId: string;
  candidateKey: string;
  hitKey: string;
}): string {
  const { candidateKey, hitKey } = params;
  if (hitKey === candidateKey) {
    return hitKey;
  }
  const hitAgentId = parseAgentSessionKey(hitKey)?.agentId;
  // Gateway canonicalizes unscoped aliases (notably `main`) to agent store keys. Preserve the
  // already-authorized request key so visibility and display use the caller's equivalent alias.
  return !parseAgentSessionKey(candidateKey) &&
    hitAgentId === params.candidateAgentId &&
    agentSessionKeysMatchByRequestKey(hitKey, candidateKey)
    ? candidateKey
    : hitKey;
}

function matchSearchHitCandidate(params: {
  agentId: string;
  candidates: SearchSessionCandidate[];
  hitKey: string;
}): { candidate: SearchSessionCandidate; visibilityKey: string } | undefined {
  for (const candidate of params.candidates) {
    const visibilityKey = resolveHitVisibilityKey({
      candidateAgentId: params.agentId,
      candidateKey: candidate.key,
      hitKey: params.hitKey,
    });
    if (visibilityKey === candidate.key) {
      return { candidate, visibilityKey };
    }
  }
  return undefined;
}

export function createSessionsSearchTool(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  const gatewayCall = opts?.callGateway ?? callGateway;
  return {
    label: "Sessions Search",
    name: "sessions_search",
    displaySummary: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSearchTool(),
    parameters: SessionsSearchToolSchema,
    outputSchema: SessionsSearchOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query")?.trim() ?? "";
      if (!query) {
        throw new ToolInputError("query must not be empty");
      }
      if (query.length > SESSIONS_SEARCH_MAX_QUERY_CHARS) {
        throw new ToolInputError(
          `query must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`,
        );
      }
      const limit =
        readPositiveIntegerParam(params, "limit", {
          max: SESSIONS_SEARCH_MAX_LIMIT,
        }) ?? SESSIONS_SEARCH_DEFAULT_LIMIT;
      const requestedSessionKey = readStringParam(params, "sessionKey");
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });

      let sessionKey: string | undefined;
      if (requestedSessionKey) {
        const resolved = await resolveSessionReference({
          sessionKey: requestedSessionKey,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned,
        });
        if (!resolved.ok) {
          return jsonResult({ status: resolved.status, error: resolved.error });
        }
        const visible = await resolveVisibleSessionReference({
          action: "list",
          resolvedSession: resolved,
          requesterSessionKey: effectiveRequesterKey,
          restrictToSpawned,
          visibilitySessionKey: requestedSessionKey,
        });
        if (!visible.ok) {
          return jsonResult({ status: visible.status, error: visible.error });
        }
        sessionKey = visible.key;
      }

      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const defaultAgentId = resolveDefaultAgentId(cfg);
      const requesterAgentId =
        opts?.agentId ?? resolveSessionAgentId({ sessionKey: effectiveRequesterKey, config: cfg });
      const guard = await createSessionVisibilityGuard({
        action: "history",
        defaultAgentId,
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      const rowGuard = createSessionVisibilityRowChecker({
        action: "history",
        defaultAgentId,
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        visibility,
        a2aPolicy,
      });
      if (sessionKey) {
        const access = !parseAgentSessionKey(sessionKey)
          ? rowGuard.check({ key: sessionKey, agentId: requesterAgentId })
          : guard.check(sessionKey);
        if (!access.allowed) {
          return jsonResult({ status: access.status, error: access.error });
        }
      }
      const searchSessions = (
        sessionKey
          ? [
              {
                key: sessionKey,
                access: "direct" as const,
                ...(!parseAgentSessionKey(sessionKey) ? { agentId: requesterAgentId } : {}),
              },
            ]
          : await listVisibleSearchSessions({
              unscopedAgentId: requesterAgentId,
              effectiveRequesterAgentId: opts?.agentId,
              effectiveRequesterKey,
              gatewayCall,
              rowGuard,
              restrictToSpawned,
            })
      )
        // Search excerpts are re-persisted in the caller transcript; incognito
        // sessions therefore stay absent even when the caller could otherwise see them.
        .filter((candidate) => !isIncognitoSessionKey(candidate.key));
      const visibleHits: SanitizedSearchHit[] = [];
      let indexing = false;
      let backendTruncated = false;
      const sessionsByAgent = new Map<string, SearchSessionCandidate[]>();
      for (const candidate of searchSessions) {
        const agentId = resolveSessionAgentId({
          sessionKey: candidate.key,
          config: cfg,
          agentId: parseAgentSessionKey(candidate.key) ? undefined : candidate.agentId,
        });
        const candidates = sessionsByAgent.get(agentId) ?? [];
        candidates.push(candidate);
        sessionsByAgent.set(agentId, candidates);
      }
      // Visibility filtering precedes result/byte caps so hidden hit counts never affect output.
      for (const [agentId, candidates] of [...sessionsByAgent].toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        for (
          let offset = 0;
          offset < candidates.length;
          offset += SESSIONS_SEARCH_MAX_SESSION_KEYS
        ) {
          const chunk = candidates.slice(offset, offset + SESSIONS_SEARCH_MAX_SESSION_KEYS);
          const result = await gatewayCall<{
            results?: GatewaySearchHit[];
            indexing?: boolean;
            truncated?: boolean;
          }>({
            method: "sessions.search",
            params: {
              agentId,
              query,
              limit: SESSIONS_SEARCH_MAX_LIMIT,
              sessionKeys: chunk.map((candidate) => candidate.key),
            },
          });
          indexing ||= result.indexing === true;
          backendTruncated ||= result.truncated === true;
          for (const hit of Array.isArray(result.results) ? result.results : []) {
            if (typeof hit.sessionKey !== "string") {
              continue;
            }
            const candidateMatch = matchSearchHitCandidate({
              agentId,
              candidates: chunk,
              hitKey: hit.sessionKey,
            });
            if (!candidateMatch) {
              continue;
            }
            const { candidate, visibilityKey } = candidateMatch;
            const access =
              candidate.access === "row" ||
              (candidate.agentId !== undefined && !parseAgentSessionKey(candidate.key))
                ? rowGuard.check(candidate)
                : guard.check(visibilityKey);
            if (!access.allowed) {
              continue;
            }
            const sanitized = sanitizeHit({
              alias,
              hit: { ...hit, sessionKey: visibilityKey },
              mainKey,
            });
            if (sanitized) {
              visibleHits.push(sanitized);
            }
          }
        }
      }
      visibleHits.sort(compareSearchHits);
      const limited = visibleHits.slice(0, limit);
      const capped = capSearchHits(limited);
      return jsonResult({
        results: capped.items,
        ...(indexing ? { indexing: true } : {}),
        ...(backendTruncated || visibleHits.length > limit || capped.truncated
          ? { truncated: true }
          : {}),
      });
    },
  };
}
