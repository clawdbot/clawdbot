import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalog,
  type SessionCatalogLocator,
  type SessionCatalogShareRoute,
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
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { projectSessionParticipant } from "../session-identity-projection.js";
import type { SessionActorProfileIdentity } from "../session-utils-contracts.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { authorizeSessionCatalogThread } from "./session-catalog-authorization.js";
import { continueAuthorizedSessionCatalog } from "./session-catalog-continue.js";
import {
  createSessionCatalogRequestEntrySnapshot,
  type SessionCatalogInstances,
} from "./session-catalog-entry-snapshot.js";
import {
  SessionCatalogListLifetime,
  type CatalogListProgressSubscriber,
} from "./session-catalog-list-lifetime.js";
import {
  allowProcessHomeFallback,
  createSessionCatalogRequestNodeSnapshot,
  listSessionCatalogProvider,
  catalogRegistrationSnapshot,
  type CatalogRegistrationSnapshot,
} from "./session-catalog-provider-access.js";
import { catalogStartHandler } from "./session-catalog-terminal-start.js";
import {
  filterSessionCatalogHost,
  resolveSessionCatalogVisibility,
} from "./session-catalog-visibility.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS = 500;
const SESSION_CATALOG_SHARE_WINDOW_MS = 3_000;
const SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES = 128;

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

