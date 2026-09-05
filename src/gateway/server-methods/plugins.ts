// Gateway handlers for read-only plugin inventory, inspection and catalog search.
import {
  ErrorCodes,
  errorShape,
  validatePluginsInspectParams,
  validatePluginsListParams,
  validatePluginsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { searchInstallablePluginPackages } from "../../plugins/catalog-search.js";
import { getPluginRuntimeGeneration } from "../../plugins/lifecycle.js";
import { inspectManagedPlugin, listManagedPlugins } from "../../plugins/management-service.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { listPluginServiceHealthFailures } from "../../plugins/service-health.js";
import { pluginLifecycleError } from "./plugins-lifecycle-error.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const pluginsHandlers: GatewayRequestHandlers = {
  "plugins.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    try {
      const catalog = await listManagedPlugins({});
      // Read after I/O; the loader's first record is authoritative for shadowed IDs.
      const registry = getActivePluginRegistry();
      const records = new Map(registry?.plugins.toReversed().map((record) => [record.id, record]));
      const failures = new Map(
        registry
          ? listPluginServiceHealthFailures(registry).map((failure) => [failure.pluginId, failure])
          : [],
      );
      respond(
        true,
        {
          ...catalog,
          generation: getPluginRuntimeGeneration(),
          plugins: catalog.plugins.map((plugin) => {
            const record = records.get(plugin.id);
            const failure = failures.get(plugin.id);
            const error = failure ? `${failure.serviceId}: ${failure.error}` : record?.error;
            return Object.assign(plugin, {
              runtime: {
                state:
                  record?.status === "loaded"
                    ? failure
                      ? "service-failed"
                      : "active"
                    : record?.status === "disabled"
                      ? "disabled"
                      : "unloaded",
                ...(error ? { error: error.slice(0, 2000) } : {}),
              },
            });
          }),
        },
        undefined,
      );
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
      respond(false, undefined, pluginLifecycleError(error));
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
};
