import {
  MCP_ENV_REFERENCE_RE,
  mcpValueHasEnvReferences,
  resolveMcpEnvReferences,
} from "./config-env.js";
// Hermes provider config contract parsing and normalization.
import { childRecord, isRecord, readString, readStringArray } from "./helpers.js";
import { normalizeHermesCustomProviderId, normalizeHermesProviderId } from "./model.js";

type OpenClawModelApi =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses"
  | "openai-chatgpt-responses";

type HermesModelConfig = {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  supportsVision?: boolean;
};

export type HermesProviderConfig = {
  id: string;
  baseUrl: string;
  api: OpenClawModelApi;
  apiKeyEnv?: string;
  headers?: Record<string, unknown>;
  models: HermesModelConfig[];
  sensitive?: boolean;
};

export const HERMES_TRANSPORTS: Record<string, OpenClawModelApi> = {
  anthropic_messages: "anthropic-messages",
  chat_completions: "openai-completions",
  codex_responses: "openai-responses",
  openai_chat: "openai-completions",
};
const HERMES_MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";
const HERMES_MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/anthropic";
const HERMES_ALIBABA_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const HERMES_SPECIAL_BASE_URL_ENV_VARS: Record<string, readonly string[]> = {
  // Hermes plain `custom` still reads OPENAI_BASE_URL in its runtime provider resolver.
  custom: ["CUSTOM_BASE_URL", "OPENAI_BASE_URL"],
  "openai-api": ["OPENAI_BASE_URL"],
  "xai-oauth": ["HERMES_XAI_BASE_URL", "XAI_BASE_URL"],
  "qwen-oauth": ["HERMES_QWEN_BASE_URL"],
  "qwen-cli": ["HERMES_QWEN_BASE_URL"],
  "qwen-portal": ["HERMES_QWEN_BASE_URL"],
  "minimax-cn": ["MINIMAX_CN_BASE_URL"],
  "alibaba-coding-plan": ["ALIBABA_CODING_PLAN_BASE_URL"],
};

const HERMES_BASE_URL_ENV_VARS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_BASE_URL"],
  arcee: ["ARCEE_BASE_URL"],
  "azure-foundry": ["AZURE_FOUNDRY_BASE_URL"],
  deepseek: ["DEEPSEEK_BASE_URL"],
  gmi: ["GMI_BASE_URL"],
  google: ["GEMINI_BASE_URL"],
  huggingface: ["HF_BASE_URL"],
  kilocode: ["KILOCODE_BASE_URL"],
  kimi: ["KIMI_BASE_URL"],
  lmstudio: ["LM_BASE_URL"],
  minimax: ["MINIMAX_BASE_URL"],
  novita: ["NOVITA_BASE_URL"],
  nvidia: ["NVIDIA_BASE_URL"],
  "ollama-cloud": ["OLLAMA_BASE_URL"],
  opencode: ["OPENCODE_ZEN_BASE_URL"],
  "opencode-go": ["OPENCODE_GO_BASE_URL"],
  openrouter: ["OPENROUTER_BASE_URL"],
  qwen: ["DASHSCOPE_BASE_URL"],
  stepfun: ["STEPFUN_BASE_URL"],
  "tencent-tokenhub": ["TOKENHUB_BASE_URL"],
  xai: ["XAI_BASE_URL"],
  xiaomi: ["XIAOMI_BASE_URL"],
  zai: ["GLM_BASE_URL"],
};

const HERMES_SPECIAL_API_KEY_ENV_VARS: Record<string, string> = {
  custom: "OPENAI_API_KEY",
  "openai-api": "OPENAI_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "alibaba-coding-plan": "ALIBABA_CODING_PLAN_API_KEY",
};

const HERMES_API_KEY_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  arcee: "ARCEEAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GOOGLE_API_KEY",
  huggingface: "HF_TOKEN",
  kilocode: "KILOCODE_API_KEY",
  kimi: "KIMI_API_KEY",
  lmstudio: "LM_API_KEY",
  minimax: "MINIMAX_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  opencode: "OPENCODE_ZEN_API_KEY",
  "opencode-go": "OPENCODE_GO_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  stepfun: "STEPFUN_API_KEY",
  xai: "XAI_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  zai: "ZAI_API_KEY",
};

