/**
 * Codex provider catalog constants and model definition helpers.
 */
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { CodexAppServerModel } from "./src/app-server/models.js";

/** Provider id used by Codex model refs. */
export const CODEX_PROVIDER_ID = "codex";
/** Synthetic base URL used to route Codex app-server model requests. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
/** Synthetic auth marker understood by Codex app-server runtime paths. */
export const CODEX_APP_SERVER_AUTH_MARKER = "codex-app-server";

const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;

/** Offline fallback catalog used when live app-server discovery is unavailable. */
export const FALLBACK_CODEX_MODELS = [
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "gpt-5.5",
    description: "Latest frontier agentic coding model.",
    isDefault: true,
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
] satisfies CodexAppServerModel[];

/**
 * Converts a Codex app-server model record into OpenClaw provider model config.
 */
export function buildCodexModelDefinition(model: {
  id: string;
  model: string;
  displayName?: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
}): ModelDefinitionConfig {
  const id = model.id.trim() || model.model.trim();
  return {
    id,
    name: model.displayName?.trim() || id,
    api: "openai-chatgpt-responses",
    reasoning: model.supportedReasoningEfforts.length > 0 || shouldDefaultToReasoningModel(id),
    input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
      supportsUsageInStreaming: true,
    },
  };
}

/** Builds the synthetic Codex provider config for a model list. */
export function buildCodexProviderConfig(models: CodexAppServerModel[]): ModelProviderConfig {
  return {
    baseUrl: CODEX_BASE_URL,
    apiKey: CODEX_APP_SERVER_AUTH_MARKER,
    auth: "token",
    api: "openai-chatgpt-responses",
    models: models.map(buildCodexModelDefinition),
  };
}

function shouldDefaultToReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  );
}
