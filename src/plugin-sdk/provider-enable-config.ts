// Provider enable config helpers update provider allowlists and config enablement state.
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";

type ProviderPluginConfig = {
  /** Whether this plugin entry is enabled in the persisted plugin registry. */
  enabled?: boolean;
};

type ProviderEnableConfigCarrier = {
  plugins?: {
    /** Global plugin switch; false blocks provider setup from enabling entries. */
    enabled?: boolean;
    /** Plugin ids that provider setup must not enable. */
    deny?: string[];
    /** Plugin ids allowed to load after provider setup enables them. */
    allow?: string[];
    /** Per-plugin registry entries updated by provider setup flows. */
    entries?: Record<string, ProviderPluginConfig | undefined>;
  };
};

/** Result of enabling a provider plugin while honoring plugin allow/deny policy. */
export type PluginEnableResult<TConfig extends ProviderEnableConfigCarrier> = {
  /** Config object to persist after the enable attempt. Unchanged when policy blocks the plugin. */
  config: TConfig;
  /** Whether the plugin was enabled and allowlisted. */
  enabled: boolean;
  /** Human-readable policy reason when the plugin cannot be enabled. */
  reason?: string;
};

/**
 * Enables provider plugins for provider contract setup without applying channel
 * normalization from the core plugin enable path.
 */
export function enablePluginInConfig<TConfig extends ProviderEnableConfigCarrier>(
  /** Provider setup config object to update without channel normalization. */
  cfg: TConfig,
  /** Provider plugin id to enable and allowlist. */
  pluginId: string,
): PluginEnableResult<TConfig> {
  if (cfg.plugins?.enabled === false) {
    // Policy blocks must preserve object identity so setup flows cannot persist partial plugin
    // registry edits after global plugin loading has been disabled.
    return { config: cfg, enabled: false, reason: "plugins disabled" };
  }
  if (cfg.plugins?.deny?.includes(pluginId)) {
    // Denylisted plugins are intentionally left untouched even when a provider setup selected
    // them, allowing callers to report the policy reason without mutating config.
    return { config: cfg, enabled: false, reason: "blocked by denylist" };
  }

  let next = {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        [pluginId]: {
          ...(cfg.plugins?.entries?.[pluginId] as object | undefined),
          enabled: true,
        },
      },
    },
  } as TConfig;
  // Provider setup owns plugin registry state only; allowlist updates stay in the
  // shared helper so deny/allow semantics match the core plugin enable path.
  next = ensurePluginAllowlisted(next, pluginId);
  return { config: next, enabled: true };
}
