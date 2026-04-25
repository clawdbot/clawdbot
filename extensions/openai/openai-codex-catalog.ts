import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "./base-url.js";

export const OPENAI_CODEX_BASE_URL = OPENAI_CODEX_RESPONSES_BASE_URL;

export function buildOpenAICodexProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_BASE_URL,
    api: "openai-codex-responses",
    models: [],
  };
}
