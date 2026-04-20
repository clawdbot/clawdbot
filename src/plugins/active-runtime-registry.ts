import { createRequire } from "node:module";
import type { PluginRegistry } from "./registry-types.js";

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
      // Try built/runtime source candidates in order.
    }
  }
  return null;
}

export function getActiveRuntimePluginRegistry(): PluginRegistry | null {
  return loadPluginRuntime()?.getActivePluginRegistry() ?? null;
}
