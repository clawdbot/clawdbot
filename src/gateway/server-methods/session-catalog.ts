import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalog,
  type SessionsCatalogArchiveParams,
  type SessionsCatalogContinueParams,
  type SessionsCatalogListParams,
  type SessionsCatalogReadParams,
  validateSessionsCatalogArchiveParams,
  validateSessionsCatalogContinueParams,
  validateSessionsCatalogListParams,
  validateSessionsCatalogReadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getActivePluginSessionExtensionRegistry } from "../../plugins/runtime.js";
import { gatewaySubagentState } from "../../plugins/runtime/gateway-bindings.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { bindPluginSessionConversation } from "../../plugins/session-conversation-binding.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { recordSessionStateEvent } from "../../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import type { GatewayBroadcastToConnIdsFn } from "../server-broadcast-types.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS = 500;
const SESSION_CATALOG_SHARE_WINDOW_MS = 3_000;
const SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES = 128;

function createSessionCatalogRequestNodeSnapshot(): NonNullable<
  SessionCatalogListProviderParams["listNodes"]
> {
  let request: ReturnType<NonNullable<SessionCatalogListProviderParams["listNodes"]>> | undefined;
  return () => {
    // Every provider sees the same promise so one catalog request cannot multiply the
    // pairing-store scans performed by the Gateway node.list runtime.
    request ??=
      gatewaySubagentState.nodes?.list() ??
      Promise.reject(new Error("Plugin node runtime is only available inside the Gateway."));
    return request;
  };
}

function normalizeSessionCatalogSearch(search: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(search);
  return normalized
    ? truncateUtf16Safe(normalized, SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS)
    : undefined;
}

function catalogError(error: unknown): { code: string; message: string } {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const recordMessage = typeof record?.message === "string" ? record.message.trim() : "";
  const fallbackMessage = typeof error === "string" ? error.trim() : "";
  return {
    code: typeof record?.code === "string" && record.code ? record.code : "catalog_error",
    message: recordMessage || fallbackMessage || "session catalog provider failed",
  };
}

type CatalogRegistrationSnapshot = {
  registry: PluginRegistry | null;
  source: PluginRegistry["sessionCatalogs"] | undefined;
  registrations: PluginRegistry["sessionCatalogs"];
  providers: SessionCatalogProvider[];
};

let cachedCatalogRegistrations: CatalogRegistrationSnapshot | undefined;

function catalogRegistrationSnapshot(): CatalogRegistrationSnapshot {
  const registry = getActivePluginSessionExtensionRegistry();
  const source = registry?.sessionCatalogs;
  if (
    cachedCatalogRegistrations?.registry === registry &&
    cachedCatalogRegistrations.source === source
  ) {
    return cachedCatalogRegistrations;
  }
  const sortedRegistrations = (source ?? []).toSorted((left, right) =>
    left.provider.id.localeCompare(right.provider.id),
  );
  // Plugin registration arrays are process-stable until the active registry seam changes. Hoisting
  // this sort avoids rebuilding identical order every poll; registry/list identity invalidates it.
  // A stale snapshot would route requests to retired plugin instances, so callers share this owner.
  cachedCatalogRegistrations = {
    registry,
    source,
    registrations: sortedRegistrations,
    providers: sortedRegistrations.map((entry) => entry.provider),
  };
  return cachedCatalogRegistrations;
}

function providers(): SessionCatalogProvider[] {
  return catalogRegistrationSnapshot().providers;
}

export function resolveSessionCatalogProvider(
  catalogId: string,
): SessionCatalogProvider | undefined {
  return providers().find((candidate) => candidate.id === catalogId);
}

function registrations() {
  return catalogRegistrationSnapshot().registrations;
}

type SessionCatalogCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget & { pluginOwnerId: string } }
  | { ok: false; message: string; unknownCatalog?: true };

type ProviderCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget }
  | { ok: false; message: string };

const providerCreateTargetsByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<SessionCatalogProvider, Map<string, ProviderCreateTargetResolution>>
>();

type CatalogListResult = { catalogs: SessionCatalog[] };

type CatalogListProgressSubscriber = {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  connId: string;
  progressId: string;
};

type CatalogListCacheEntry = {
  expiresAt?: number;
  progressSubscribers: Map<string, CatalogListProgressSubscriber>;
  result: Promise<CatalogListResult>;
};

type CatalogListCacheState = {
  registrations: CatalogRegistrationSnapshot;
  entries: Map<string, CatalogListCacheEntry>;
};

const catalogListsByConfig = new WeakMap<OpenClawConfig, CatalogListCacheState>();

