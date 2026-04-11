import { createRequire } from "node:module";
import { mergePluginTextTransforms } from "../agents/plugin-text-transforms.js";
import type { PluginTextTransforms } from "./types.js";

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

export function resolveRuntimeTextTransforms(): PluginTextTransforms | undefined {
  const registry = loadPluginRuntime()?.getActivePluginRegistry();
  const pluginTextTransforms = Array.isArray(registry?.textTransforms)
    ? registry.textTransforms.map((entry) => entry.transforms)
    : [];
  return mergePluginTextTransforms(...pluginTextTransforms);
}
