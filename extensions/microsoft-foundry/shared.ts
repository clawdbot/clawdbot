import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  type ProviderAuthResult,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelApi, ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

export const PROVIDER_ID = "microsoft-foundry";
export const DEFAULT_API = "openai-completions";
export const DEFAULT_GPT5_API = "openai-responses";
export const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AzAccount {
  name: string;
  id: string;
  tenantId?: string;
  user?: { name?: string };
  state?: string;
  isDefault?: boolean;
}

export interface AzAccessToken {
  accessToken: string;
  expiresOn?: string;
}

export interface AzCognitiveAccount {
  id: string;
  name: string;
  kind: string;
  location?: string;
  resourceGroup?: string;
  endpoint?: string | null;
  customSubdomain?: string | null;
  projects?: string[] | null;
}

export interface FoundryResourceOption {
  id: string;
  accountName: string;
  kind: "AIServices" | "OpenAI";
  location?: string;
  resourceGroup: string;
  endpoint: string;
  projects: string[];
}

export interface AzDeploymentSummary {
  name: string;
  modelName?: string;
  modelVersion?: string;
  state?: string;
  sku?: string;
}

export type FoundrySelection = {
  endpoint: string;
  modelId: string;
  modelNameHint?: string;
  api: FoundryProviderApi;
};

export type CachedTokenEntry = {
  token: string;
  expiresAt: number;
};

export type FoundryProviderApi = typeof DEFAULT_API | typeof DEFAULT_GPT5_API;

type FoundryDeploymentConfigInput = {
  name: string;
  modelName?: string;
  api?: FoundryProviderApi;
};

type FoundryModelCapabilities = {
  modelName: string;
  api: FoundryProviderApi;
  input: Array<"text" | "image">;
  compat?: FoundryModelCompat;
};

function normalizeModelInput(input?: unknown): Array<"text" | "image"> {
  const normalized = Array.isArray(input)
    ? input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  return normalized.length > 0 ? normalized : ["text"];
}

type FoundryModelCompat = {
  supportsStore?: boolean;
  maxTokensField: "max_completion_tokens" | "max_tokens";
};

type FoundryAuthProfileConfig = {
  provider: string;
  mode: "api_key" | "oauth" | "token";
  email?: string;
};

type FoundryConfigShape = {
  auth?: {
    profiles?: Record<string, FoundryAuthProfileConfig>;
    order?: Record<string, string[]>;
  };
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
};

function normalizeFoundryModelName(value?: string | null): string | undefined {
  const trimmed = normalizeLowercaseStringOrEmpty(value);
  return trimmed || undefined;
}

export function usesFoundryResponsesByDefault(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized === "computer-use-preview"
  );
}

export function supportsFoundryImageInput(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized === "computer-use-preview"
  );
}

