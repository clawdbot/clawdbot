// Migrate Hermes plugin module implements model behavior.
import {
  resolveAgentEffectiveModelPrimary,
  resolveDefaultAgentId,
  setAgentEffectiveModelPrimary,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveMigrationConfigRuntime } from "openclaw/plugin-sdk/migration";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { readString } from "./helpers.js";
import {
  HERMES_REASON_ALREADY_CONFIGURED,
  HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE,
  HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
  hermesItemConflict,
  hermesItemError,
  hermesItemSkipped,
  readHermesModelDetails,
} from "./items.js";

const HERMES_PROVIDER_ALIASES: Record<string, string> = {
  alibaba: "qwen",
  "alibaba-cloud": "qwen",
  "alibaba-coding": "qwen",
  "alibaba-coding-plan": "qwen",
  alibaba_coding: "qwen",
  alibaba_coding_plan: "qwen",
  aliyun: "qwen",
  "azure-foundry": "microsoft-foundry",
  bedrock: "amazon-bedrock",
  claude: "anthropic",
  "claude-code": "anthropic",
  copilot: "github-copilot",
  gemini: "google",
  github: "github-copilot",
  "github-copilot": "github-copilot",
  "github-model": "github-copilot",
  "github-models": "github-copilot",
  glm: "zai",
  google: "google",
  "google-ai-studio": "google",
  "google-gemini": "google",
  grok: "xai",
  kilo: "kilocode",
  "kilo-code": "kilocode",
  "kilo-gateway": "kilocode",
  kimi: "kimi",
  "kimi-cn": "moonshot",
  "kimi-for-coding": "kimi",
  "kimi-coding": "kimi",
  "kimi-coding-cn": "moonshot",
  "moonshot-cn": "moonshot",
  moonshot: "moonshot",
  "minimax-global": "minimax-portal",
  "minimax-cn": "minimax",
  "minimax-oauth": "minimax-portal",
  "minimax-portal": "minimax-portal",
  minimax_oauth: "minimax-portal",
  "opencode-zen": "opencode",
  "openai-api": "openai",
  "openai-codex": "openai",
  dashscope: "qwen",
  qwen: "qwen",
  "qwen-cli": "qwen",
  "qwen-oauth": "qwen",
  "qwen-portal": "qwen",
  "x-ai": "xai",
  "x-ai-oauth": "xai",
  "x.ai": "xai",
  "xai-grok-oauth": "xai",
  "xai-oauth": "xai",
  "grok-oauth": "xai",
  "z-ai": "zai",
  "z.ai": "zai",
  zen: "opencode",
  zhipu: "zai",
  vertex: "google-vertex",
};

const HERMES_CANONICAL_PROVIDER_IDS = new Set([
  "alibaba",
  "alibaba-coding-plan",
  "anthropic",
  "arcee",
  "azure-foundry",
  "bedrock",
  "copilot",
  "copilot-acp",
  "deepseek",
  "fireworks",
  "github-copilot",
  "gemini",
  "gmi",
  "huggingface",
  "kilo",
  "kilocode",
  "kimi-coding",
  "kimi-coding-cn",
  "kimi-for-coding",
  "lmstudio",
  "minimax",
  "minimax-cn",
  "minimax-oauth",
  "moa",
  "nous",
  "novita",
  "nvidia",
  "ollama-cloud",
  "openai-api",
  "openai-codex",
  "opencode",
  "opencode-go",
  "opencode-zen",
  "openrouter",
  "stepfun",
  "tencent-tokenhub",
  "xai",
  "xai-oauth",
  "xiaomi",
  "zai",
  "vertex",
]);
const HERMES_DYNAMIC_KIMI_PROVIDER_IDS = new Set([
  "kimi",
  "kimi-coding",
  "kimi-for-coding",
  "moonshot",
]);
const HERMES_RETIRED_QWEN_PROVIDER_IDS = new Set(["qwen-cli", "qwen-oauth", "qwen-portal"]);

export function normalizeHermesProviderId(provider: string): string {
  const normalized = normalizeHermesCustomProviderId(provider);
  return HERMES_PROVIDER_ALIASES[normalized] ?? normalized;
}

export function normalizeHermesCustomProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const withoutCustomPrefix = normalized.startsWith("custom:")
    ? normalized.slice("custom:".length)
    : normalized;
  return withoutCustomPrefix.replaceAll(" ", "-");
}

function isRetiredHermesQwenProviderValue(value: string): boolean {
  const slash = value.indexOf("/");
  const provider = slash > 0 ? value.slice(0, slash) : value;
  return HERMES_RETIRED_QWEN_PROVIDER_IDS.has(normalizeHermesCustomProviderId(provider));
}

