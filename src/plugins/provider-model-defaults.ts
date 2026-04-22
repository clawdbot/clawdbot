import type { OpenClawConfig } from "../config/types.openclaw.js";
export {
  applyOpencodeZenModelDefault,
  OPENCODE_ZEN_DEFAULT_MODEL,
} from "../plugin-sdk/opencode.js";
import { ensureModelAllowlistEntry } from "./provider-model-allowlist.js";
import { applyAgentDefaultPrimaryModel } from "./provider-model-primary.js";

export const OPENAI_DEFAULT_MODEL = "openai/gpt-5.4";
export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.4";
export const OPENAI_DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const OPENAI_DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const OPENAI_DEFAULT_TTS_VOICE = "alloy";
export const OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
export const OPENAI_DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
export const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.5";

export function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({ cfg, model: GOOGLE_GEMINI_DEFAULT_MODEL });
}

export function applyOpenAIProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = ensureModelAllowlistEntry({
    cfg,
    modelRef: OPENAI_DEFAULT_MODEL,
  });
  const models = { ...next.agents?.defaults?.models };
  models[OPENAI_DEFAULT_MODEL] = {
    ...models[OPENAI_DEFAULT_MODEL],
    alias: models[OPENAI_DEFAULT_MODEL]?.alias ?? "GPT",
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
  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        model:
          next.agents?.defaults?.model && typeof next.agents.defaults.model === "object"
            ? {
                ...next.agents.defaults.model,
                primary: OPENAI_DEFAULT_MODEL,
              }
            : { primary: OPENAI_DEFAULT_MODEL },
      },
    },
  };
}

export function applyOpencodeGoModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({ cfg, model: OPENCODE_GO_DEFAULT_MODEL_REF });
}