function resolveHermesProviderEnvValue(
  providerId: string | undefined,
  env: Record<string, string>,
  special: Record<string, readonly string[]>,
  canonical: Record<string, readonly string[]>,
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const sourceProvider = normalizeHermesCustomProviderId(providerId);
  const provider = normalizeHermesProviderId(sourceProvider);
  const names = special[sourceProvider] ?? canonical[provider] ?? [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveHermesProviderBaseUrlEnv(
  providerId: string | undefined,
  env: Record<string, string>,
): string | undefined {
  return resolveHermesProviderEnvValue(
    providerId,
    env,
    HERMES_SPECIAL_BASE_URL_ENV_VARS,
    HERMES_BASE_URL_ENV_VARS,
  );
}

export function resolveHermesProviderApiKeyEnv(providerId: string | undefined): string | undefined {
  if (!providerId) {
    return undefined;
  }
  const sourceProvider = normalizeHermesCustomProviderId(providerId);
  const provider = normalizeHermesProviderId(sourceProvider);
  return HERMES_SPECIAL_API_KEY_ENV_VARS[sourceProvider] ?? HERMES_API_KEY_ENV_VARS[provider];
}

export function resolveHermesImplicitBaseUrl(providerId: string | undefined): string | undefined {
  const provider = providerId?.trim().toLowerCase();
  if (provider && ["alibaba", "alibaba-cloud", "aliyun", "dashscope"].includes(provider)) {
    return HERMES_ALIBABA_BASE_URL;
  }
  // OpenClaw's qwen default is already Hermes' coding-plan endpoint; no override needed.
  if (provider && ["kimi-coding-cn", "kimi-cn", "moonshot-cn"].includes(provider)) {
    return HERMES_MOONSHOT_CN_BASE_URL;
  }
  return provider && ["minimax-cn", "minimax-china", "minimax_cn"].includes(provider)
    ? HERMES_MINIMAX_CN_BASE_URL
    : undefined;
}

export function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveProviderApi(
  raw: Record<string, unknown>,
  providerId?: string,
): OpenClawModelApi | undefined {
  const transport = readString(raw.transport) ?? readString(raw.api_mode);
  const sourceProvider = providerId?.trim().toLowerCase() ?? "";
  if (sourceProvider === "openai-codex") {
    return "openai-chatgpt-responses";
  }
  if (transport && transport !== "codex_responses") {
    return HERMES_TRANSPORTS[transport];
  }
  const provider = sourceProvider ? normalizeHermesProviderId(sourceProvider) : "";
  const baseUrl =
    readString(raw.base_url) ??
    readString(raw.baseUrl) ??
    readString(raw.url) ??
    readString(raw.api);
  let hostname = "";
  let pathname = "";
  try {
    const parsed = baseUrl ? new URL(baseUrl) : undefined;
    hostname = parsed?.hostname.toLowerCase() ?? "";
    pathname = parsed?.pathname.toLowerCase().replace(/\/+$/u, "") ?? "";
  } catch {
    // Provider identity still supplies the protocol for templated endpoints.
  }
  // Hermes honors an explicit Responses mode for named providers. Plain
  // `custom` is the exception: endpoint detection rejects stale Responses state.
  if (transport === "codex_responses" && sourceProvider !== "custom") {
    return "openai-responses";
  }
  if (
    ["anthropic", "minimax", "minimax-cn", "minimax-oauth"].includes(provider) ||
    hostname === "api.anthropic.com" ||
    (hostname === "api.kimi.com" && (pathname === "/coding" || pathname.startsWith("/coding/"))) ||
    pathname.endsWith("/anthropic") ||
    pathname.endsWith("/anthropic/v1")
  ) {
    return "anthropic-messages";
  }
  if (hostname === "chatgpt.com" && pathname.includes("/backend-api/codex")) {
    return "openai-chatgpt-responses";
  }
  if (sourceProvider === "openai-api") {
    return "openai-responses";
  }
  if (transport === "codex_responses") {
    return "openai-responses";
  }
  if (provider === "xai" || hostname === "api.x.ai" || hostname === "api.openai.com") {
    return "openai-responses";
  }
  return "openai-completions";
}

function normalizeProviderBaseUrl(baseUrl: string, api: OpenClawModelApi): string {
  if (api !== "anthropic-messages") {
    return baseUrl;
  }
  try {
    const parsed = new URL(baseUrl);
    // The Anthropic SDK appends /v1/messages. Store the canonical base so
    // imported proxy paths do not repeat the version segment.
    parsed.pathname = parsed.pathname.replace(/\/v1\/?$/u, "");
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return baseUrl;
  }
}

export function readEnvReference(value: unknown): string | undefined {
  const raw = readString(value);
  const match = raw?.match(/^\$\{([^}]+)\}$/u);
  return match ? normalizeHermesEnvReferenceName(match[1] ?? "") : undefined;
}

function normalizeHermesEnvReferenceName(value: string): string | undefined {
  const trimmed = value.trim();
  const name = trimmed.startsWith("env:") ? trimmed.slice("env:".length).trim() : trimmed;
  return name || undefined;
}

export function readProviderApiKeyEnv(raw: Record<string, unknown>): string | undefined {
  return (
    readString(raw.key_env) ??
    readString(raw.api_key_env) ??
    readString(raw.apiKeyEnv) ??
    readString(raw.env) ??
    readEnvReference(raw.api_key)
  );
}

export function resolveHermesEndpointApiKeyEnv(baseUrl: string): string | undefined {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === "openai.com" ||
      hostname.endsWith(".openai.com") ||
      hostname === "openai.azure.com" ||
      hostname.endsWith(".openai.azure.com")
      ? "OPENAI_API_KEY"
      : undefined;
  } catch {
    return undefined;
  }
}

