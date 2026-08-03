/**
 * Commands port — abstracts slash-command dependencies injected by the
 * bridge layer (version resolvers, approve runtime getter).
 *
 * Eliminates global `register*` singletons in `slash-commands-impl.ts`.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";

/** Runtime getter shape for the `/bot-approve` command. */
export type ApproveRuntimeGetter = () => {
  config: Pick<PluginRuntime["config"], "current" | "replaceConfigFile">;
};

export interface CommandsPort {
  /** Resolve the framework runtime version string. */
  resolveVersion: () => string;
  /** Plugin version string (e.g. "1.2.3"). */
  pluginVersion: string;
  /** Runtime getter for `/bot-approve` config management. */
  approveRuntimeGetter?: ApproveRuntimeGetter;
}
