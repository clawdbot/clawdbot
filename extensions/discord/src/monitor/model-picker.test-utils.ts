import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";

export function createModelsProviderData(
  entries: Record<string, string[]>,
  opts?: { defaultProviderOrder?: "insertion" | "sorted" },
): ModelsProviderData {
  const byProvider = new Map<string, Set<string>>();
  for (const [provider, models] of Object.entries(entries)) {
    byProvider.set(provider, new Set(models));
  }
  const providers = Object.keys(entries).toSorted();
  const insertionProvider = Object.keys(entries)[0];
  const defaultProvider =
    opts?.defaultProviderOrder === "sorted"
      ? (providers[0] ?? "openai")
      : (insertionProvider ?? "openai");
  return {
    byProvider,
    providers,
    resolvedDefault: {
      provider: defaultProvider,
      model: entries[defaultProvider]?.[0] ?? "gpt-4o",
    },
    modelNames: new Map<string, string>(),
  };
}