export function usesRetiredHermesQwenProvider(config: Record<string, unknown>): boolean {
  const model = asRecord(config.model);
  return [
    readString(config.provider),
    typeof config.model === "string" ? config.model : undefined,
    readString(model?.provider),
    readString(model?.default),
    readString(model?.model),
    readString(config.default_model),
    readString(config.model_name),
  ].some((value) => value !== undefined && isRetiredHermesQwenProviderValue(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readBaseUrl(value: Record<string, unknown> | undefined): string | undefined {
  return value
    ? (readString(value.base_url) ??
        readString(value.baseUrl) ??
        readString(value.url) ??
        readString(value.api))
    : undefined;
}

function readKimiBaseUrl(
  config: Record<string, unknown>,
  provider: string,
  env: Record<string, string>,
): string | undefined {
  const model = asRecord(config.model);
  const selectedProvider = readString(model?.provider) ?? readString(config.provider);
  if (
    selectedProvider &&
    HERMES_DYNAMIC_KIMI_PROVIDER_IDS.has(normalizeHermesCustomProviderId(selectedProvider))
  ) {
    const modelBaseUrl = readBaseUrl(model);
    if (modelBaseUrl) {
      return modelBaseUrl;
    }
  }
  const providers = asRecord(config.providers);
  for (const [id, value] of Object.entries(providers ?? {})) {
    if (
      normalizeHermesCustomProviderId(id) === normalizeHermesCustomProviderId(provider) &&
      asRecord(value)
    ) {
      const providerBaseUrl = readBaseUrl(asRecord(value));
      if (providerBaseUrl) {
        return providerBaseUrl;
      }
    }
  }
  return env.KIMI_BASE_URL?.trim() || undefined;
}

function resolveHermesKimiProviderId(
  config: Record<string, unknown>,
  provider: string,
  env: Record<string, string>,
): "kimi" | "moonshot" | undefined {
  const sourceProvider = normalizeHermesCustomProviderId(provider);
  if (!HERMES_DYNAMIC_KIMI_PROVIDER_IDS.has(sourceProvider)) {
    return undefined;
  }
  const baseUrl = readKimiBaseUrl(config, sourceProvider, env);
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl);
      const hostname = parsed.hostname.toLowerCase();
      const pathname = parsed.pathname.toLowerCase().replace(/\/+$/u, "");
      if (hostname === "api.kimi.com" && (pathname === "/coding" || pathname === "/coding/v1")) {
        return "kimi";
      }
      if (hostname === "api.moonshot.ai") {
        return "moonshot";
      }
    } catch {
      // Preserve the named route for custom or templated endpoints.
    }
    return normalizeHermesProviderId(sourceProvider) === "moonshot" ? "moonshot" : "kimi";
  }
  const apiKey = env.KIMI_API_KEY?.trim() || env.KIMI_CODING_API_KEY?.trim();
  // Hermes defaults to Moonshot; only Kimi Code keys select its Anthropic endpoint.
  return apiKey?.startsWith("sk-kimi-") ? "kimi" : "moonshot";
}

function hasExplicitHermesProvider(config: Record<string, unknown>, provider: string): boolean {
  const normalized = normalizeHermesCustomProviderId(provider);
  if (
    HERMES_CANONICAL_PROVIDER_IDS.has(normalized) ||
    HERMES_RETIRED_QWEN_PROVIDER_IDS.has(normalized)
  ) {
    return false;
  }
  const providers = config.providers;
  if (
    providers &&
    typeof providers === "object" &&
    !Array.isArray(providers) &&
    Object.keys(providers).some((id) => normalizeHermesCustomProviderId(id) === normalized)
  ) {
    return true;
  }
  return (
    Array.isArray(config.custom_providers) &&
    config.custom_providers.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const record = entry as Record<string, unknown>;
      const id = readString(record.name) ?? readString(record.id);
      return id ? normalizeHermesCustomProviderId(id) === normalized : false;
    })
  );
}

export function resolveHermesConfiguredProviderId(
  config: Record<string, unknown>,
  provider: string,
  env: Record<string, string> = {},
): string {
  if (hasExplicitHermesProvider(config, provider)) {
    return normalizeHermesCustomProviderId(provider);
  }
  return resolveHermesKimiProviderId(config, provider, env) ?? normalizeHermesProviderId(provider);
}

