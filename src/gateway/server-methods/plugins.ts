// Gateway control-plane handlers for cold plugin catalog and lifecycle operations.
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  isClawHubTrustErrorCode,
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsSearchParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { searchInstallablePluginPackages } from "../../plugins/catalog-search.js";
import {
  formatManagedPluginLifecycleError,
  installManagedPlugin,
  listManagedPlugins,
  ManagedPluginLifecycleError,
  setManagedPluginEnabled,
  uninstallManagedPlugin,
} from "../../plugins/management-service.js";
import { buildGatewayReloadPlan } from "../config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../config-reload-settings.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function pluginPolicyRestartRequired(params: {
  config: OpenClawConfig;
  changedPaths: readonly string[];
}): boolean {
  const plan = buildGatewayReloadPlan([...params.changedPaths]);
  const mode = resolveGatewayReloadSettings(params.config).mode;
  return plan.restartGateway || mode === "off";
}

/** Gateway handlers for plugin inventory, ClawHub search, install, and policy state. */
export const pluginsHandlers: GatewayRequestHandlers = {
  "plugins.refresh": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsRefreshParams, "plugins.refresh", respond)) {
      return;
    }
    context.notifyPluginMetadataChanged();
    respond(true, { ok: true }, undefined);
  },
  "plugins.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validatePluginsListParams, "plugins.list", respond)) {
      return;
    }
    try {
      respond(true, await listManagedPlugins({ config: context.getRuntimeConfig() }), undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatManagedPluginLifecycleError(error)),
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
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, formatManagedPluginLifecycleError(error)),
      );
    }
  },
  "plugins.install": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsInstallParams, "plugins.install", respond)) {
      return;
    }
    try {
      const result = await installManagedPlugin({ request: params });
      respond(
        true,
        {
          ok: true,
          plugin: result.plugin,
          restartRequired: true,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      const lifecycleError = error instanceof ManagedPluginLifecycleError ? error : undefined;
      const trustCode =
        lifecycleError?.code && isClawHubTrustErrorCode(lifecycleError.code)
          ? lifecycleError.code
          : undefined;
      const details = lifecycleError
        ? buildClawHubTrustErrorDetails({
            ...(trustCode ? { code: trustCode } : {}),
            ...(lifecycleError.version ? { version: lifecycleError.version } : {}),
            ...(lifecycleError.warning ? { warning: lifecycleError.warning } : {}),
          })
        : undefined;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatManagedPluginLifecycleError(error),
          details ? { details } : undefined,
        ),
      );
    }
  },
  "plugins.uninstall": async ({ params, respond }) => {
    if (!assertValidParams(params, validatePluginsUninstallParams, "plugins.uninstall", respond)) {
      return;
    }
    try {
      const result = await uninstallManagedPlugin({ pluginId: params.pluginId });
      respond(
        true,
        {
          ok: true,
          pluginId: result.pluginId,
          restartRequired: true,
          removed: result.removed,
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
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
          formatManagedPluginLifecycleError(error),
        ),
      );
    }
  },
  "plugins.setEnabled": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validatePluginsSetEnabledParams, "plugins.setEnabled", respond)
    ) {
      return;
    }
    try {
      const result = await setManagedPluginEnabled({
        pluginId: params.pluginId,
        enabled: params.enabled,
      });
      respond(
        true,
        {
          ok: true,
          plugin: result.plugin,
          restartRequired: pluginPolicyRestartRequired({
            config: context.getRuntimeConfig(),
            changedPaths: result.changedPaths,
          }),
          ...(result.warnings ? { warnings: result.warnings } : {}),
        },
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
          formatManagedPluginLifecycleError(error),
        ),
      );
    }
  },
};
