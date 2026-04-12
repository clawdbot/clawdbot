import { createRequire } from "node:module";
import type { CliBackendPlugin } from "./cli-backend.types.js";

export type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
};

type PluginRuntimeModule = Pick<typeof import("./runtime.js"), "getActivePluginRegistry">;

const require = createRequire(import.meta.url);
const RUNTIME_MODULE_CANDIDATES = ["./runtime.js", "./runtime.ts"] as const;

let pluginRuntimeModule: PluginRuntimeModule | undefined;

function loadPluginRuntime(): PluginRuntimeModule | null {
  if (pluginRuntimeModule) {
    return pluginRuntimeModule;
  }
  for (const candidate of RUNTIME_MODULE_CANDIDATES) {
    try {
      pluginRuntimeModule = require(candidate) as PluginRuntimeModule;
      return pluginRuntimeModule;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  return null;
}

export function resolveRuntimeCliBackends(): PluginCliBackendEntry[] {
  return (loadPluginRuntime()?.getActivePluginRegistry()?.cliBackends ?? []).map((entry) => ({
    ...entry.backend,
    pluginId: entry.pluginId,
  }));
}
