import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getActivePluginRegistry } from "./runtime.js";

export const PI_EMBEDDED_EXTENSION_RUNTIME_ID = "pi";

export function listEmbeddedExtensionFactories(): ExtensionFactory[] {
  return getActivePluginRegistry()?.embeddedExtensionFactories?.map((entry) => entry.factory) ?? [];
}
