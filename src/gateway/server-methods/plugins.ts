// Gateway handlers for plugin inventory, metadata refresh and catalog search.
import {
  ErrorCodes,
  errorShape,
  validatePluginsInspectParams,
  validatePluginsCatalogBrowseParams,
  validatePluginsCatalogCategoriesParams,
  validatePluginsCatalogGetParams,
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  readInstallPolicyWarningErrorDetails,
} from "../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
      const trustDetails = lifecycleError
        ? buildClawHubTrustErrorDetails({
            ...(trustCode ? { code: trustCode } : {}),
            ...(lifecycleError.version ? { version: lifecycleError.version } : {}),
            ...(lifecycleError.warning ? { warning: lifecycleError.warning } : {}),
          })
        : undefined;
      const installPolicyDetails = lifecycleError?.installPolicyWarning
        ? readInstallPolicyWarningErrorDetails({
            installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
            ...lifecycleError.installPolicyWarning,
          })
        : undefined;
      const capabilityConsentDetails = lifecycleError?.capabilityConsent
        ? buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent)
        : undefined;
      const details = capabilityConsentDetails ?? installPolicyDetails ?? trustDetails;
      respond(
        false,
        undefined,
        errorShape(
          lifecycleError?.kind === "invalid-request"
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatErrorMessage(error),
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
          formatErrorMessage(error),
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
        ...(params.acknowledgeCapabilities
          ? { acknowledgeCapabilities: params.acknowledgeCapabilities }
          : {}),
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
          formatErrorMessage(error),
          lifecycleError?.capabilityConsent
            ? { details: buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent) }
            : undefined,
        ),
      );
    }
  },
};
