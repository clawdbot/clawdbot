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
import { getActivePluginSessionExtensionRegistry } from "../../plugins/runtime.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { bindPluginSessionConversation } from "../../plugins/session-conversation-binding.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { recordSessionStateEvent } from "../../sessions/session-state-events.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS = 500;

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

function providers(): SessionCatalogProvider[] {
  return registrations().map((entry) => entry.provider);
}

export function resolveSessionCatalogProvider(
  catalogId: string,
): SessionCatalogProvider | undefined {
  return providers().find((candidate) => candidate.id === catalogId);
}

function registrations() {
  return (getActivePluginSessionExtensionRegistry()?.sessionCatalogs ?? []).toSorted(
    (left, right) => left.provider.id.localeCompare(right.provider.id),
  );
}

type SessionCatalogCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget & { pluginOwnerId: string } }
  | { ok: false; message: string; unknownCatalog?: true };

type ProviderCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget }
  | { ok: false; message: string };

function resolveProviderCreateTarget(
  provider: SessionCatalogProvider,
  agentId?: string,
): ProviderCreateTargetResolution {
  try {
    const target = provider.resolveCreateSession?.({ agentId });
    const model = target?.model.trim();
    const agentRuntime = target?.agentRuntime.trim();
    return model && agentRuntime
      ? { ok: true, target: { model, agentRuntime } }
      : { ok: false, message: `session catalog ${provider.id} cannot create sessions` };
  } catch (error) {
    return { ok: false, message: catalogError(error).message };
  }
}

/** Resolves a catalog-owned create target at the start of sessions.create. */
export function resolveSessionCatalogCreateTarget(
  catalogId: string,
  agentId: string,
): SessionCatalogCreateTargetResolution {
  const registration = registrations().find((entry) => entry.provider.id === catalogId);
  if (!registration) {
    return {
      ok: false,
      message: `unknown session catalog: ${catalogId}`,
      unknownCatalog: true,
    };
  }
  const resolved = resolveProviderCreateTarget(registration.provider, agentId);
  return resolved.ok
    ? { ok: true, target: { ...resolved.target, pluginOwnerId: registration.pluginId } }
    : resolved;
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
    let selected: SessionCatalogProvider[];
    if (request.catalogId) {
      const provider = providerOrRespond(request.catalogId, respond);
      if (!provider) {
        return;
      }
      selected = [provider];
    } else {
      selected = providers();
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
    const catalogList = await Promise.all(
      selected.map(async (provider): Promise<SessionCatalog> => {
        const createTarget = resolveProviderCreateTarget(provider, resolvedAgent.agentId);
        const createSession = createTarget.ok ? { model: createTarget.target.model } : undefined;
        const onHost = progressConnId
          ? (host: SessionCatalog["hosts"][number]) => {
              // Progressive frames are an optimization. The final RPC response remains
              // authoritative when a slow client drops an intermediate host update.
              context.broadcastToConnIds(
                "sessions.catalog.host",
                {
                  progressId,
                  agentId: resolvedAgent.agentId,
                  catalog: catalogResult(provider, [host], undefined, createSession),
                },
                new Set([progressConnId]),
                { dropIfSlow: true },
              );
            }
          : undefined;
        try {
          const hosts = await provider.list({
            search,
            limitPerHost: request.limitPerHost,
            hostIds: request.hostIds,
            ...(request.cursors !== undefined ? { cursors: request.cursors } : {}),
            ...(onHost ? { onHost } : {}),
          });
          return catalogResult(provider, hosts, undefined, createSession);
        } catch (error) {
          return catalogResult(provider, [], catalogError(error), createSession);
        }
      }),
    );
    respond(true, { catalogs: catalogList });
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
