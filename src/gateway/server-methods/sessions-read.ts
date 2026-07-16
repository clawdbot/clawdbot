// Read-only session queries.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsCleanupParams,
  validateSessionsDescribeParams,
  validateSessionsListParams,
  validateSessionsPreviewParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  runSessionsCleanup,
  serializeSessionCleanupResult,
  type SessionEntry,
} from "../../config/sessions.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionPreviewItemsFromTranscript,
} from "../session-transcript-readers.js";
import {
  buildGatewaySessionRow,
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import { loadOptionalServerMethodModelCatalog } from "./optional-model-catalog.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  filterSessionStoreToConfiguredAgents,
  loadSessionEntriesForTarget,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionReadHandlers: GatewayRequestHandlers = {
  "sessions.search": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (params.agentId && !params.sessionKeys) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
      );
      return;
    }
    const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const sessionKeys = params.sessionKeys?.map((sessionKey) =>
      requestedAgentId
        ? resolveStoredSessionKeyForAgentStore({ cfg, agentId: requestedAgentId, sessionKey })
        : resolveSessionStoreKey({ cfg, sessionKey }),
    );
    const agentIds = new Set(
      sessionKeys?.map((sessionKey) =>
        requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
          ? requestedAgentId
          : resolveSessionStoreAgentId(cfg, sessionKey),
      ),
    );
    if (
      agentIds.size > 1 ||
      (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.search supports one agent per call"),
      );
      return;
    }
    const agentId =
      requestedAgentId ?? agentIds.values().next().value ?? resolveDefaultAgentId(cfg);
    try {
      const result = searchSessionTranscripts({
        agentId,
        query,
        limit: params.limit,
        ...(sessionKeys ? { sessionKeys } : {}),
      });
      respond(true, {
        results: result.hits,
        ...(result.indexing ? { indexing: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const configuredAgentsOnly = p.configuredAgentsOnly === true;
    const payload = await measureDiagnosticsTimelineSpan(
      "gateway.sessions.list",
      async () => {
        const { storePath, store } = measureDiagnosticsTimelineSpanSync(
          "gateway.sessions.list.store_load",
          () =>
            loadCombinedSessionStoreForGateway(cfg, {
              agentId: p.agentId,
            }),
          {
            config: cfg,
            phase: "sessions.list",
            attributes: {
              agentId: p.agentId ?? null,
              configuredAgentsOnly,
            },
          },
        );
        const listStore = configuredAgentsOnly
          ? filterSessionStoreToConfiguredAgents(cfg, store)
          : store;
        const modelCatalog = await measureDiagnosticsTimelineSpan(
          "gateway.sessions.list.model_catalog",
          () => loadOptionalServerMethodModelCatalog(context, "sessions.list"),
          {
            config: cfg,
            phase: "sessions.list",
          },
        );
        const result = await measureDiagnosticsTimelineSpan(
          "gateway.sessions.list.rows",
          () =>
            listSessionsFromStoreAsync({
              cfg,
              storePath,
              store: listStore,
              modelCatalog,
              opts: p,
            }),
          {
            config: cfg,
            phase: "sessions.list",
            attributes: {
              storeEntries: Object.keys(listStore).length,
            },
          },
        );
        const placementsBySessionId = context.workerSessionPlacementService?.getMany(
          result.sessions.flatMap((session) => (session.sessionId ? [session.sessionId] : [])),
        );
        const sessions = measureDiagnosticsTimelineSpanSync(
          "gateway.sessions.list.active_run_flags",
          () => {
            return result.sessions.map((session) => {
              const placementRecord = session.sessionId
                ? placementsBySessionId?.get(session.sessionId)
                : undefined;
              const activeRunState = resolveVisibleActiveSessionRunState({
                context,
                requestedKey: session.key,
                canonicalKey: session.key,
                sessionId: session.sessionId,
                ...(session.key === "global" && p.agentId ? { agentId: p.agentId } : {}),
                defaultAgentId: resolveDefaultAgentId(cfg),
              });
              return Object.assign({}, session, {
                hasActiveRun: activeRunState.active,
                ...(placementRecord
                  ? { placement: projectWorkerSessionPlacement(placementRecord) }
                  : {}),
                ...(activeRunState.runIds.length > 0
                  ? { activeRunIds: activeRunState.runIds }
                  : {}),
              });
            });
          },
          {
            config: cfg,
            phase: "sessions.list",
            attributes: {
              sessions: result.sessions.length,
            },
          },
        );
        return {
          ...result,
          sessions,
        };
      },
      {
        config: cfg,
        phase: "sessions.list",
        attributes: {
          agentId: p.agentId ?? null,
          configuredAgentsOnly,
        },
      },
    );
    respond(true, payload, undefined);
  },
  "sessions.cleanup": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) {
      return;
    }
    const p = params;
    try {
      const { mode, appliedSummaries } = await runSessionsCleanup({
        cfg: context.getRuntimeConfig(),
        opts: {
          agent: p.agent,
          allAgents: p.allAgents,
          enforce: p.enforce,
          activeKey: p.activeKey,
          fixMissing: p.fixMissing,
          fixDmScope: p.fixDmScope,
        },
      });
      const result = serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries,
      });
      respond(true, result, undefined);
      for (const summary of appliedSummaries) {
        emitSessionsChanged(context, {
          reason: "cleanup",
          sessionKey: undefined,
        });
        if (summary.wouldMutate) {
          context.logGateway.debug(
            `sessions.cleanup applied ${summary.storePath}: ${summary.beforeCount} -> ${summary.afterCount}`,
          );
        }
      }
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
  "sessions.preview": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => normalizeOptionalString(key ?? ""))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const cachedStoreTarget = resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key,
        });
        const store = storeCache.get(cachedStoreTarget.storePath) ?? cachedStoreTarget.store;
        storeCache.set(cachedStoreTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          {
            agentId: target.agentId,
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: target.canonicalKey,
            storePath: target.storePath,
          },
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.describe": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const { target, storePath, store, entry } = loadSessionEntriesForTarget({ key, cfg });
    if (!entry) {
      respond(true, { session: null }, undefined);
      return;
    }
    const row = buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key: target.canonicalKey,
      entry,
      includeDerivedTitles: p.includeDerivedTitles,
      includeLastMessage: p.includeLastMessage,
      transcriptUsageMaxBytes: 64 * 1024,
    });
    const placement = row.sessionId
      ? context.workerSessionPlacementService?.getMany([row.sessionId]).get(row.sessionId)
      : undefined;
    respond(
      true,
      {
        session: placement ? { ...row, placement: projectWorkerSessionPlacement(placement) } : row,
      },
      undefined,
    );
  },
  "sessions.resolve": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    if ("missing" in resolved) {
      respond(true, { ok: false }, undefined);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.get": async ({ params, respond, context }) => {
    const p = params as {
      key?: unknown;
      sessionKey?: unknown;
      limit?: unknown;
      agentId?: unknown;
    };
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { storePath, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const { messages } = await readRecentSessionMessagesWithStatsAsync(
      {
        agentId: requestedAgent.agentId,
        sessionEntry: entry,
        sessionId: entry.sessionId,
        sessionKey: key,
        storePath,
      },
      {
        maxMessages: limit,
        maxLines: limit * 20 + 20,
        allowResetArchiveFallback: true,
      },
    );
    respond(true, { messages }, undefined);
  },
};