function readModelMetadata(raw: Record<string, unknown>): Omit<HermesModelConfig, "id"> {
  const contextWindow =
    readPositiveNumber(raw.context_length) ?? readPositiveNumber(raw.contextWindow);
  const maxTokens =
    readPositiveNumber(raw.max_tokens) ??
    readPositiveNumber(raw.max_output_tokens) ??
    readPositiveNumber(raw.maxTokens);
  const supportsVision = raw.supports_vision ?? raw.supportsVision;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    ...(typeof supportsVision === "boolean" ? { supportsVision } : {}),
  };
}

export function collectProviderModels(raw: Record<string, unknown>): HermesModelConfig[] {
  const models = new Map<string, HermesModelConfig>();
  const rootMetadata = readModelMetadata(raw);
  for (const modelId of readStringArray(raw.models)) {
    models.set(modelId, { id: modelId, ...rootMetadata });
  }
  for (const [modelId, metadata] of Object.entries(childRecord(raw, "models"))) {
    models.set(modelId, {
      id: modelId,
      ...rootMetadata,
      ...(isRecord(metadata) ? readModelMetadata(metadata) : {}),
    });
  }
  for (const modelId of [
    readString(raw.default_model),
    readString(raw.default),
    readString(raw.model),
  ]) {
    if (modelId && !models.has(modelId)) {
      models.set(modelId, { id: modelId, ...rootMetadata });
    }
  }
  return [...models.values()];
}

function modelDefinition(
  model: HermesModelConfig,
  entry: HermesProviderConfig,
): Record<string, unknown> {
  const baseUrl = normalizeProviderBaseUrl(entry.baseUrl, entry.api);
  return {
    id: model.id,
    name: model.id,
    api: entry.api,
    reasoning: false,
    input: model.supportsVision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8192,
    baseUrl,
    metadataSource: "models-add",
  };
}

export function providerConfig(entry: HermesProviderConfig): Record<string, unknown> {
  const models = entry.models.length > 0 ? entry.models : [{ id: "default" }];
  return {
    baseUrl: normalizeProviderBaseUrl(entry.baseUrl, entry.api),
    api: entry.api,
    ...(entry.headers ? { headers: entry.headers } : {}),
    models: models.map((model) => modelDefinition(model, entry)),
  };
}

export function readProviderBaseUrl(
  raw: Record<string, unknown>,
  env: Record<string, string>,
): { baseUrl?: string; sensitive: boolean; unresolved: boolean } {
  const value =
    readString(raw.base_url) ??
    readString(raw.baseUrl) ??
    readString(raw.url) ??
    readString(raw.api);
  if (!value) {
    return { sensitive: false, unresolved: false };
  }
  const sensitive = MCP_ENV_REFERENCE_RE.test(value);
  MCP_ENV_REFERENCE_RE.lastIndex = 0;
  if (!sensitive) {
    return { baseUrl: value, sensitive: false, unresolved: false };
  }
  const resolved = resolveMcpEnvReferences(value, env);
  return {
    baseUrl:
      !resolved.unresolved && typeof resolved.value === "string" ? resolved.value : undefined,
    sensitive: true,
    unresolved: resolved.unresolved,
  };
}

export function readProviderHeaders(
  raw: Record<string, unknown>,
  env: Record<string, string>,
  includeSecrets: boolean,
): {
  blocked: boolean;
  headers?: Record<string, unknown>;
  invalid: boolean;
  sensitive: boolean;
  unresolved: boolean;
} {
  const source = isRecord(raw.extra_headers) ? raw.extra_headers : undefined;
  if (!source || Object.keys(source).length === 0) {
    return { blocked: false, invalid: false, sensitive: false, unresolved: false };
  }
  const headers: Record<string, unknown> = {};
  let blocked = false;
  let invalid = false;
  let sensitive = false;
  let unresolved = false;
  for (const [name, rawValue] of Object.entries(source)) {
    if (rawValue === null || rawValue === undefined) {
      continue;
    }
    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      invalid = true;
      continue;
    }
    const value = String(rawValue);
    const envName = readEnvReference(value);
    const hasReference = mcpValueHasEnvReferences(value);
    if (!includeSecrets) {
      blocked = true;
      continue;
    }
    sensitive = true;
    if (envName) {
      const resolved = env[envName];
      if (resolved === undefined) {
        unresolved = true;
        continue;
      }
      headers[name] = resolved;
      continue;
    }
    if (hasReference) {
      const resolved = resolveMcpEnvReferences(value, env);
      if (resolved.unresolved || typeof resolved.value !== "string") {
        unresolved = true;
        continue;
      }
      headers[name] = resolved.value;
      continue;
    }
    headers[name] = value;
  }
  return {
    blocked,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    invalid,
    sensitive,
    unresolved,
  };
}