function joinHermesProviderModel(
  config: Record<string, unknown>,
  provider: string | undefined,
  model: string,
  env: Record<string, string>,
): string {
  if (!provider) {
    const slash = model.indexOf("/");
    if (slash > 0 && isRetiredHermesQwenProviderValue(model)) {
      return `qwen/${model.slice(slash + 1)}`;
    }
    return model;
  }
  if (provider.trim().toLowerCase() === "auto") {
    const slash = model.indexOf("/");
    return slash > 0
      ? `${resolveHermesConfiguredProviderId(config, model.slice(0, slash), env)}/${model.slice(slash + 1)}`
      : model;
  }
  const explicitProvider = hasExplicitHermesProvider(config, provider);
  const normalizedProvider = resolveHermesConfiguredProviderId(config, provider, env);
  const slash = model.indexOf("/");
  if (slash > 0) {
    const normalizedModelProvider = explicitProvider
      ? normalizeHermesCustomProviderId(model.slice(0, slash))
      : resolveHermesConfiguredProviderId(config, model.slice(0, slash), env);
    if (normalizedModelProvider === normalizedProvider) {
      return `${normalizedProvider}/${model.slice(slash + 1)}`;
    }
  }
  return model.startsWith(`${normalizedProvider}/`) ? model : `${normalizedProvider}/${model}`;
}

export function resolveHermesModelRef(
  config: Record<string, unknown>,
  env: Record<string, string> = {},
): string | undefined {
  const model = config.model;
  if (typeof model === "string" && model.trim()) {
    const rawModel = model.trim();
    const provider = readString(config.provider);
    return joinHermesProviderModel(config, provider, rawModel, env);
  }
  if (model && typeof model === "object" && !Array.isArray(model)) {
    const modelRecord = model as Record<string, unknown>;
    const rawModel = readString(modelRecord.default) ?? readString(modelRecord.model);
    const hasCustomEndpoint = Boolean(
      readString(modelRecord.base_url) ?? readString(modelRecord.baseUrl),
    );
    const provider = readString(modelRecord.provider) ?? (hasCustomEndpoint ? "custom" : undefined);
    return rawModel ? joinHermesProviderModel(config, provider, rawModel, env) : undefined;
  }
  const rootModel = readString(config.default_model) ?? readString(config.model_name);
  const rootProvider = readString(config.provider);
  return rootModel ? joinHermesProviderModel(config, rootProvider, rootModel, env) : undefined;
}

function resolveDefaultAgentModelState(config: MigrationProviderContext["config"]): {
  agentId: string;
  effectivePrimary?: string;
} {
  const agentId = resolveDefaultAgentId(config);
  const effectivePrimary = resolveAgentEffectiveModelPrimary(config, agentId);
  return {
    agentId,
    effectivePrimary,
  };
}

export function resolveCurrentModelRef(ctx: MigrationProviderContext): string | undefined {
  return resolveDefaultAgentModelState(ctx.config).effectivePrimary;
}

class ModelApplyAbortError extends Error {
  constructor(
    readonly status: "conflict" | "skipped",
    readonly reason: string,
  ) {
    super(reason);
    this.name = "ModelApplyAbortError";
  }
}

export async function applyModelItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  const details = readHermesModelDetails(item);
  if (!details || item.status !== "planned") {
    return item;
  }
  try {
    const configApi = resolveMigrationConfigRuntime(ctx);
    if (!configApi?.current || !configApi.mutateConfigFile) {
      return hermesItemError(item, HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE);
    }
    const currentState = resolveDefaultAgentModelState(
      configApi.current() as MigrationProviderContext["config"],
    );
    if (currentState.effectivePrimary === details.model) {
      return hermesItemSkipped(item, HERMES_REASON_ALREADY_CONFIGURED);
    }
    if (currentState.effectivePrimary && !ctx.overwrite) {
      return hermesItemConflict(item, HERMES_REASON_DEFAULT_MODEL_CONFIGURED);
    }
    await configApi.mutateConfigFile({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate(draft) {
        const mutationState = resolveDefaultAgentModelState(draft);
        if (mutationState.effectivePrimary === details.model) {
          throw new ModelApplyAbortError("skipped", HERMES_REASON_ALREADY_CONFIGURED);
        }
        if (mutationState.effectivePrimary && !ctx.overwrite) {
          throw new ModelApplyAbortError("conflict", HERMES_REASON_DEFAULT_MODEL_CONFIGURED);
        }
        setAgentEffectiveModelPrimary(draft, mutationState.agentId, details.model);
      },
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    if (err instanceof ModelApplyAbortError) {
      return err.status === "conflict"
        ? hermesItemConflict(item, err.reason)
        : hermesItemSkipped(item, err.reason);
    }
    return hermesItemError(item, err instanceof Error ? err.message : String(err));
  }
}