function providerCreateTargetCache(
  config: OpenClawConfig,
  provider: SessionCatalogProvider,
): Map<string, ProviderCreateTargetResolution> {
  let byProvider = providerCreateTargetsByConfig.get(config);
  if (!byProvider) {
    byProvider = new WeakMap();
    providerCreateTargetsByConfig.set(config, byProvider);
  }
  let byAgent = byProvider.get(provider);
  if (!byAgent) {
    byAgent = new Map();
    byProvider.set(provider, byAgent);
  }
  return byAgent;
}

function resolveProviderCreateTarget(
  provider: SessionCatalogProvider,
  agentId: string,
  config: OpenClawConfig,
): ProviderCreateTargetResolution {
  const cache = providerCreateTargetCache(config, provider);
  const cached = cache.get(agentId);
  if (cached) {
    // The provider contract makes create targets config-derived. A reload changes config identity;
    // retaining the old target would advertise a model no longer allowed.
    return cached;
  }
  let resolution: ProviderCreateTargetResolution;
  try {
    const target = provider.resolveCreateSession?.({ agentId });
    const model = target?.model.trim();
    const agentRuntime = target?.agentRuntime.trim();
    resolution =
      model && agentRuntime
        ? { ok: true, target: { model, agentRuntime } }
        : { ok: false, message: `session catalog ${provider.id} cannot create sessions` };
  } catch (error) {
    // Resolver exceptions are not config state. Retry them on the next request so a transient
    // provider initialization failure cannot suppress session creation until config reload.
    return { ok: false, message: catalogError(error).message };
  }
  cache.set(agentId, resolution);
  return resolution;
}

/** Resolves a catalog-owned create target at the start of sessions.create. */
export function resolveSessionCatalogCreateTarget(
  catalogId: string,
  agentId: string,
  config: OpenClawConfig,
): SessionCatalogCreateTargetResolution {
  const registration = registrations().find((entry) => entry.provider.id === catalogId);
  if (!registration) {
    return {
      ok: false,
      message: `unknown session catalog: ${catalogId}`,
      unknownCatalog: true,
    };
  }
  const resolved = resolveProviderCreateTarget(registration.provider, agentId, config);
  return resolved.ok
    ? { ok: true, target: { ...resolved.target, pluginOwnerId: registration.pluginId } }
    : resolved;
}

function sessionCatalogListKey(params: {
  agentId: string;
  request: SessionsCatalogListParams;
  search?: string;
}): string {
  const cursors = params.request.cursors
    ? Object.entries(params.request.cursors).toSorted(([left], [right]) =>
        left.localeCompare(right),
      )
    : null;
  return JSON.stringify([
    params.agentId,
    params.request.catalogId ?? null,
    params.search ?? null,
    params.request.limitPerHost ?? null,
    params.request.hostIds ?? null,
    cursors,
  ]);
}

function catalogListCache(
  config: OpenClawConfig,
  registrationSnapshot: CatalogRegistrationSnapshot,
): Map<string, CatalogListCacheEntry> {
  let state = catalogListsByConfig.get(config);
  if (!state || state.registrations !== registrationSnapshot) {
    state = { registrations: registrationSnapshot, entries: new Map() };
    catalogListsByConfig.set(config, state);
  }
  return state.entries;
}

function providerOrRespond(
  catalogId: string,
  respond: RespondFn,
): SessionCatalogProvider | undefined {
  const provider = resolveSessionCatalogProvider(catalogId);
  if (!provider) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${catalogId}`),
    );
  }
  return provider;
}

function registrationOrRespond(catalogId: string, respond: RespondFn) {
  const registration = registrations().find((candidate) => candidate.provider.id === catalogId);
  if (!registration) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${catalogId}`),
    );
  }
  return registration;
}

function catalogResult(
  provider: SessionCatalogProvider,
  hosts: SessionCatalog["hosts"],
  error?: SessionCatalog["error"],
  createSession?: NonNullable<SessionCatalog["capabilities"]["createSession"]>,
): SessionCatalog {
  const result: SessionCatalog = {
    id: provider.id,
    label: provider.label,
    capabilities: {
      continueSession: Boolean(provider.continueSession),
      archive: Boolean(provider.archive),
      ...(provider.openTerminal ? { openTerminal: true } : {}),
      ...(createSession ? { createSession } : {}),
    },
    hosts,
  };
  if (error) {
    result.error = error;
  }
  return result;
}

