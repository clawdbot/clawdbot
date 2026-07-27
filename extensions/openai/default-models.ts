// Openai plugin module implements default models behavior.
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import {
  applyAgentDefaultModelPrimary,
  resolveAgentModelPrimaryValue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const OPENAI_DEFAULT_MODEL = "openai/gpt-5.6";
export const OPENAI_CODEX_DEFAULT_MODEL = "openai/gpt-5.6-sol";
export const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const OPENAI_DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const OPENAI_DEFAULT_TTS_VOICE = "alloy";
export const OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function applyOpenAIProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const configuredModel = cfg.agents?.defaults?.model;
  const configuredRefs = [
    resolveAgentModelPrimaryValue(configuredModel),
    ...(typeof configuredModel === "object" ? (configuredModel.fallbacks ?? []) : []),
  ].filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0);
  const withConfiguredRefs = configuredRefs.reduce(
    (next, modelRef) => ensureModelAllowlistEntry({ cfg: next, modelRef }),
    cfg,
  );
  const next = ensureModelAllowlistEntry({
    cfg: withConfiguredRefs,
    modelRef: OPENAI_DEFAULT_MODEL,
  });
  const models = { ...next.agents?.defaults?.models };
  const gptAliasClaimed = Object.entries(models).some(
    ([modelRef, model]) =>
      modelRef !== OPENAI_DEFAULT_MODEL && model?.alias?.trim().toLowerCase() === "gpt",
  );
  models[OPENAI_DEFAULT_MODEL] = {
    ...models[OPENAI_DEFAULT_MODEL],
    ...(models[OPENAI_DEFAULT_MODEL]?.alias === undefined && !gptAliasClaimed
      ? { alias: "GPT" }
      : {}),
  };

  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        models,
      },
    },
  };
}

export function applyOpenAIConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = applyOpenAIProviderConfig(cfg);
  return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) === undefined
    ? applyAgentDefaultModelPrimary(next, OPENAI_DEFAULT_MODEL)
    : next;
}
