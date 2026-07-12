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
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

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
  return (getPluginRegistryState()?.activeRegistry?.sessionCatalogs ?? [])
    .map((entry) => entry.provider)
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function providerOrRespond(
  catalogId: string,
  respond: RespondFn,
): SessionCatalogProvider | undefined {
  const provider = providers().find((candidate) => candidate.id === catalogId);
  if (!provider) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${catalogId}`),
    );
  }
  return provider;
}

function catalogResult(
  provider: SessionCatalogProvider,
  hosts: SessionCatalog["hosts"],
  error?: SessionCatalog["error"],
): SessionCatalog {
  const result: SessionCatalog = {
    id: provider.id,
    label: provider.label,
    capabilities: {
      continueSession: Boolean(provider.continueSession),
      archive: Boolean(provider.archive),
    },
    hosts,
  };
  if (error) {
    result.error = error;
  }
  return result;
}

export const sessionCatalogHandlers: GatewayRequestHandlers = {
  "sessions.catalog.list": async ({ params, respond }) => {
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
    const catalogList = await Promise.all(
      selected.map(async (provider): Promise<SessionCatalog> => {
        try {
          const hosts = await provider.list({
            search: request.search,
            limitPerHost: request.limitPerHost,
            hostIds: request.hostIds,
            ...("cursors" in request ? { cursors: request.cursors } : {}),
          });
          return catalogResult(provider, hosts);
        } catch (error) {
          return catalogResult(provider, [], catalogError(error));
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

  "sessions.catalog.continue": async ({ params, respond }) => {
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
    const provider = providerOrRespond(request.catalogId, respond);
    if (!provider) {
      return;
    }
    if (!provider.continueSession) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog is view-only"));
      return;
    }
    try {
      const { catalogId: _catalogId, ...providerRequest } = request;
      respond(true, await provider.continueSession(providerRequest));
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
