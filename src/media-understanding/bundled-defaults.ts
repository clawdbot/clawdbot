import { normalizeMediaProviderId } from "./provider-id.js";
import type { MediaUnderstandingCapability } from "./types.js";

type BundledMediaProviderDefaults = {
  defaultModels?: Partial<Record<MediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<MediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
};

const BUNDLED_MEDIA_PROVIDER_DEFAULTS: Record<string, BundledMediaProviderDefaults> = {
  openai: {
    defaultModels: { image: "gpt-5.4-mini", audio: "gpt-4o-transcribe" },
    autoPriority: { image: 10, audio: 10 },
  },
  "openai-codex": {
    defaultModels: { image: "gpt-5.4" },
  },
  anthropic: {
    defaultModels: { image: "claude-opus-4-7" },
    autoPriority: { image: 20 },
    nativeDocumentInputs: ["pdf"],
  },
  google: {
    defaultModels: {
      image: "gemini-3-flash-preview",
      audio: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    autoPriority: { image: 30, audio: 40, video: 10 },
    nativeDocumentInputs: ["pdf"],
  },
  groq: {
    defaultModels: { audio: "whisper-large-v3-turbo" },
    autoPriority: { audio: 20 },
  },
  deepgram: {
    defaultModels: { audio: "nova-3" },
    autoPriority: { audio: 30 },
  },
  mistral: {
    defaultModels: { audio: "voxtral-mini-latest" },
    autoPriority: { audio: 50 },
  },
  minimax: {
    defaultModels: { image: "MiniMax-VL-01" },
    autoPriority: { image: 40 },
  },
  "minimax-portal": {
    defaultModels: { image: "MiniMax-VL-01" },
    autoPriority: { image: 50 },
  },
  zai: {
    defaultModels: { image: "glm-4.6v" },
    autoPriority: { image: 60 },
  },
  qwen: {
    defaultModels: { image: "qwen-vl-max-latest", video: "qwen-vl-max-latest" },
    autoPriority: { video: 15 },
  },
  moonshot: {
    defaultModels: { image: "kimi-k2.5", video: "kimi-k2.5" },
    autoPriority: { video: 20 },
  },
  openrouter: {
    defaultModels: { image: "auto" },
  },
};

export function getBundledMediaProviderDefaults(
  providerId: string,
): BundledMediaProviderDefaults | null {
  return BUNDLED_MEDIA_PROVIDER_DEFAULTS[normalizeMediaProviderId(providerId)] ?? null;
}

export function resolveBundledDefaultMediaModel(params: {
  providerId: string;
  capability: MediaUnderstandingCapability;
}): string | undefined {
  return getBundledMediaProviderDefaults(params.providerId)?.defaultModels?.[
    params.capability
  ]?.trim();
}

export function resolveBundledAutoMediaKeyProviders(
  capability: MediaUnderstandingCapability,
): string[] {
  return Object.entries(BUNDLED_MEDIA_PROVIDER_DEFAULTS)
    .map(([providerId, defaults]) => ({
      providerId,
      priority: defaults.autoPriority?.[capability],
    }))
    .filter(
      (entry): entry is { providerId: string; priority: number } =>
        typeof entry.priority === "number",
    )
    .toSorted((left, right) => {
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.providerId.localeCompare(right.providerId);
    })
    .map((entry) => entry.providerId);
}

export function bundledProviderSupportsNativePdfDocument(providerId: string): boolean {
  return (
    getBundledMediaProviderDefaults(providerId)?.nativeDocumentInputs?.includes("pdf") ?? false
  );
}
