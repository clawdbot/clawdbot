// Read-only session queries.
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsListParams,
  validateSessionsCleanupParams,
  validateSessionsDescribeParams,
  validateSessionsListParams,
  validateSessionsPreviewParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import {
  listSessionMembershipKeys,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
  runSessionsCleanup,
  serializeSessionCleanupResult,
} from "../../config/sessions.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import {
  resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import {
  canAccessIncognitoSession,
  createSessionListEntryFilter,
  isGatewayAdmin,
  prepareSessionSharing,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionPreviewItemsFromTranscript,
} from "../session-transcript-readers.js";
import { projectGatewaySessionActiveRun } from "../session-utils-display.js";
import {
  createGatewaySessionStoreDiscoveryCache,
  type GatewaySessionStoreCache,
} from "../session-utils-store-lookup.js";
import {
  buildGatewaySessionRow,
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGatewayCore,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
  resolveSessionsListDefaultsAgentId,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { readPreparedServerMethodModelCatalog } from "./optional-model-catalog.js";
import { createVisibleActiveSessionRunProjector } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveGatewayModelSelectionPolicy } from "./session-model-selection-policy.js";
import {
  createSessionPlacementBatchProjector,
  readSessionPlacementFields,
} from "./session-placement-read-projection.js";
import { listFilter } from "./sessions-board-inventory.js";
import { respondWithCachedSessionList } from "./sessions-list-cache.js";
import { resolveSessionSearchScope } from "./sessions-search-scope.js";
import { loadSessionEntriesForTarget, requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionReadHandlers: GatewayRequestHandlers = {
  "sessions.search": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    const restrictIncognito =
      Boolean(gatewayClientSessionCreator(client)) && !isGatewayAdmin(client);
    const roleVisibilityFilter = hasOperatorBoundary(client, cfg)
      ? createSessionListEntryFilter({ client, cfg })
      : undefined;
    const restrictVisibility = restrictIncognito || Boolean(roleVisibilityFilter);
    const canSearchSessionKey = (sessionKey: string) => {
      if (
        isIncognitoSessionKey(sessionKey) &&
        !canAccessIncognitoSession({ cfg, client: client ?? null, sessionKey })
      ) {
        return false;
      }
      if (!roleVisibilityFilter) {
        return true;
      }
      const target = resolveSessionSharingTarget({ cfg, sessionKey });
      return Boolean(target && roleVisibilityFilter(target.storeKey, target.entry));
    };
    const scope = resolveSessionSearchScope(cfg, params);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const { agentId, configured, requestedAgentId, sessionKeys } = scope;
    if (requestedAgentId && !params.sessionKeys && configured) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
      );
      return;
    }
    const scopedSessionKeys = (
      configured
        ? sessionKeys
        : sessionKeys?.filter((sessionKey) => {
            const sessionAgentId =
              requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
                ? requestedAgentId
                : resolveSessionStoreAgentId(cfg, sessionKey);
            return sessionAgentId === agentId;
          })
    )?.filter(canSearchSessionKey);
    const searchTargets = configured
      ? [{ agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) }]
      : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId);
    if (!configured && (searchTargets.length === 0 || scopedSessionKeys?.length === 0)) {
      respond(true, { results: [] }, undefined);
      return;
    }
    try {
      const targetResults = searchTargets.flatMap((target) => {
        const targetSessionKeys =
          scopedSessionKeys ??
          (restrictVisibility
            ? listSessionEntriesReadOnly({ agentId: target.agentId, storePath: target.storePath })
                .map((entry) => entry.sessionKey)
                .filter((sessionKey) => {
                  if (!canSearchSessionKey(sessionKey)) {
                    return false;
                  }
                  const parsed = parseAgentSessionKey(sessionKey);
                  return !parsed || normalizeAgentId(parsed.agentId) === agentId;
                })
            : undefined);
        if (targetSessionKeys?.length === 0) {
          return [];
        }
        return [
          searchSessionTranscripts({
            ...target,
            query,
            // Over-fetch retired multi-store searches so deduplication can still fill the caller's
            // requested page when the same transcript was copied during a store migration.
            limit: configured ? params.limit : 25,
            ...(targetSessionKeys ? { sessionKeys: targetSessionKeys } : {}),
          }),
        ];
      });
      const limit = params.limit ?? 10;
      const sortedHits = targetResults
        .flatMap((result) => result.hits)
        .toSorted(
          (left, right) =>
            right.score - left.score ||
            right.timestamp - left.timestamp ||
            left.messageId.localeCompare(right.messageId),
        );
      const seenHits = new Set<string>();
      const hits = sortedHits.filter((hit) => {
        const identity = `${hit.sessionKey}\u0000${hit.sessionId}\u0000${hit.messageId}`;
        if (seenHits.has(identity)) {
          return false;
        }
        seenHits.add(identity);
        return true;
      });
      respond(true, {
        results: hits.slice(0, limit),
        ...(targetResults.some((result) => result.indexing) ? { indexing: true } : {}),
        ...(targetResults.some((result) => result.truncated) || hits.length > limit
          ? { truncated: true }
          : {}),
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.list": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params as SessionsListParams;
    const cfg = context.getRuntimeConfig();
    const configuredAgentsOnly = p.configuredAgentsOnly === true;
    const identityId = gatewayClientSessionCreator(client)?.id;
    const defaultsAgentId = resolveSessionsListDefaultsAgentId(cfg, p.agentId);
    const modelSelectionTarget = resolveGatewayModelSelectionPolicy({
      agentId: defaultsAgentId,
      callerScopes: client?.connect?.scopes ?? [],
      cfg,
    }).target;
    const preparedModelCatalogByAgent = await measureDiagnosticsTimelineSpan(
      "gateway.sessions.list.model_catalog",
      async () => {
        // Scoped listings use exactly the requested agent's completed catalog.
        // Unscoped listings must not apply one agent's catalog to rows owned by
        // another agent; resolve each configured agent's completed snapshot
        // (read-only, never starts discovery) so row projections stay
        // owner-scoped while cache reuse stays fenced per agent.
        const catalogByAgent = new Map<
          string,
          Awaited<ReturnType<typeof readPreparedServerMethodModelCatalog>>
        >();
        const agentIds = p.agentId ? [normalizeAgentId(p.agentId)] : listAgentIds(cfg);
        for (const agentId of agentIds) {
          catalogByAgent.set(
            agentId,
            await readPreparedServerMethodModelCatalog(context, { agentId }),
          );
        }
        return catalogByAgent;
      },
      {
        config: cfg,
        phase: "sessions.list",
      },
    );
    const run = () =>
      measureDiagnosticsTimelineSpan(
        "gateway.sessions.list",
        async function listVisibleSessions(
          options: {
            allowFullReload?: boolean;
            excludedKeys?: ReadonlySet<string>;
            loaded?: ReturnType<typeof loadCombinedSessionStoreForGatewayCore> & {
              modelCatalogByAgent: Map<
                string,
                Awaited<ReturnType<typeof readPreparedServerMethodModelCatalog>>
              >;
            };
            rowRepairAttempted?: boolean;
          } = {},
        ): Promise<Awaited<ReturnType<typeof listSessionsFromStoreAsync>>> {
          let loaded = options.loaded;
          if (!loaded) {
            const loadedStore = measureDiagnosticsTimelineSpanSync(
              "gateway.sessions.list.store_load",
              () =>
                loadCombinedSessionStoreForGatewayCore(cfg, {
                  agentId: p.agentId,
                  configuredAgentsOnly,
                  projection: "list",
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
            loaded = { ...loadedStore, modelCatalogByAgent: preparedModelCatalogByAgent };
          }
          const { durableStorePath, durableTargets, modelCatalogByAgent, storePath } = loaded;
          const entryFilter = listFilter({ p, loaded, defaultsAgentId, client, cfg, options });
          const selectionRuns = p.search?.trim()
            ? createVisibleActiveSessionRunProjector(context)
            : undefined;
          const result = await measureDiagnosticsTimelineSpan(
            "gateway.sessions.list.rows",
            () =>
              listSessionsFromStoreAsync({
                cfg,
                durableStorePath,
                ...(entryFilter ? { entryFilter } : {}),
                storePath,
                store: loaded.store,
                modelCatalog: modelCatalogByAgent,
                opts: p,
                ...(selectionRuns
                  ? {
                      projectActiveRun: (key, entry, agentId) =>
                        selectionRuns({
                          requestedKey: key,
                          canonicalKey: key,
                          sessionId: entry.sessionId,
                          agentId,
                          defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, key),
                        }),
                    }
                  : {}),
                ...(p.involvingMe === true && identityId ? { involvingActorId: identityId } : {}),
                ...(p.ownerFirst === true && identityId ? { ownerFirstActorId: identityId } : {}),
              }),
            {
              config: cfg,
              phase: "sessions.list",
            },
          );
          result.defaults = { ...result.defaults, modelSelectionTarget };
          const { sharingTargets, membershipKeys } = await measureDiagnosticsTimelineSpan(
            "gateway.sessions.list.sharing",
            () => {
              // One cache for the whole listing: sharing resolution otherwise
              // materialized every entry of a candidate store once per row.
              const sharingStoreCache: GatewaySessionStoreCache = new Map();
              const targetDiscoveryCache = createGatewaySessionStoreDiscoveryCache({
                cfg,
                targets: durableTargets,
                agentIds: result.sessions.map((session) =>
                  session.key === "global" && p.agentId
                    ? p.agentId
                    : resolveSessionStoreAgentId(cfg, session.key),
                ),
              });
              const resolvedSharingTargets = result.sessions.map((session) =>
                resolveSessionSharingTarget({
                  cfg,
                  sessionKey: session.key,
                  storeCache: sharingStoreCache,
                  targetDiscoveryCache,
                  ...(session.key === "global" && p.agentId ? { agentId: p.agentId } : {}),
                }),
              );
              const resolvedMembershipKeys = new Set<string>();
              if (identityId && !isGatewayAdmin(client)) {
                const groups = new Map<
                  string,
                  {
                    agentId: string;
                    sessionKeys: string[];
                    storePath: string;
                  }
                >();
                for (const target of resolvedSharingTargets) {
                  if (!target) {
                    continue;
                  }
                  const groupKey = `${target.agentId}\0${target.storePath}`;
                  const group = groups.get(groupKey) ?? {
                    agentId: target.agentId,
                    sessionKeys: [],
                    storePath: target.storePath,
                  };
                  group.sessionKeys.push(target.storeKey);
                  groups.set(groupKey, group);
                }
                for (const group of groups.values()) {
                  const firstSessionKey = group.sessionKeys[0];
                  if (!firstSessionKey) {
                    continue;
                  }
                  for (const sessionKey of listSessionMembershipKeys(
                    {
                      agentId: group.agentId,
                      sessionKey: firstSessionKey,
                      storePath: group.storePath,
                    },
                    group.sessionKeys,
                    identityId,
                  )) {
                    resolvedMembershipKeys.add(
                      `${group.agentId}\0${group.storePath}\0${sessionKey}`,
                    );
                  }
                }
              }
              return {
                sharingTargets: resolvedSharingTargets,
                membershipKeys: resolvedMembershipKeys,
              };
            },
            {
              config: cfg,
              phase: "sessions.list",
              attributes: {
                sessions: result.sessions.length,
              },
            },
          );
          const projectPlacement = createSessionPlacementBatchProjector(context, result.sessions);
          const projectActiveRun = createVisibleActiveSessionRunProjector(context);
          // These rows are unpublished; decorate them with fresh caller facts after the yields.
          const sharing = prepareSessionSharing({ client, cfg });
          measureDiagnosticsTimelineSpanSync(
            "gateway.sessions.list.active_run_flags",
            () =>
              result.sessions.forEach((session, index) => {
                const sharingTarget = sharingTargets[index];
                const visibility = sharingTarget
                  ? resolveSessionVisibility(sharingTarget.entry)
                  : "shared";
                const activeRunState = projectActiveRun({
                  requestedKey: session.key,
                  canonicalKey: session.key,
                  sessionId: session.sessionId,
                  agentId: session.agentId,
                  defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, session.key),
                });
                Object.assign(session, {
                  visibility,
                  ...(sharingTarget
                    ? {
                        sharingRole: sharing.roleForTarget(
                          sharingTarget,
                          membershipKeys.has(
                            `${sharingTarget.agentId}\0${sharingTarget.storePath}\0${sharingTarget.storeKey}`,
                          ),
                        ),
                      }
                    : {}),
                  ...projectGatewaySessionActiveRun(activeRunState, session.status),
                  ...projectPlacement(session.sessionId),
                  ...(activeRunState.runIds !== undefined
                    ? { activeRunIds: activeRunState.runIds }
                    : {}),
                });
              }),
            {
              config: cfg,
              phase: "sessions.list",
              attributes: {
                sessions: result.sessions.length,
              },
            },
          );
          // Reapply the canonical policy to freshly resolved rows after awaits:
          // visibility, ownership, membership, and operator roles may all drift.
          const currentVisibilityFilter = sharing.entryFilter;
          const visibleSessions = currentVisibilityFilter
            ? result.sessions.filter((_, index) => {
                const target = sharingTargets[index];
                return target ? currentVisibilityFilter(target.storeKey, target.entry) : false;
              })
            : result.sessions;
          if (visibleSessions.length !== result.sessions.length) {
            const visibleKeys = new Set(visibleSessions.map((session) => session.key));
            const excludedKeys = new Set(options.excludedKeys);
            for (const session of result.sessions) {
              if (!visibleKeys.has(session.key)) {
                excludedKeys.add(session.key);
              }
            }
            if (!options.rowRepairAttempted) {
              // Excluding only freshly rejected rows refills this page from the already-loaded
              // store, preserving cursor continuity without multiplying catalog/store work.
              return await listVisibleSessions({
                ...options,
                excludedKeys,
                loaded,
                rowRepairAttempted: true,
              });
            }
            if (options.allowFullReload !== false) {
              // A second visibility drift means the loaded snapshot cannot restore a coherent
              // page. One full reload is the last resort; repeated drift below fails closed.
              return await listVisibleSessions({ allowFullReload: false });
            }
            return { ...result, count: visibleSessions.length, sessions: visibleSessions };
          }
          return { ...result, sessions: visibleSessions };
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
    await respondWithCachedSessionList({
      client,
      config: cfg,
      context,
      modelCatalog: preparedModelCatalogByAgent,
      request: p,
      respond,
      run,
    });
  },
  "sessions.cleanup": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) {
      return;
    }
    try {
      const { mode, appliedSummaries, failure } = await runSessionsCleanup({
        cfg: context.getRuntimeConfig(),
        opts: {
          agent: params.agent,
          allAgents: params.allAgents,
          enforce: params.enforce,
          activeKey: params.activeKey,
          fixMissing: params.fixMissing,
          fixDmScope: params.fixDmScope,
        },
      });
      const result = serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries,
        failure,
      });
      if (failure) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, failure.message, { details: result }),
        );
      } else {
        respond(true, result, undefined);
      }
      for (const summary of appliedSummaries) {
        emitSessionsChanged(context, { reason: "cleanup", sessionKey: undefined });
        if (summary.wouldMutate) {
          context.logGateway.debug(
            `sessions.cleanup applied ${summary.storePath}: ${summary.beforeCount} -> ${summary.afterCount}`,
          );
        }
      }
      if (failure?.lifecycleCommitted) {
        emitSessionsChanged(context, { reason: "cleanup", sessionKey: undefined });
      }
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
  "sessions.preview": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const keys = (Array.isArray(params.keys) ? params.keys : [])
      .map((key) => normalizeOptionalString(key ?? ""))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit = params.limit ?? 12;
    const maxChars = params.maxChars ?? 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const roleVisibilityFilter = hasOperatorBoundary(client, cfg)
      ? createSessionListEntryFilter({ client, cfg })
      : undefined;
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      if (previews.length > 0) {
        await yieldToEventLoop();
      }
      const requestedAgent = resolveRequestedGlobalAgentId(cfg, key);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      try {
        // Each preview resumes after a yield; read its canonical row from the current store.
        const target = resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key,
          agentId: requestedAgent.agentId,
          exactRead: true,
          readOnly: true,
        });
        const entry = resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
        if (!entry?.sessionId || roleVisibilityFilter?.(target.canonicalKey, entry) === false) {
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
        previews.push({ key, status: items.length > 0 ? "ok" : "empty", items });
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
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(cfg, key);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { target, storePath, store, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
    });
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
      agentId: target.agentId,
      includeDerivedTitles: params.includeDerivedTitles,
      includeLastMessage: params.includeLastMessage,
      transcriptUsageMaxBytes: 64 * 1024,
    });
    Object.assign(row, readSessionPlacementFields(context, row.sessionId));
    respond(true, { session: row });
  },
  "sessions.resolve": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const resolved = await resolveSessionKeyFromResolveParams({
      cfg: context.getRuntimeConfig(),
      client,
      p: params,
    });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    if ("missing" in resolved) {
      respond(true, { ok: false }, undefined);
      return;
    }
    if ("ambiguous" in resolved) {
      respond(true, { ok: false, candidates: resolved.candidates }, undefined);
      return;
    }
    respond(true, resolved, undefined);
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

export const sessionsListHandler = sessionReadHandlers["sessions.list"]!;
