// Resolves plugin enablement state from config and channel context.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import { normalizePluginId, normalizePluginsConfig } from "./config-state.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

type PluginEnableOptions = {
  updateChannelConfig?: boolean;
};

/** Result of enabling a plugin in config. */
export type PluginEnableResult = {
  config: OpenClawConfig;
  enabled: boolean;
  pluginId: string;
  reason?: string;
};

/** Enables a plugin in config unless global, denylist, or allowlist policy blocks it. */
export function enablePluginInConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  options: PluginEnableOptions = {},
): PluginEnableResult {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  const resolvedId = normalizePluginId(builtInChannelId ?? pluginId);
  const plugins = normalizePluginsConfig(cfg.plugins);
  if (!plugins.enabled) {
    return { config: cfg, enabled: false, pluginId: resolvedId, reason: "plugins disabled" };
  }
  if (plugins.deny.includes(resolvedId)) {
    return { config: cfg, enabled: false, pluginId: resolvedId, reason: "blocked by denylist" };
  }
  if (plugins.allow.length > 0 && !plugins.allow.includes(resolvedId)) {
    return { config: cfg, enabled: false, pluginId: resolvedId, reason: "blocked by allowlist" };
  }
  return {
    config: setPluginEnabledInConfig(cfg, resolvedId, true, options),
    enabled: true,
    pluginId: resolvedId,
  };
}

/**
 * Enables a plugin selected through an explicit user action.
 *
 * ClickClack is bundled without a separate install trust record, so selecting
 * it is the trust gesture that materializes its id in a restrictive allowlist.
 */
export function enableExplicitlySelectedPluginInConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  options: PluginEnableOptions = {},
): PluginEnableResult {
  const result = enablePluginInConfig(cfg, pluginId, options);
  if (result.reason !== "blocked by allowlist" || result.pluginId !== "clickclack") {
    return result;
  }
  return enablePluginInConfig(
    ensurePluginAllowlisted(cfg, result.pluginId),
    result.pluginId,
    options,
  );
}

/** Review a managed plugin before an explicit setup action activates it. */
export async function enablePluginWithCapabilityConsent(
  cfg: OpenClawConfig,
  pluginId: string,
  options: PluginEnableOptions & {
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
    onCapabilityConsent?: PluginCapabilityConsentHandler;
    beforePersistentEffect?: () => void | Promise<void>;
  } = {},
): Promise<PluginEnableResult> {
  const result = enableExplicitlySelectedPluginInConfig(cfg, pluginId, options);
  if (!result.enabled) {
    return result;
  }
  try {
    const { withPluginLifecycleLease } = await import("./plugin-lifecycle-lease.js");
    return await withPluginLifecycleLease({ env: options.env }, async () => {
      const { loadInstalledPluginIndexInstallRecords } =
        await import("./installed-plugin-index-records.js");
      const records = await loadInstalledPluginIndexInstallRecords({ env: options.env });
      if (Object.keys(records).length === 0) {
        return result;
      }
      const { resolvePluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
      const metadata = resolvePluginMetadataSnapshot({
        config: cfg,
        env: options.env,
        workspaceDir: options.workspaceDir,
        allowCurrent: false,
      });
      const id = metadata.normalizePluginId(result.pluginId);
      const installed = metadata.index.plugins.find((plugin) => plugin.pluginId === id);
      // Compare the original state, never the synthetic enabled config. Legacy
      // plugins already running remain available without retroactive consent.
      if (installed && !installed.enabled && installed.origin !== "bundled") {
        const { resolvePluginCapabilityConsent } = await import("./capability-consent.js");
        await resolvePluginCapabilityConsent({
          config: cfg,
          pluginId: id,
          env: options.env,
          metadata,
          onCapabilityConsent: options.onCapabilityConsent,
          beforePersistentEffect: options.beforePersistentEffect,
        });
      }
      return result;
    });
  } catch (error) {
    // A declined review is a policy result; prompt navigation and guard failures must unwind.
    if (!(error instanceof ManagedPluginLifecycleError)) {
      throw error;
    }
    return {
      config: cfg,
      pluginId: result.pluginId,
      enabled: false,
      reason: sanitizeTerminalText(error.message),
    };
  }
}
