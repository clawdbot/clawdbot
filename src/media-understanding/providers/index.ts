import { normalizeProviderId } from "../../agents/model-selection.js";
import type { MediaUnderstandingProvider } from "../types.js";
import { anthropicProvider } from "./anthropic/index.js";
import { deepgramProvider } from "./deepgram/index.js";
import { googleProvider } from "./google/index.js";
import { groqProvider } from "./groq/index.js";
import { minimaxProvider } from "./minimax/index.js";
import { openaiProvider } from "./openai/index.js";
import { smallestaiProvider } from "./smallestai/index.js";

const PROVIDERS: MediaUnderstandingProvider[] = [
  groqProvider,
  openaiProvider,
  googleProvider,
  anthropicProvider,
  minimaxProvider,
  deepgramProvider,
  smallestaiProvider,
];

export function normalizeMediaProviderId(id: string): string {
  const normalized = normalizeProviderId(id);
  if (normalized === "gemini") return "google";
  return normalized;
}

export function buildMediaUnderstandingRegistry(
  overrides?: Record<string, MediaUnderstandingProvider>,
): Map<string, MediaUnderstandingProvider> {
  const registry = new Map<string, MediaUnderstandingProvider>();
  for (const provider of PROVIDERS) {
    registry.set(normalizeMediaProviderId(provider.id), provider);
  }
  if (overrides) {
    for (const [key, provider] of Object.entries(overrides)) {
      const normalizedKey = normalizeMediaProviderId(key);
      const existing = registry.get(normalizedKey);
      const merged = existing
        ? {
            ...existing,
            ...provider,
            capabilities: provider.capabilities ?? existing.capabilities,
          }
        : provider;
      registry.set(normalizedKey, merged);
    }
  }
  return registry;
}

export function getMediaUnderstandingProvider(
  id: string,
  registry: Map<string, MediaUnderstandingProvider>,
): MediaUnderstandingProvider | undefined {
  return registry.get(normalizeMediaProviderId(id));
}
