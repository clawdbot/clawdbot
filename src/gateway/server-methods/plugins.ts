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
  fetchAllOfficialClawHubPlugins,
  fetchClawHubPluginCatalog,
  fetchClawHubPluginCategories,
  fetchClawHubPluginDetail,
} from "../../infra/clawhub-plugin-catalog.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  findLocalPluginByIdentity,
  joinClawHubPluginCatalog,
  joinClawHubPluginDetail,
  joinLocalPluginDetail,
  resolvePluginDiscoveryIdentity,
} from "../../plugins/catalog-discovery.js";
import { registerClawHubCatalogIconUrls } from "../../plugins/catalog-icon-registry.js";
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
      const local = await listManagedPlugins({ config: context.getRuntimeConfig() });
      const query = params.query?.trim();
      const intent = params.intent ?? "all";
      const includeBundledOnly = intent === "bundled" || (intent === "all" && Boolean(query));
      let published: Awaited<ReturnType<typeof fetchAllOfficialClawHubPlugins>> = [];
      let publicationError: string | undefined;
      if (includeBundledOnly) {
        // Bundled distributions are first-party, so any published match belongs to ClawHub's
        // official catalog. Read every page before classifying an unmatched entry as bundled-only.
        try {
          published = await fetchAllOfficialClawHubPlugins();
        } catch (error) {
          publicationError = `ClawHub is unavailable: ${formatErrorMessage(error)}. Bundled publication status could not be verified.`;
        }
      }
      const canIncludeBundledOnly = includeBundledOnly && !publicationError;
      try {
        const remote =
          intent === "bundled"
            ? { items: [] }
            : await fetchClawHubPluginCatalog({
                query,
                intent,
                category: params.category,
                cursor: params.cursor,
                limit: params.pageSize ?? 20,
              });
        const items = joinClawHubPluginCatalog({
          remote: remote.items,
          published,
          local,
          includeBundledOnly: canIncludeBundledOnly,
          intent,
          category: params.category,
          query: params.query,
          cursor: params.cursor,
        });
        registerClawHubCatalogIconUrls(items.map((item) => item.catalog.imageUrl));
        respond(
          true,
          {
            items,
            ...(remote.nextCursor ? { nextCursor: remote.nextCursor } : {}),
            ...(publicationError ? { remoteError: publicationError } : {}),
          },
          undefined,
        );
      } catch (error) {
        respond(
          true,
          {
            items: joinClawHubPluginCatalog({
              remote: [],
              published,
              local,
              includeBundledOnly: canIncludeBundledOnly,
              intent: params.intent,
              category: params.category,
              query: params.query,
              cursor: params.cursor,
            }),
            remoteError: [
              publicationError,
              `ClawHub is unavailable: ${formatErrorMessage(error)}.${canIncludeBundledOnly ? " Bundled plugins remain available." : ""}`,
            ]
              .filter(Boolean)
              .join(" "),
          },
          undefined,
        );
      }
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
    const identity = resolvePluginDiscoveryIdentity(params.id);
    if (!identity) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Unknown plugin discovery identity."),
      );
      return;
    }
    try {
      const local = await listManagedPlugins({ config: context.getRuntimeConfig() });
      const localPlugin = findLocalPluginByIdentity(local, identity.identity);
      if (identity.origin === "local") {
        if (!localPlugin) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "Unknown local plugin discovery identity."),
          );
          return;
        }
        const inspection = localPlugin.installed
          ? await inspectManagedPlugin({
              config: context.getRuntimeConfig(),
              pluginId: localPlugin.id,
            })
          : undefined;
        respond(true, joinLocalPluginDetail({ plugin: localPlugin, local, inspection }), undefined);
        return;
      }
      try {
        const remote = await fetchClawHubPluginDetail({ packageName: identity.identity });
        registerClawHubCatalogIconUrls([remote.iconUrl, remote.owner?.imageUrl]);
        respond(true, joinClawHubPluginDetail({ remote, local }), undefined);
      } catch (error) {
        if (!localPlugin) {
          throw error;
        }
        const inspection = localPlugin.installed
          ? await inspectManagedPlugin({
              config: context.getRuntimeConfig(),
              pluginId: localPlugin.id,
            })
          : undefined;
        respond(true, joinLocalPluginDetail({ plugin: localPlugin, local, inspection }), undefined);
      }
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
