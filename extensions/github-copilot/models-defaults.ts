import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  resolveCopilotModelCompat,
  resolveCopilotTransportApi,
  resolveStaticCopilotModelOverride,
} from "./model-metadata.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

// Copilot model ids vary by plan/org and can change.
// We keep this list intentionally broad; if a model isn't available Copilot will
// return an error and users can remove it from their config.
const DEFAULT_MODEL_IDS = [
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-sonnet-4",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3.1-pro",
  "gpt-4.1",
  "gpt-5-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "grok-code-fast-1",
  "raptor-mini",
  "goldeneye",
] as const;

export function getDefaultCopilotModelIds(): string[] {
  return [...DEFAULT_MODEL_IDS];
}

export function buildCopilotModelDefinition(modelId: string): ModelDefinitionConfig {
  const id = modelId.trim();
  if (!id) {
    throw new Error("Model id required");
  }
  const staticOverride = resolveStaticCopilotModelOverride(id);
  const compat = staticOverride?.compat ?? resolveCopilotModelCompat(id);
  return {
    id,
    name: staticOverride?.name ?? id,
    api: staticOverride?.api ?? resolveCopilotTransportApi(id),
    reasoning: staticOverride?.reasoning ?? false,
    input: staticOverride?.input ?? ["text", "image"],
    cost: staticOverride?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: staticOverride?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: staticOverride?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(compat ? { compat } : {}),
  };
}