export const sessionCatalogHandlers: GatewayRequestHandlers = {
  "sessions.catalog.list": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogListParams,
        "sessions.catalog.list",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogListParams;
    if (request.cursors !== undefined && request.catalogId === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "catalogId is required when cursors are provided"),
      );
      return;
    }
    const catalogRegistrations = catalogRegistrationSnapshot();
    let selected: SessionCatalogProvider[];
    if (request.catalogId) {
      const provider = catalogRegistrations.providers.find(
        (candidate) => candidate.id === request.catalogId,
      );
      if (!provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${request.catalogId}`),
        );
        return;
      }
      selected = [provider];
    } else {
      selected = catalogRegistrations.providers;
    }
    const config = context.getRuntimeConfig();
    const resolvedAgent = resolveAgentIdOrRespondError({
      rawAgentId: request.agentId,
      respond,
      cfg: config,
      normalize: normalizeOptionalString,
    });
    if (!resolvedAgent) {
      return;
    }
    const search = normalizeSessionCatalogSearch(request.search);
    const progressId = request.progressId;
    const progressConnId = progressId && client?.connId ? client.connId : undefined;
    const listKey = sessionCatalogListKey({
      agentId: resolvedAgent.agentId,
      request,
      search,
    });
    const cache = catalogListCache(config, catalogRegistrations);
    const cached = cache.get(listKey);
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
      // progressId is connection-owned and excluded from the work key. Active followers register
      // for the remaining host frames; settled followers receive only the authoritative result.
      if (cached.expiresAt === undefined && progressConnId && progressId) {
        cached.progressSubscribers.set(`${progressConnId}\0${progressId}`, {
          broadcastToConnIds: context.broadcastToConnIds,
          connId: progressConnId,
          progressId,
        });
      }
      cache.delete(listKey);
      cache.set(listKey, cached);
      respond(true, await cached.result);
      return;
    }
    if (cached) {
      cache.delete(listKey);
    }
    const progressSubscribers = new Map<string, CatalogListProgressSubscriber>();
    if (progressConnId && progressId) {
      progressSubscribers.set(`${progressConnId}\0${progressId}`, {
        broadcastToConnIds: context.broadcastToConnIds,
        connId: progressConnId,
        progressId,
      });
    }
    const operation = (async () => {
      const requestEntries = createSessionCatalogRequestEntrySnapshot({
        cfg: config,
        fallbackAgentId: resolvedAgent.agentId,
      });
      const listNodes = createSessionCatalogRequestNodeSnapshot();
      const catalogList = await Promise.all(
        selected.map(async (provider): Promise<SessionCatalog> => {
          const createTarget = resolveProviderCreateTarget(provider, resolvedAgent.agentId, config);
          const createSession = createTarget.ok ? { model: createTarget.target.model } : undefined;
          const onHost = (host: SessionCatalog["hosts"][number]) => {
            const catalog = catalogResult(
              provider,
              [requestEntries.projectHostCreatedActors(host)],
              undefined,
              createSession,
            );
            // Progressive frames are an optimization. The final RPC response remains
            // authoritative when a slow client drops an intermediate host update.
            for (const subscriber of progressSubscribers.values()) {
              subscriber.broadcastToConnIds(
                "sessions.catalog.host",
                {
                  progressId: subscriber.progressId,
                  agentId: resolvedAgent.agentId,
                  catalog,
                },
                new Set([subscriber.connId]),
                { dropIfSlow: true },
              );
            }
          };
          try {
            const hosts = await provider.list({
              search,
              limitPerHost: request.limitPerHost,
              hostIds: request.hostIds,
              ...(request.cursors !== undefined ? { cursors: request.cursors } : {}),
              sessionEntries: requestEntries.sessionEntries,
              listNodes,
              onHost,
            });
            return catalogResult(
              provider,
              hosts.map(requestEntries.projectHostCreatedActors),
              undefined,
              createSession,
            );
          } catch (error) {
            return catalogResult(provider, [], catalogError(error), createSession);
          }
        }),
      );
      return { catalogs: catalogList };
    })();
    const entry: CatalogListCacheEntry = { progressSubscribers, result: operation };
    // Exact request/config/registration results remain shareable for 3s after settling. This catches
    // out-of-phase clients but expires before the UI's 5s fast follow, so changed rows surface there.
    // Expired and rejected work is removed; retaining it would mask provider recovery or new sessions.
    cache.set(listKey, entry);
    while (cache.size > SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) {
        break;
      }
      cache.delete(oldest.value);
    }
    try {
      const result = await operation;
      if (cache.get(listKey) === entry) {
        entry.expiresAt = Date.now() + SESSION_CATALOG_SHARE_WINDOW_MS;
      }
      respond(true, result);
    } catch (error) {
      if (cache.get(listKey) === entry) {
        cache.delete(listKey);
      }
      throw error;
    } finally {
      progressSubscribers.clear();
    }
  },

  "sessions.catalog.read": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogReadParams,
        "sessions.catalog.read",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogReadParams;
    const provider = providerOrRespond(request.catalogId, respond);
    if (!provider) {
      return;
    }
    try {
      const { catalogId: _catalogId, ...providerRequest } = request;
      respond(true, await provider.read(providerRequest));
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },

  "sessions.catalog.continue": async ({ params, respond, client }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogContinueParams,
        "sessions.catalog.continue",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogContinueParams;
    const registration = registrationOrRespond(request.catalogId, respond);
    if (!registration) {
      return;
    }
    const provider = registration.provider;
    if (!provider.continueSession) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog is view-only"));
      return;
    }
    try {
      const { catalogId: _catalogId, ...providerRequest } = request;
      // Fail closed for unscoped callers: providers gate high-authority
      // continues (e.g. node-executing bindings) on these scopes.
      const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      const result = await provider.continueSession({ ...providerRequest, clientScopes });
      if (result.conversationBinding) {
        // operator.write on Continue is the approval boundary. Per-turn plugin and
        // node command authorization still applies after this binding is installed.
        await bindPluginSessionConversation({
          pluginId: registration.pluginId,
          pluginName: registration.pluginName,
          pluginRoot: registration.rootDir?.trim() || registration.source,
          sessionKey: result.sessionKey,
          binding: result.conversationBinding,
          afterBind: result.afterConversationBound,
        });
      }
      // Adopted sessions are created under the resolved default store agent, so the
      // key-derived agent matches the owning agent. Provider-authoritative agent
      // identity (a `SessionCatalogContinueProviderResult.agentId`) is a follow-up
      // that would let adapters adopt under non-default agents; see issue tracker.
      const agentId = resolveAgentIdFromSessionKey(result.sessionKey);
      if (result.upstream) {
        // Links exist only for adoptions made on this version: pre-upgrade adopted
        // sessions are transient linkage with no shipped contract, and re-continuing
        // from the catalog establishes the link. No doctor backfill by design.
        upsertSessionUpstreamLink({
          sessionKey: result.sessionKey,
          agentId,
          catalogId: request.catalogId,
          hostId: request.hostId,
          threadId: request.threadId,
          upstreamKind: result.upstream.kind,
          upstreamRef: result.upstream.ref,
          marker: result.upstream.marker,
        });
      }
      recordSessionStateEvent({
        sessionKey: result.sessionKey,
        agentId,
        kind: "adopted",
        actorType: "human",
        dedupeKey: `adopted:${result.sessionKey}`,
        summary: `adopted from ${request.catalogId}`,
        payload: { catalogId: request.catalogId, hostId: request.hostId },
      });
      respond(true, { sessionKey: result.sessionKey });
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },

  "sessions.catalog.archive": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogArchiveParams,
        "sessions.catalog.archive",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogArchiveParams;
    const provider = providerOrRespond(request.catalogId, respond);
    if (!provider) {
      return;
    }
    if (!provider.archive) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog cannot archive"));
      return;
    }
    try {
      const { catalogId: _catalogId, ...providerRequest } = request;
      respond(true, await provider.archive(providerRequest));
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },
};

/** Fill the same list single-flight and provider caches used by the Gateway RPC. */
export async function prewarmSessionCatalogList(params: {
  config: OpenClawConfig;
  agentId: string;
  limitPerHost: number;
}): Promise<void> {
  const handler = sessionCatalogHandlers["sessions.catalog.list"];
  if (!handler) {
    throw new Error("sessions.catalog.list handler is unavailable");
  }
  let responded = false;
  let responseError: string | undefined;
  const respond: RespondFn = (ok, _payload, error) => {
    responded = true;
    if (!ok) {
      responseError = error?.message || "sessions.catalog.list prewarm failed";
    }
  };
  await handler({
    params: {
      agentId: params.agentId,
      limitPerHost: params.limitPerHost,
    },
    client: null,
    // A headless leader intentionally has no progress id or connection subscription.
    // Concurrent clients still share its authoritative final result through the normal cache.
    context: { getRuntimeConfig: () => params.config },
    respond,
  } as never);
  if (!responded) {
    throw new Error("sessions.catalog.list prewarm returned no result");
  }
  if (responseError) {
    throw new Error(responseError);
  }
}
