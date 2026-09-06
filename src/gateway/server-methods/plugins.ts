// Gateway handlers for plugin inventory, metadata refresh and catalog search.
import {
  ErrorCodes,
  errorShape,
  validatePluginsInspectParams,
  validatePluginsCatalogBrowseParams,
  validatePluginsCatalogCategoriesParams,
  validatePluginsCatalogGetParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  fetchClawHubPluginCatalog,
  fetchClawHubPluginCategories,
  fetchClawHubPluginDetail,
} from "../../infra/clawhub-plugin-catalog.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  decodePluginDiscoveryId,
  joinClawHubPluginCatalog,
} from "../../plugins/catalog-discovery.js";
import { searchInstallablePluginPackages } from "../../plugins/catalog-search.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import {
  inspectManagedPlugin,
  listManagedPlugins,
  refreshManagedPluginMetadata,
} from "../../plugins/management-service.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const pluginsHandlers: GatewayRequestHandlers = {
  "plugins.refresh": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsRefreshParams, "plugins.refresh", respond)) {
      return;
    }
    try {
      refreshManagedPluginMetadata({ config: context.getRuntimeConfig() });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Plugin inventory refresh failed: ${formatErrorMessage(error)}. Restart the Gateway to load updated plugins.`,
          { details: { restartRequired: true } },
        ),
      );
      return;
    } finally {
      context.notifyPluginMetadataChanged();
    }
    respond(true, { ok: true, restartRequired: true }, undefined);
  },
  "plugins.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    try {
      respond(true, await listManagedPlugins({ config: context.getRuntimeConfig() }), undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "plugins.inspect": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsInspectParams, "plugins.inspect", respond)) {
      return;
    }
    try {
      respond(
        true,
        await inspectManagedPlugin({
          config: context.getRuntimeConfig(),
          pluginId: params.pluginId,
        }),
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
        ),
      );
    }
  },
  "plugins.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsSearchParams, "plugins.search", respond)) {
      return;
    }
    try {
      const results = await searchInstallablePluginPackages({
        query: params.query,
        limit: params.limit,
      });
      respond(
        true,
        {
          results: results.flatMap((entry) => {
            if (
              entry.package.family !== "code-plugin" &&
              entry.package.family !== "bundle-plugin"
            ) {
              return [];
            }
            const downloads = entry.package.stats?.downloads;
            return [
              {
                score: entry.score,
                package: {
                  name: entry.package.name,
                  displayName: entry.package.displayName,
                  family: entry.package.family,
                  channel: entry.package.channel,
                  isOfficial: entry.package.isOfficial,
                  ...(entry.package.summary ? { summary: entry.package.summary } : {}),
                  ...(entry.package.latestVersion
                    ? { latestVersion: entry.package.latestVersion }
                    : {}),
                  ...(entry.package.runtimeId ? { runtimeId: entry.package.runtimeId } : {}),
                  ...(typeof downloads === "number" && Number.isFinite(downloads) && downloads >= 0
                    ? { downloads }
                    : {}),
                  ...(entry.package.verificationTier
                    ? { verificationTier: entry.package.verificationTier }
                    : {}),
                },
              },
            ];
          }),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "plugins.catalog.browse": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsCatalogBrowseParams,
        "plugins.catalog.browse",
        respond,
      )
    ) {
      return;
    }
    if (params.query?.trim() && params.cursor) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Plugin search does not accept a browse cursor."),
      );
      return;
    }
    try {
      const [remote, local] = await Promise.all([
        fetchClawHubPluginCatalog({
          query: params.query,
          intent: params.intent,
          category: params.category,
          cursor: params.cursor,
          limit: params.pageSize ?? 20,
        }),
        listManagedPlugins({ config: context.getRuntimeConfig() }),
      ]);
      respond(
        true,
        {
          items: joinClawHubPluginCatalog({ remote: remote.items, local }),
          ...(remote.nextCursor ? { nextCursor: remote.nextCursor } : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Plugin discovery is unavailable: ${formatErrorMessage(error)}. Retry to reconnect to ClawHub.`,
        ),
      );
    }
  },
  "plugins.catalog.categories": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsCatalogCategoriesParams,
        "plugins.catalog.categories",
        respond,
      )
    ) {
      return;
    }
    try {
      respond(true, { categories: await fetchClawHubPluginCategories() }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Plugin categories are unavailable: ${formatErrorMessage(error)}. Retry to reconnect to ClawHub.`,
        ),
      );
    }
  },
  "plugins.catalog.get": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validatePluginsCatalogGetParams, "plugins.catalog.get", respond)
    ) {
      return;
    }
    const packageName = decodePluginDiscoveryId(params.id);
    if (!packageName) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Unknown plugin discovery identity."),
      );
      return;
    }
    try {
      const [remote, local] = await Promise.all([
        fetchClawHubPluginDetail({ packageName }),
        listManagedPlugins({ config: context.getRuntimeConfig() }),
      ]);
      const [plugin] = joinClawHubPluginCatalog({ remote: [remote], local });
      if (!plugin) {
        throw new Error("ClawHub returned no plugin detail.");
      }
      respond(true, { plugin }, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Plugin details are unavailable: ${formatErrorMessage(error)}. Retry to reconnect to ClawHub.`,
        ),
      );
    }
  },
};