export function resolveSessionCatalogProvider(
  catalogId: string,
): SessionCatalogProvider | undefined {
  return catalogRegistrationSnapshot().providers.find((candidate) => candidate.id === catalogId);
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
type CatalogListEnumeration = CatalogListResult & { instances: SessionCatalogInstances };

type CatalogListCacheEntry = {
  expiresAt?: number;
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListCacheState = {
  registrations: CatalogRegistrationSnapshot;
  entries: Map<string, CatalogListCacheEntry>;
};

const catalogListsByConfig = new WeakMap<OpenClawConfig, CatalogListCacheState>();
const catalogCallerIds = new WeakMap<GatewayClient, number>();
let nextCatalogCallerId = 0;

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
export function resolveRegisteredCatalogCreateTarget(
  catalogId: string,
  agentId: string,
  config: OpenClawConfig,
): SessionCatalogCreateTargetResolution {
  const registration = catalogRegistrationSnapshot().registrations.find(
    (entry) => entry.provider.id === catalogId,
  );
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
  client: GatewayClient | null;
  request: SessionsCatalogListParams;
  search?: string;
  allowProcessHomeFallback: boolean;
  visibilityKey: string;
}): string {
  // Providers inherit this exact caller through Gateway async scope, including node APIs.
  // A matching profile alone cannot make another connection's enumeration reusable.
  let callerId = params.client ? catalogCallerIds.get(params.client) : 0;
  if (params.client && callerId === undefined) {
    callerId = ++nextCatalogCallerId;
    catalogCallerIds.set(params.client, callerId);
  }
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
    params.allowProcessHomeFallback,
    params.visibilityKey,
    callerId,
    params.client?.connect?.scopes?.toSorted() ?? [],
    params.client?.connect?.role ?? null,
    params.client?.connect?.device?.id ?? null,
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

async function authorizeCatalogRequest(params: {
  access: "read" | "mutate";
  request: SessionCatalogLocator & { agentId?: string };
  provider: SessionCatalogProvider;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<{ agentId: string; allowProcessHomeFallback: boolean } | null> {
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: params.request.agentId,
    respond: params.respond,
    cfg: params.context.getRuntimeConfig(),
    normalize: normalizeOptionalString,
  });
  if (!resolvedAgent) {
    return null;
  }
  const authorization = await authorizeSessionCatalogThread({
    access: params.access,
    agentId: resolvedAgent.agentId,
    client: params.client,
    context: params.context,
    provider: params.provider,
    request: params.request,
    respond: params.respond,
  });
  return authorization ? { agentId: resolvedAgent.agentId, ...authorization } : null;
}

function registrationOrRespond(catalogId: string, respond: RespondFn) {
  const registration = catalogRegistrationSnapshot().registrations.find(
    (candidate) => candidate.provider.id === catalogId,
  );
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
  shareRoute: SessionCatalogShareRoute | undefined,
  hosts: SessionCatalog["hosts"],
  error?: SessionCatalog["error"],
  createSession?: NonNullable<SessionCatalog["capabilities"]["createSession"]>,
): SessionCatalog {
  const result: SessionCatalog = {
    id: provider.id,
    label: provider.label,
    capabilities: {
      continueSession: Boolean(provider.continueSession || provider.copyToGatewaySession),
      archive: Boolean(provider.archive),
      ...(provider.openTerminal ? { openTerminal: true } : {}),
      ...(createSession ? { createSession } : {}),
      ...(provider.startTerminalSession ? { startTerminal: true } : {}),
    },
    ...(shareRoute ? { shareRoute } : {}),
    hosts,
  };
  if (error) {
    result.error = error;
  }
  return result;
}

export const sessionCatalogHandlers: GatewayRequestHandlers = {
  "sessions.catalog.list": async ({ params, respond, context, client, signal }) => {
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
    const allowHomeFallback = allowProcessHomeFallback(context.logGateway);
    // Cached provider enumeration is not permission. Each synchronous delivery gets current
    // caller facts and one canonical index, never the provider's pre-await planning snapshot.
    const projectResult = (result: CatalogListEnumeration): CatalogListResult => {
      const currentConfig = context.getRuntimeConfig();
      const visibility = resolveSessionCatalogVisibility(client, currentConfig);
      const requestEntries = createSessionCatalogRequestEntrySnapshot({
        cfg: currentConfig,
        fallbackAgentId: resolvedAgent.agentId,
      });
      return {
        catalogs: result.catalogs.map((catalog) => ({
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            filterSessionCatalogHost(
              requestEntries.projectHostSessions(host, result.instances),
              visibility,
              {
                audience: catalogRegistrations.providers.find(
                  (provider) => provider.id === catalog.id,
                )?.audience,
                requestEntries,
              },
            ),
          ),
        })),
      };
    };
    const progressId = request.progressId;
    const progressConnId = progressId && client?.connId ? client.connId : undefined;
    const subscriber: CatalogListProgressSubscriber | undefined =
      progressConnId && progressId
        ? (catalog, instances) =>
            context.broadcastToConnIds(
              "sessions.catalog.host",
              {
                progressId,
                agentId: resolvedAgent.agentId,
                catalog: projectResult({ catalogs: [catalog], instances }).catalogs[0],
              },
              new Set([progressConnId]),
              { dropIfSlow: true },
            )
        : undefined;
    const subscribe = (progress: SessionCatalogListLifetime) => {
      if (subscriber && progressConnId) {
        progress.subscribe(
          `${progressConnId}\0${progressId}`,
          subscriber,
          () =>
            client?.invalidated !== true &&
            context.isConnectionActive?.(progressConnId) !== false &&
            (!client?.internal?.agentRuntimeIdentity ||
              context.validateAgentRuntimeApprovalAuthority?.(
                client.internal.agentRuntimeIdentity,
              ) === true),
          client?.connectionSignal ?? signal,
        );
      }
    };
    const listKey = sessionCatalogListKey({
      agentId: resolvedAgent.agentId,
      client,
      request,
      search,
      allowProcessHomeFallback: allowHomeFallback,
      visibilityKey: resolveSessionCatalogVisibility(client, config).cacheKey,
    });
    const cache = catalogListCache(config, catalogRegistrations);
    const cached = cache.get(listKey);
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
      // progressId is connection-owned and excluded from the work key. Active followers register
      // for the remaining host frames; settled followers receive only the authoritative result.
      if (cached.expiresAt === undefined) {
        subscribe(cached.progress);
      }
      cache.delete(listKey);
      cache.set(listKey, cached);
      respond(true, projectResult(await cached.result));
      return;
    }
    if (cached) {
      cache.delete(listKey);
    }
    const registry = catalogRegistrations.registry;
    const scopedRuntime = getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
    const epoch = registry ? capturePluginRegistryLifecycleEpoch(registry) : undefined;
    const registryAuthority = registry
      ? capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime })
      : undefined;
    const registrySignal = registry
      ? capturePluginRegistryLifecycleSignal(registry, epoch, { scopedRuntime })
      : undefined;
    const resolveGatewayContext = context.resolveGatewayContext;
    const progress = new SessionCatalogListLifetime(
      () =>
        (!resolveGatewayContext || resolveGatewayContext() === context) &&
        (!registry ||
          (registryAuthority?.() === true &&
            registry.sessionCatalogs === catalogRegistrations.source)),
      [
        getGatewayRestartDrainSignal(),
        context.requestEntryLifetime?.signal,
        registrySignal,
        signal,
      ].filter((candidate): candidate is AbortSignal => candidate !== undefined),
    );
    subscribe(progress);
    const operation = (async () => {
      const requestEntries = createSessionCatalogRequestEntrySnapshot({
        cfg: config,
        fallbackAgentId: resolvedAgent.agentId,
      });
      requestEntries.freeze();
      const instances: SessionCatalogInstances = new Map();
      const listNodes = createSessionCatalogRequestNodeSnapshot();
      const catalogList = await Promise.all(
        selected.map(async (provider): Promise<SessionCatalog> => {
          const shareRoute = catalogRegistrations.shareRoutes.get(provider);
          const createTarget = resolveProviderCreateTarget(provider, resolvedAgent.agentId, config);
          const createSession = createTarget.ok
            ? {
                model: createTarget.target.model,
                ...(provider.startTerminalSession ? { startTerminal: true as const } : {}),
              }
            : undefined;
          const onHost = (host: SessionCatalog["hosts"][number]) => {
            requestEntries.captureHostInstances(host, instances);
            const catalog = catalogResult(provider, shareRoute, [host], undefined, createSession);
            // Progressive frames are an optimization. The final RPC response remains
            // authoritative when a slow client drops an intermediate host update.
            progress.publish(catalog, instances);
          };
          try {
            const hosts = await progress.runProvider(onHost, (lifetime) =>
              listSessionCatalogProvider(provider, {
                agentId: resolvedAgent.agentId,
                allowProcessHomeFallback: allowHomeFallback,
                search,
                limitPerHost: request.limitPerHost,
                hostIds: request.hostIds,
                ...(request.cursors !== undefined ? { cursors: request.cursors } : {}),
                sessionEntries: requestEntries.sessionEntries,
                listNodes,
                ...lifetime,
              }),
            );
            for (const host of hosts) {
              requestEntries.captureHostInstances(host, instances);
            }
            return catalogResult(provider, shareRoute, hosts, undefined, createSession);
          } catch (error) {
            return catalogResult(provider, shareRoute, [], catalogError(error), createSession);
          }
        }),
      );
      return { catalogs: catalogList, instances };
    })();
    const entry: CatalogListCacheEntry = { progress, result: operation };
    // Raw enumeration stays shareable for 3s within the caller's authority partition. Privacy
    // and creator projection are refreshed per delivery, independently of metadata expiry.
    cache.set(listKey, entry);
    pruneMapToMaxSize(cache, SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES);
    try {
      const result = await operation;
      if (cache.get(listKey) === entry) {
        entry.expiresAt = Date.now() + SESSION_CATALOG_SHARE_WINDOW_MS;
      }
      respond(true, projectResult(result));
    } catch (error) {
      progress.retire(error);
      if (cache.get(listKey) === entry) {
        cache.delete(listKey);
      }
      throw error;
    } finally {
      progress.finishListing();
    }
  },

  "sessions.catalog.read": async ({ params, respond, context, client }) => {
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
      const authorization = await authorizeCatalogRequest({
        access: "read",
        request,
        provider,
        respond,
        context,
        client,
      });
      if (!authorization) {
        return;
      }
      const { catalogId: _catalogId, ...providerRequest } = request;
      const page = await provider.read({
        ...providerRequest,
        agentId: authorization.agentId,
        allowProcessHomeFallback: authorization.allowProcessHomeFallback,
      });
      const profiles = new Map<string, SessionActorProfileIdentity | undefined>();
      respond(true, {
        ...page,
        items: page.items.map((item) =>
          item.sender?.identity.type === "profile"
            ? Object.assign({}, item, {
                sender: projectSessionParticipant(item.sender.identity, profiles),
              })
            : item,
        ),
      });
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },

  "sessions.catalog.continue": async ({
    params,
    respond,
    client,
    context,
    sessionMutationCommitGuard,
  }) => {
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
    if (!provider.continueSession && !provider.copyToGatewaySession) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog is view-only"));
      return;
    }
    try {
      const authorization = await authorizeCatalogRequest({
        access: "mutate",
        request,
        provider,
        respond,
        context,
        client,
      });
      if (!authorization) {
        return;
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg: context.getRuntimeConfig(),
        client,
        agentId: authorization.agentId,
      });
      if (creationError) {
        respond(false, undefined, creationError);
        return;
      }
      const continued = await continueAuthorizedSessionCatalog({
        request,
        registration,
        agentId: authorization.agentId,
        allowProcessHomeFallback: authorization.allowProcessHomeFallback,
        client,
        context,
        commitGuard: sessionMutationCommitGuard,
      });
      if (!continued.ok) {
        respond(false, undefined, continued.error);
        return;
      }
      respond(true, { sessionKey: continued.sessionKey });
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },

  "sessions.catalog.startTerminal": catalogStartHandler(resolveSessionCatalogProvider),

  "sessions.catalog.archive": async ({ params, respond, context, client }) => {
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
      const authorization = await authorizeCatalogRequest({
        access: "mutate",
        request,
        provider,
        respond,
        context,
        client,
      });
      if (!authorization) {
        return;
      }
      const { catalogId: _catalogId, ...providerRequest } = request;
      respond(
        true,
        await provider.archive({
          ...providerRequest,
          agentId: authorization.agentId,
          allowProcessHomeFallback: authorization.allowProcessHomeFallback,
        }),
      );
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
