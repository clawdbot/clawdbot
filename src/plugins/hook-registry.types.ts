import type { HookEntry } from "../hooks/types.js";
import type { PluginHookRegistration as TypedPluginHookRegistration } from "./hook-types.js";

export type PluginLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

export type HookRunnerRegistry = {
  hooks: PluginLegacyHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
};

export type GlobalHookRunnerRegistry = HookRunnerRegistry & {
  plugins: Array<{
    id: string;
    status: "loaded" | "disabled" | "error";
  }>;
};
