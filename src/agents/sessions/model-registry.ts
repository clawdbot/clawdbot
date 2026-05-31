/**
 * Model registry - manages configured/provider-owned models and API key resolution.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { registerApiProvider } from "../../llm/api-registry.js";
import { resetApiProviders } from "../../llm/providers/register-builtins.js";
import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  SimpleStreamOptions,
} from "../../llm/types.js";
import { registerOAuthProvider, resetOAuthProviders } from "../../llm/utils/oauth/index.js";
import type { OAuthProviderInterface } from "../../llm/utils/oauth/types.js";
import { getAgentDir } from "../config.js";
import { resolveModelPluginMetadataSnapshot } from "../model-discovery-context.js";
import {
  filterGeneratedPluginModelCatalogProviders,
  isGeneratedPluginModelCatalog,
  listPluginModelCatalogFiles,
  type PluginModelCatalogMetadataSnapshot,
} from "../plugin-model-catalog.js";
import type { AuthStatus, AuthStorage } from "./auth-storage.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";
import {
  clearConfigValueCache,
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

// Schema for OpenRouter routing preferences
const PercentileCutoffsSchema = Type.Object({
  p50: Type.Optional(Type.Number()),
  p75: Type.Optional(Type.Number()),
  p90: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
  allow_fallbacks: Type.Optional(Type.Boolean()),
  require_parameters: Type.Optional(Type.Boolean()),
  data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
  zdr: Type.Optional(Type.Boolean()),
  enforce_distillable_text: Type.Optional(Type.Boolean()),
  order: Type.Optional(Type.Array(Type.String())),
  only: Type.Optional(Type.Array(Type.String())),
  ignore: Type.Optional(Type.Array(Type.String())),
  quantizations: Type.Optional(Type.Array(Type.String())),
  sort: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({
        by: Type.Optional(Type.String()),
        partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    ]),
  ),
  max_price: Type.Optional(
    Type.Object({
      prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    }),
  ),
  preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
  preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String())),
});

// Schema for thinking level support and provider-specific values
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
const ThinkingLevelMapSchema = Type.Object({
  off: Type.Optional(ThinkingLevelMapValueSchema),
  minimal: Type.Optional(ThinkingLevelMapValueSchema),
  low: Type.Optional(ThinkingLevelMapValueSchema),
  medium: Type.Optional(ThinkingLevelMapValueSchema),
  high: Type.Optional(ThinkingLevelMapValueSchema),
  xhigh: Type.Optional(ThinkingLevelMapValueSchema),
  max: Type.Optional(ThinkingLevelMapValueSchema),
});

const OpenAICompletionsCompatSchema = Type.Object({
  supportsStore: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  maxTokensField: Type.Optional(
    Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")]),
  ),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("openrouter"),
      Type.Literal("together"),
      Type.Literal("deepseek"),
      Type.Literal("zai"),
      Type.Literal("qwen"),
      Type.Literal("qwen-chat-template"),
    ]),
  ),
  cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const OpenAIResponsesCompatSchema = Type.Object({
  sendSessionIdHeader: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const AnthropicMessagesCompatSchema = Type.Object({
  supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
  supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

const ProviderCompatSchema = Type.Union([
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
  AnthropicMessagesCompatSchema,
]);

const ProviderAuthModeSchema = Type.Union([
  Type.Literal("api-key"),
  Type.Literal("aws-sdk"),
  Type.Literal("oauth"),
  Type.Literal("token"),
]);
type ProviderAuthMode = Static<typeof ProviderAuthModeSchema>;

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.String({ minLength: 1 })),
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
  cost: Type.Optional(
    Type.Object({
      input: Type.Number(),
      output: Type.Number(),
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
    }),
  ),
  contextWindow: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
});

const ProviderConfigSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  auth: Type.Optional(ProviderAuthModeSchema),
  api: Type.Optional(Type.String({ minLength: 1 })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  compat: Type.Optional(ProviderCompatSchema),
  authHeader: Type.Optional(Type.Boolean()),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
});

const ModelsConfigSchema = Type.Object({
  generatedBy: Type.Optional(Type.String()),
  providers: Type.Record(Type.String(), ProviderConfigSchema),
});

const validateModelsConfig = Compile(ModelsConfigSchema);

type ModelsConfig = Static<typeof ModelsConfigSchema>;

function formatValidationPath(error: TLocalizedValidationError): string {
  if (error.keyword === "required") {
    const requiredProperties = (error.params as { requiredProperties?: string[] })
      .requiredProperties;
    const requiredProperty = requiredProperties?.[0];
    if (requiredProperty) {
      const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
      return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
    }
  }
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return path || "root";
}

function allowsMissingProviderApiKey(auth: ProviderAuthMode | undefined): boolean {
  return auth === "aws-sdk" || auth === "oauth";
}

/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

interface ProviderRequestConfig {
  apiKey?: string;
  auth?: ProviderAuthMode;
  headers?: Record<string, string>;
  authHeader?: boolean;
}

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

/** Result of loading custom models from models.json */
interface CustomModelsResult {
  models: Model[];
  error: string | undefined;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { models: [], error };
}

