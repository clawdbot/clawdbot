export type PluginEntryConfig = {
  enabled?: boolean;
  hooks?: {
    /** Controls prompt mutation via before_prompt_build and prompt fields from legacy before_agent_start. */
    allowPromptInjection?: boolean;
    /**
     * Controls access to raw conversation content from llm_input/llm_output/agent_end hooks.
     * Non-bundled plugins must opt in explicitly; bundled plugins stay allowed unless disabled.
     */
    allowConversationAccess?: boolean;
    /** Default timeout in milliseconds for this plugin's typed hooks. */
    timeoutMs?: number;
    /** Per typed-hook timeout overrides in milliseconds. */
    timeouts?: Record<string, number>;
  };
  subagent?: {
    /** Explicitly allow this plugin to request per-run provider/model overrides for subagent runs. */
    allowModelOverride?: boolean;
    /**
     * Allowed override targets as canonical provider/model refs.
     * Use "*" to explicitly allow any model for this plugin.
     */
    allowedModels?: string[];
  };
  config?: Record<string, unknown>;
};

export type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */
  memory?: string;
  /** Select which plugin owns the context-engine slot. */
  contextEngine?: string;
};

export type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */
  paths?: string[];
};

export type PluginInstallRecord = Omit<InstallRecordBase, "source"> & {
  source: InstallRecordBase["source"] | "marketplace";
  marketplaceName?: string;
  marketplaceSource?: string;
  marketplacePlugin?: string;
};

export type PluginsConfig = {
  /** Enable or disable plugin loading. */
  enabled?: boolean;
  /** Optional plugin allowlist (plugin ids). */
  allow?: string[];
  /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  /**
   * Internal transient carrier for plugin install records during command flows.
   * This is intentionally omitted from the config schema and must not be
   * persisted to openclaw.json.
   */
  installs?: Record<string, PluginInstallRecord>;
};
import type { InstallRecordBase } from "./types.installs.js";