export function requiresFoundryMaxCompletionTokens(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

export function isFoundryProviderApi(value?: string | null): value is FoundryProviderApi {
  return value === DEFAULT_API || value === DEFAULT_GPT5_API;
}

export function normalizeFoundryEndpoint(endpoint: string): string {
  const trimmed = normalizeOptionalString(endpoint) ?? "";
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    const normalizedPath = parsed.pathname.replace(/\/openai(?:$|\/).*/i, "").replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath && normalizedPath !== "/" ? normalizedPath : ""}`;
  } catch {
    const withoutQuery = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return withoutQuery.replace(/\/openai(?:$|\/).*/i, "");
  }
}

function buildFoundryV1BaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
}

export function resolveFoundryApi(
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
): FoundryProviderApi {
  if (isFoundryProviderApi(configuredApi)) {
    return configuredApi;
  }
  const configuredModelName = resolveConfiguredModelNameHint(modelId, modelNameHint);
  return usesFoundryResponsesByDefault(configuredModelName) ? DEFAULT_GPT5_API : DEFAULT_API;
}

export function buildFoundryProviderBaseUrl(
  endpoint: string,
  _modelId: string,
  _modelNameHint?: string | null,
  _configuredApi?: ModelApi | null,
): string {
  return buildFoundryV1BaseUrl(endpoint);
}

export function extractFoundryEndpoint(baseUrl: string | null | undefined): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  try {
    return normalizeFoundryEndpoint(baseUrl);
  } catch {
    return undefined;
  }
}

function buildFoundryModelCompat(
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
): FoundryModelCompat | undefined {
  const resolvedApi = resolveFoundryApi(modelId, modelNameHint, configuredApi);
  const configuredModelName = resolveConfiguredModelNameHint(modelId, modelNameHint);
  const needsMaxCompletionTokens = requiresFoundryMaxCompletionTokens(configuredModelName);
  if (resolvedApi !== DEFAULT_GPT5_API && !needsMaxCompletionTokens) {
    return undefined;
  }
  return {
    ...(resolvedApi === DEFAULT_GPT5_API ? { supportsStore: false } : {}),
    maxTokensField: needsMaxCompletionTokens ? "max_completion_tokens" : "max_tokens",
  };
}

export function resolveFoundryModelCapabilities(
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
  existingInput?: unknown,
): FoundryModelCapabilities {
  const modelName = resolveConfiguredModelNameHint(modelId, modelNameHint) ?? modelId;
  const api = resolveFoundryApi(modelId, modelName, configuredApi);
  const normalizedInput = normalizeModelInput(existingInput);
  return {
    modelName,
    api,
    input:
      normalizedInput.includes("image") || supportsFoundryImageInput(modelName)
        ? ["text", "image"]
        : normalizedInput,
    compat: buildFoundryModelCompat(modelId, modelName, api),
  };
}

export function resolveConfiguredModelNameHint(
  modelId: string,
  modelNameHint?: string | null,
): string | undefined {
  const trimmedName = normalizeOptionalString(modelNameHint) ?? "";
  if (trimmedName) {
    return trimmedName;
  }
  const trimmedId = normalizeOptionalString(modelId) ?? "";
  return trimmedId ? trimmedId : undefined;
}

function buildFoundryProviderConfig(
  endpoint: string,
  modelId: string,
  modelNameHint?: string | null,
  options?: {
    api?: FoundryProviderApi;
    authMethod?: "api-key" | "entra-id";
    apiKey?: SecretInput;
    deployments?: FoundryDeploymentConfigInput[];
  },
): ModelProviderConfig {
  const runtimeApiKey = options?.authMethod === "api-key" ? options.apiKey : undefined;
  const isApiKeyAuth = options?.authMethod === "api-key";
  const deployments = options?.deployments?.length
    ? options.deployments
    : [{ name: modelId, modelName: modelNameHint ?? undefined }];
  const resolvedApi = resolveFoundryApi(modelId, modelNameHint, options?.api);
  return {
    baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint, resolvedApi),
    api: resolvedApi,
    ...(isApiKeyAuth
      ? {
          authHeader: false,
          ...(runtimeApiKey !== undefined
            ? { apiKey: runtimeApiKey, headers: { "api-key": runtimeApiKey } }
            : {}),
        }
      : {}),
    models: deployments.map((deployment) => {
      const capabilities = resolveFoundryModelCapabilities(
        deployment.name,
        deployment.modelName,
        deployment.api,
      );
      return Object.assign(
        {
          id: deployment.name,
          name: capabilities.modelName,
          api: capabilities.api,
          reasoning: false,
          input: capabilities.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128e3,
          maxTokens: 16384,
        },
        capabilities.compat ? { compat: capabilities.compat } : {},
      );
    }),
  };
}

function buildFoundryCredentialMetadata(params: {
  authMethod: "api-key" | "entra-id";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  api?: FoundryProviderApi;
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
}): Record<string, string> {
  const resolvedApi = resolveFoundryApi(params.modelId, params.modelNameHint, params.api);
  const metadata: Record<string, string> = {
    authMethod: params.authMethod,
    endpoint: params.endpoint,
    modelId: params.modelId,
    api: resolvedApi,
  };
  const modelName = resolveConfiguredModelNameHint(params.modelId, params.modelNameHint);
  if (modelName) {
    metadata.modelName = modelName;
  }
  if (params.subscriptionId) {
    metadata.subscriptionId = params.subscriptionId;
  }
  if (params.subscriptionName) {
    metadata.subscriptionName = params.subscriptionName;
  }
  if (params.tenantId) {
    metadata.tenantId = params.tenantId;
  }
  return metadata;
}

/**
 * Build the plugins.allow patch so the provider is allowlisted when the
 * config already gates plugins via a non-empty allow array.  Returns an
 * empty object when no patch is needed (allowlist absent / already listed).
 */
function buildPluginsAllowPatch(
  currentAllow: string[] | undefined,
): { plugins: { allow: string[] } } | Record<string, never> {
  if (!Array.isArray(currentAllow) || currentAllow.length === 0) {
    return {};
  }
  if (currentAllow.includes(PROVIDER_ID)) {
    return {};
  }
  return { plugins: { allow: [...currentAllow, PROVIDER_ID] } };
}

function buildFoundryAuthOrderPatch(params: {
  profileId: string;
  currentProviderProfileIds?: string[];
}): { auth: { order: Record<string, string[]> } } {
  const nextOrder = [
    params.profileId,
    ...(params.currentProviderProfileIds ?? []).filter(
      (profileId) => profileId !== params.profileId,
    ),
  ];
  return {
    auth: {
      order: {
        [PROVIDER_ID]: nextOrder,
      },
    },
  };
}

export function listConfiguredFoundryProfileIds(config: FoundryConfigShape): string[] {
  return Object.entries(config.auth?.profiles ?? {})
    .filter(([, profile]) => profile.provider === PROVIDER_ID)
    .map(([profileId]) => profileId);
}

export function buildFoundryAuthResult(params: {
  profileId: string;
  apiKey: SecretInput;
  secretInputMode?: "plaintext" | "ref";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  api: FoundryProviderApi;
  authMethod: "api-key" | "entra-id";
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  notes?: string[];
  /** Current plugins.allow so the provider can self-allowlist during onboard. */
  currentPluginsAllow?: string[];
  currentProviderProfileIds?: string[];
  deployments?: FoundryDeploymentConfigInput[];
}): ProviderAuthResult {
  return {
    profiles: [
      {
        profileId: params.profileId,
        credential: buildApiKeyCredential(
          PROVIDER_ID,
          params.apiKey,
          buildFoundryCredentialMetadata({
            authMethod: params.authMethod,
            endpoint: params.endpoint,
            modelId: params.modelId,
            modelNameHint: params.modelNameHint,
            api: params.api,
            subscriptionId: params.subscriptionId,
            subscriptionName: params.subscriptionName,
            tenantId: params.tenantId,
          }),
          params.secretInputMode ? { secretInputMode: params.secretInputMode } : undefined,
        ),
      },
    ],
    configPatch: {
      ...buildFoundryAuthOrderPatch({
        profileId: params.profileId,
        currentProviderProfileIds: params.currentProviderProfileIds,
      }),
      models: {
        providers: {
          [PROVIDER_ID]: buildFoundryProviderConfig(
            params.endpoint,
            params.modelId,
            params.modelNameHint,
            {
              api: params.api,
              authMethod: params.authMethod,
              apiKey: params.apiKey,
              deployments: params.deployments,
            },
          ),
        },
      },
      ...buildPluginsAllowPatch(params.currentPluginsAllow),
    },
    defaultModel: `${PROVIDER_ID}/${params.modelId}`,
    notes: params.notes,
  };
}

export function applyFoundryProfileBinding(config: FoundryConfigShape, profileId: string): void {
  const next = applyAuthProfileConfig(config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "api_key",
  });
  config.auth = next.auth;
}

export function applyFoundryProviderConfig(
  config: FoundryConfigShape,
  providerConfig: ModelProviderConfig,
): void {
  config.models ??= {};
  config.models.providers ??= {};
  config.models.providers[PROVIDER_ID] = providerConfig;
}

export function resolveFoundryTargetProfileId(config: FoundryConfigShape): string | undefined {
  const configuredProfiles = config.auth?.profiles ?? {};
  const configuredProfileEntries = Object.entries(configuredProfiles).filter(([, profile]) => {
    return profile.provider === PROVIDER_ID;
  });
  if (configuredProfileEntries.length === 0) {
    return undefined;
  }
  // Prefer the explicitly ordered profile; fall back to the sole entry when there is exactly one.
  return (
    config.auth?.order?.[PROVIDER_ID]?.find((profileId) => normalizeOptionalString(profileId)) ??
    (configuredProfileEntries.length === 1 ? configuredProfileEntries[0]?.[0] : undefined)
  );
}
