import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginCapabilityCatalogContext } from "./capability-catalog-context.types.js";
import type { PluginCapabilityCatalog } from "./capability-catalog.types.js";
import { unwrapDefaultModuleExport } from "./module-export.js";

export const capabilityCatalogFamilies = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;

/** Validate the declared public surface without copying provider objects or their hidden methods. */
export function resolvePluginCapabilityCatalog(
  module: unknown,
  context: PluginCapabilityCatalogContext,
): PluginCapabilityCatalog {
  const entry = unwrapDefaultModuleExport(module);
  const catalog = typeof entry === "function" ? entry(context) : entry;
  if (isPromiseLike(catalog)) {
    void Promise.resolve(catalog).catch(() => {});
    throw new Error("capability catalog factories must be synchronous");
  }
  if (!isRecord(catalog)) {
    throw new Error("default export must synchronously provide a capability descriptor collection");
  }
  const methods = {
    speechProviders: "synthesize",
    realtimeTranscriptionProviders: "createSession",
    realtimeVoiceProviders: "createBridge",
  } as const;
  for (const [family, providers] of Object.entries(catalog)) {
    if (!Object.hasOwn(methods, family)) {
      throw new Error(`unknown capability catalog family: ${family}`);
    }
    // SAFETY: the own-key check above narrows this string to the closed family map.
    const method = methods[family as keyof typeof methods];
    if (
      !Array.isArray(providers) ||
      providers.some(
        (provider) =>
          !isRecord(provider) ||
          typeof provider.id !== "string" ||
          !provider.id.trim() ||
          typeof provider.label !== "string" ||
          typeof provider.isConfigured !== "function" ||
          typeof provider[method] !== "function",
      )
    ) {
      throw new Error(`${family} must contain complete provider descriptors`);
    }
  }
  // Retain the objects so hidden methods and registrar-bound identity survive.
  // SAFETY: every family and required descriptor field/method was checked above.
  return catalog as PluginCapabilityCatalog;
}