type ModelRegistryOptions = {
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  workspaceDir?: string;
};

function mergeCompat(
  baseCompat: Model["compat"],
  overrideCompat: Model["compat"],
): Model["compat"] | undefined {
  if (!overrideCompat) {
    return baseCompat;
  }

  const base = baseCompat;
  const override = overrideCompat;
  const merged = { ...base, ...override } as
    | OpenAICompletionsCompat
    | OpenAIResponsesCompat
    | AnthropicMessagesCompat;

  const baseCompletions = base as OpenAICompletionsCompat | undefined;
  const overrideCompletions = override as OpenAICompletionsCompat;
  const mergedCompletions = merged as OpenAICompletionsCompat;

  if (baseCompletions?.openRouterRouting || overrideCompletions.openRouterRouting) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting,
    };
  }

  if (baseCompletions?.vercelGatewayRouting || overrideCompletions.vercelGatewayRouting) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting,
    };
  }

  return merged as Model["compat"];
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
  private models: Model[] = [];
  private providerRequestConfigs: Map<string, ProviderRequestConfig> = new Map();
  private modelRequestHeaders: Map<string, Record<string, string>> = new Map();
  private registeredProviders: Map<string, ProviderConfigInput> = new Map();
  private loadError: string | undefined = undefined;
  readonly authStorage: AuthStorage;
  private modelsJsonPath: string | undefined;
  private pluginMetadataSnapshot: PluginModelCatalogMetadataSnapshot | undefined;

  private constructor(
    authStorage: AuthStorage,
    modelsJsonPath: string | undefined,
    options: ModelRegistryOptions = {},
  ) {
    this.authStorage = authStorage;
    this.modelsJsonPath = modelsJsonPath;
    this.pluginMetadataSnapshot = resolveModelPluginMetadataSnapshot({
      ...(options.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: options.pluginMetadataSnapshot }
        : {}),
      ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
      allowWorkspaceScopedCurrent: true,
      useRuntimeConfig: true,
    });
    this.loadModels();
  }

  static create(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
    options: ModelRegistryOptions = {},
  ): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath, options);
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /**
   * Reload models from disk (models.json).
   */
  refresh(): void {
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;

    // Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
    resetApiProviders();
    resetOAuthProviders();

    this.loadModels();

    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  /**
   * Get any error from loading models.json (undefined if no error).
   */
  getError(): string | undefined {
    return this.loadError;
  }

  private loadModels(): void {
    // Load configured models and request settings from models.json plus
    // generated plugin-owned catalog shards under the agent plugin state.
    const { models: customModels, error } = this.modelsJsonPath
      ? this.loadCustomModels(this.modelsJsonPath)
      : emptyCustomModelsResult();

    if (error) {
      this.loadError = error;
      // Keep the prior empty/default registry shape when models.json failed to load.
    }

    let combined = customModels;

    // Let OAuth providers modify their models (e.g., update baseUrl)
    for (const oauthProvider of this.authStorage.getOAuthProviders()) {
      const cred = this.authStorage.get(oauthProvider.id);
      if (cred?.type === "oauth" && oauthProvider.modifyModels) {
        combined = oauthProvider.modifyModels(combined, cred);
      }
    }

    this.models = combined;
  }

  private loadCustomModels(
    modelsJsonPath: string,
    options: {
      catalogPluginId?: string;
      includePluginCatalogs?: boolean;
      requireGeneratedCatalog?: boolean;
    } = {
      includePluginCatalogs: true,
    },
  ): CustomModelsResult {
    if (!existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }

    try {
      const content = readFileSync(modelsJsonPath, "utf-8");
      const parsed = JSON.parse(stripJsonComments(content)) as unknown;
      if (options.requireGeneratedCatalog === true && !isGeneratedPluginModelCatalog(parsed)) {
        return emptyCustomModelsResult();
      }

      if (!validateModelsConfig.Check(parsed)) {
        const errors =
          validateModelsConfig
            .Errors(parsed)
            .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
            .join("\n") || "Unknown schema error";
        return emptyCustomModelsResult(
          `Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`,
        );
      }

      const config = parsed;
      const providers =
        options.requireGeneratedCatalog === true
          ? filterGeneratedPluginModelCatalogProviders({
              catalogPluginId: options.catalogPluginId,
              parsedCatalog: parsed,
              pluginMetadataSnapshot: this.pluginMetadataSnapshot,
              providers: config.providers,
            })
          : config.providers;
      const configForUse = { ...config, providers };
      if (options.requireGeneratedCatalog === true && Object.keys(providers).length === 0) {
        return emptyCustomModelsResult();
      }

      // Additional validation
      this.validateConfig(configForUse);

      for (const [providerName, providerConfig] of Object.entries(configForUse.providers)) {
        if ((providerConfig.models ?? []).length > 0) {
          this.storeProviderRequestConfig(providerName, providerConfig);
        }
      }

      const models = this.parseModels(configForUse);
      if (options.includePluginCatalogs !== false) {
        for (const pluginCatalog of listPluginModelCatalogFiles(dirname(modelsJsonPath))) {
          const pluginResult = this.loadCustomModels(pluginCatalog.path, {
            catalogPluginId: pluginCatalog.pluginId,
            includePluginCatalogs: false,
            requireGeneratedCatalog: true,
          });
          if (pluginResult.error) {
            return pluginResult;
          }
          models.push(...pluginResult.models);
        }
      }

      return { models, error: undefined };
    } catch (error) {
      if (error instanceof SyntaxError) {
        if (options.requireGeneratedCatalog === true) {
          return emptyCustomModelsResult();
        }
        return emptyCustomModelsResult(
          `Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`,
        );
      }
      return emptyCustomModelsResult(
        `Failed to load models.json: ${error instanceof Error ? error.message : String(error)}\n\nFile: ${modelsJsonPath}`,
      );
    }
  }

  private validateConfig(config: ModelsConfig): void {
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const hasProviderApi = Boolean(providerConfig.api);
      const models = providerConfig.models ?? [];

      if (models.length === 0) {
        continue;
      }

      // Provider-owned/custom catalogs must be self-contained.
      if (!providerConfig.baseUrl) {
        throw new Error(
          `Provider ${providerName}: "baseUrl" is required when defining custom models.`,
        );
      }
      if (!providerConfig.apiKey && !allowsMissingProviderApiKey(providerConfig.auth)) {
        throw new Error(
          `Provider ${providerName}: "apiKey" is required when defining custom models.`,
        );
      }

      for (const modelDef of models) {
        const hasModelApi = Boolean(modelDef.api);

        if (!hasProviderApi && !hasModelApi) {
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
          );
        }

        if (!modelDef.id) {
          throw new Error(`Provider ${providerName}: model missing "id"`);
        }
        // Validate contextWindow/maxTokens only if provided (they have defaults)
        if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`);
        }
        if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0) {
          throw new Error(`Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`);
        }
      }
    }
  }

  private parseModels(config: ModelsConfig): Model[] {
    const models: Model[] = [];

    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) {
        continue;
      }

      for (const modelDef of modelDefs) {
        const api = modelDef.api ?? providerConfig.api;
        if (!api) {
          continue;
        }

        const baseUrl = modelDef.baseUrl ?? providerConfig.baseUrl;
        if (!baseUrl) {
          continue;
        }

        const compat = mergeCompat(providerConfig.compat, modelDef.compat);
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        models.push({
          id: modelDef.id,
          name: modelDef.name ?? modelDef.id,
          api: api as Api,
          provider: providerName,
          baseUrl,
          reasoning: modelDef.reasoning ?? false,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input ?? ["text"],
          cost: modelDef.cost ?? defaultCost,
          contextWindow: modelDef.contextWindow ?? 128000,
          maxTokens: modelDef.maxTokens ?? 16384,
          headers: undefined,
          compat,
        } as Model);
      }
    }

    return models;
  }

  /**
   * Get all configured models.
   */
  getAll(): Model[] {
    return this.models;
  }

  /**
   * Get only models that have auth configured.
   * This is a fast check that doesn't refresh OAuth tokens.
   */
  getAvailable(): Model[] {
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  /**
   * Find a model by provider and ID.
   */
  find(provider: string, modelId: string): Model | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  /**
   * Get API key for a model.
   */
  hasConfiguredAuth(model: Model): boolean {
    return (
      this.authStorage.hasAuth(model.provider) ||
      this.providerRequestConfigs.get(model.provider)?.auth === "aws-sdk" ||
      this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined
    );
  }

  private getModelRequestKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: {
      apiKey?: string;
      auth?: ProviderAuthMode;
      headers?: Record<string, string>;
      authHeader?: boolean;
    },
  ): void {
    if (!config.apiKey && !config.auth && !config.headers && !config.authHeader) {
      return;
    }

    this.providerRequestConfigs.set(providerName, {
      apiKey: config.apiKey,
      auth: config.auth,
      headers: config.headers,
      authHeader: config.authHeader,
    });
  }

  private storeModelHeaders(
    providerName: string,
    modelId: string,
    headers?: Record<string, string>,
  ): void {
    const key = this.getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  /**
   * Get API key and request headers for a model.
   */
  async getApiKeyAndHeaders(model: Model): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const usesAwsSdkAuth = providerConfig?.auth === "aws-sdk";
      const apiKeyFromAuthStorage = usesAwsSdkAuth
        ? undefined
        : await this.authStorage.getApiKey(model.provider, {
            includeFallback: false,
          });
      const apiKey =
        apiKeyFromAuthStorage ??
        (!usesAwsSdkAuth && providerConfig?.apiKey
          ? resolveConfigValueOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);

      const providerHeaders = resolveHeadersOrThrow(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const modelHeaders = resolveHeadersOrThrow(
        this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
        `model "${model.provider}/${model.id}"`,
      );

      let headers =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return { ok: false, error: `No API key found for "${model.provider}"` };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }

      return {
        ok: true,
        apiKey,
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Return auth status for a provider, including request auth configured in models.json.
   * This intentionally does not execute command-backed config values.
   */
  getProviderAuthStatus(provider: string): AuthStatus {
    const providerRequestConfig = this.providerRequestConfigs.get(provider);
    if (providerRequestConfig?.auth === "aws-sdk") {
      return { configured: true, source: "models_json_key", label: providerRequestConfig.auth };
    }

    const authStatus = this.authStorage.getAuthStatus(provider);
    if (authStatus.source) {
      return authStatus;
    }

    const providerApiKey = providerRequestConfig?.apiKey;
    if (!providerApiKey) {
      return authStatus;
    }

    if (providerApiKey.startsWith("!")) {
      return { configured: true, source: "models_json_command" };
    }

    if (process.env[providerApiKey]) {
      return { configured: true, source: "environment", label: providerApiKey };
    }

    return { configured: true, source: "models_json_key" };
  }

  /**
   * Get display name for a provider.
   */
  getProviderDisplayName(provider: string): string {
    const registeredProvider = this.registeredProviders.get(provider);
    const oauthProvider = this.authStorage.getOAuthProviders().find((p) => p.id === provider);

    return (
      registeredProvider?.name ??
      registeredProvider?.oauth?.name ??
      oauthProvider?.name ??
      BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
      provider
    );
  }

  /**
   * Get API key for a provider.
   */
  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const apiKey = await this.authStorage.getApiKey(provider, { includeFallback: false });
    if (apiKey !== undefined) {
      return apiKey;
    }

    const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
    return providerApiKey ? resolveConfigValueUncached(providerApiKey) : undefined;
  }

  /**
   * Check if a model is using OAuth credentials (subscription).
   */
  isUsingOAuth(model: Model): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }

  /**
   * Register a provider dynamically (from extensions).
   *
   * If provider has models: replaces all existing models for this provider.
   * Provider-level request settings are stored for already-known models but
   * never create implicit model rows.
   * If provider has oauth: registers OAuth provider for /login support.
   */
  registerProvider(providerName: string, config: ProviderConfigInput): void {
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.upsertRegisteredProvider(providerName, config);
  }

  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   */
  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) {
      return;
    }
    this.registeredProviders.delete(providerName);
    this.refresh();
  }

  /**
   * Upsert a provider config into registeredProviders.
   * If the provider is already registered, defined values in the incoming config
   * override existing ones; undefined values are preserved from the stored config.
   * If the provider is not registered, the incoming config is stored as-is.
   */
  private upsertRegisteredProvider(providerName: string, config: ProviderConfigInput): void {
    const existing = this.registeredProviders.get(providerName);
    if (!existing) {
      this.registeredProviders.set(providerName, config);
      return;
    }
    for (const k of Object.keys(config) as (keyof ProviderConfigInput)[]) {
      if (config[k] !== undefined) {
        (existing as Record<string, unknown>)[k] = config[k];
      }
    }
  }

  private validateProviderConfig(providerName: string, config: ProviderConfigInput): void {
    if (config.streamSimple && !config.api) {
      throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
    }

    if (!config.models || config.models.length === 0) {
      return;
    }

    if (!config.baseUrl) {
      throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
    }
    if (!config.apiKey && !config.oauth && !allowsMissingProviderApiKey(config.auth)) {
      throw new Error(
        `Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`,
      );
    }

    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
      }
    }
  }

  private applyProviderConfig(providerName: string, config: ProviderConfigInput): void {
    // Register OAuth provider if provided
    if (config.oauth) {
      // Ensure the OAuth provider ID matches the provider name
      const oauthProvider: OAuthProviderInterface = {
        ...config.oauth,
        id: providerName,
      };
      registerOAuthProvider(oauthProvider);
    }

    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) =>
            streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple,
        },
        `provider:${providerName}`,
      );
    }

    this.storeProviderRequestConfig(providerName, config);

    if (config.models && config.models.length > 0) {
      // Full replacement: remove existing models for this provider
      this.models = this.models.filter((m) => m.provider !== providerName);

      // Parse and add new models
      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        this.models.push({
          id: modelDef.id,
          name: modelDef.name,
          api: api as Api,
          provider: providerName,
          baseUrl: modelDef.baseUrl ?? config.baseUrl!,
          reasoning: modelDef.reasoning,
          thinkingLevelMap: modelDef.thinkingLevelMap,
          input: modelDef.input,
          cost: modelDef.cost,
          contextWindow: modelDef.contextWindow,
          maxTokens: modelDef.maxTokens,
          headers: undefined,
          compat: modelDef.compat,
        } as Model);
      }

      // Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
      if (config.oauth?.modifyModels) {
        const cred = this.authStorage.get(providerName);
        if (cred?.type === "oauth") {
          this.models = config.oauth.modifyModels(this.models, cred);
        }
      }
    }
  }
}

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  auth?: ProviderAuthMode;
  api?: Api;
  streamSimple?: (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStreamContract;
  headers?: Record<string, string>;
  authHeader?: boolean;
  /** OAuth provider for /login support */
  oauth?: Omit<OAuthProviderInterface, "id">;
  models?: Array<{
    id: string;
    name: string;
    api?: Api;
    baseUrl?: string;
    reasoning: boolean;
    thinkingLevelMap?: Model["thinkingLevelMap"];
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: Model["compat"];
  }>;
}
