import type { ApiKeyCredential, AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/upsert-with-lock.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import type {
  ProviderDiscoveryContext,
  ProviderAuthResult,
  ProviderAuthMethodNonInteractiveContext,
  ProviderNonInteractiveApiKeyResult,
} from "./types.js";

export {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";

const log = createSubsystemLogger("plugins/self-hosted-provider-setup");

type OpenAICompatModelsResponse = {
  data?: Array<{
    id?: string;
    meta?: {
      n_ctx_train?: unknown;
    };
  }>;
};

type LlamaCppPropsResponse = {
  default_generation_settings?: {
    n_ctx?: unknown;
  };
  n_ctx?: unknown;
};

function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

const SELF_HOSTED_ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);

function buildSelfHostedBaseUrlSsrFPolicy(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (SELF_HOSTED_ALWAYS_BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      return undefined;
    }
    return {
      hostnameAllowlist: [parsed.hostname],
      allowPrivateNetwork: true,
    };
  } catch {
    return undefined;
  }
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

function resolveLlamaCppPropsUrl(baseUrl: string, modelId?: string): string {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const rootPathname = pathname.endsWith("/v1") ? pathname.slice(0, -3) || "/" : pathname;
  parsed.pathname = `${rootPathname.replace(/\/+$/, "")}/props`;
  parsed.search = "";
  parsed.hash = "";
  const normalizedModelId = normalizeOptionalString(modelId);
  if (normalizedModelId) {
    parsed.searchParams.set("model", normalizedModelId);
    parsed.searchParams.set("autoload", "false");
  }
  return parsed.toString();
}

async function discoverLlamaCppRuntimeContextTokens(params: {
  baseUrl: string;
  apiKey?: string;
  modelId?: string;
}): Promise<number | undefined> {
  let url: string;
  try {
    url = resolveLlamaCppPropsUrl(params.baseUrl, params.modelId);
  } catch {
    return undefined;
  }
  try {
    const trimmedApiKey = normalizeOptionalString(params.apiKey);
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
      },
      policy: buildSelfHostedBaseUrlSsrFPolicy(params.baseUrl),
      timeoutMs: 2500,
    });
    try {
      if (!response.ok) {
        return undefined;
      }
      const data = (await response.json()) as LlamaCppPropsResponse;
      return (
        readPositiveInteger(data.default_generation_settings?.n_ctx) ??
        readPositiveInteger(data.n_ctx)
      );
    } finally {
      await release();
    }
  } catch {
    return undefined;
  }
}

export async function discoverOpenAICompatibleLocalModels(params: {
  baseUrl: string;
  apiKey?: string;
  label: string;
  contextWindow?: number;
  maxTokens?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelDefinitionConfig[]> {
  const env = params.env ?? process.env;
  if (env.VITEST || env.NODE_ENV === "test") {
    return [];
  }

  const trimmedBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const url = `${trimmedBaseUrl}/models`;

  try {
    const trimmedApiKey = normalizeOptionalString(params.apiKey);
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
      },
      policy: buildSelfHostedBaseUrlSsrFPolicy(trimmedBaseUrl),
      timeoutMs: 5000,
    });
    try {
      if (!response.ok) {
        log.warn(`Failed to discover ${params.label} models: ${response.status}`);
        return [];
      }
      const data = (await response.json()) as OpenAICompatModelsResponse;
      const models = data.data ?? [];
      if (models.length === 0) {
        log.warn(`No ${params.label} models found on local instance`);
        return [];
      }

      const discoveredModels = models.flatMap((model) => {
        const modelId = normalizeOptionalString(model.id);
        if (!modelId) {
          return [];
        }
        return [{ id: modelId, meta: model.meta }];
      });
      const runtimeContextTokensByModelId = new Map<string, number>();
      if (params.contextWindow === undefined) {
        const uniqueModelIds = [...new Set(discoveredModels.map((model) => model.id))];
        const runtimeContextTokenResults = await Promise.all(
          uniqueModelIds.map(
            async (modelId) =>
              [
                modelId,
                await discoverLlamaCppRuntimeContextTokens({
                  baseUrl: trimmedBaseUrl,
                  apiKey: params.apiKey,
                  modelId: uniqueModelIds.length > 1 ? modelId : undefined,
                }),
              ] as const,
          ),
        );
        for (const [modelId, runtimeContextTokens] of runtimeContextTokenResults) {
          if (runtimeContextTokens) {
            runtimeContextTokensByModelId.set(modelId, runtimeContextTokens);
          }
        }
      }

      return discoveredModels.map((model) => {
        const modelConfig: ModelDefinitionConfig = {
          id: model.id,
          name: model.id,
          reasoning: isReasoningModelHeuristic(model.id),
          input: ["text"],
          cost: SELF_HOSTED_DEFAULT_COST,
          contextWindow:
            params.contextWindow ??
            readPositiveInteger(model.meta?.n_ctx_train) ??
            SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
          maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
        };
        const runtimeContextTokens = runtimeContextTokensByModelId.get(model.id);
        if (runtimeContextTokens) {
          modelConfig.contextTokens = runtimeContextTokens;
        }
        return modelConfig;
      });
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Failed to discover ${params.label} models: ${String(error)}`);
    return [];
  }
}

export function applyProviderDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  const existingModel = cfg.agents?.defaults?.model;
  const fallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: modelRef,
        },
      },
    },
  };
}

function buildOpenAICompatibleSelfHostedProviderConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  baseUrl: string;
  providerApiKey: string;
  modelId: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): { config: OpenClawConfig; modelId: string; modelRef: string; profileId: string } {
  const modelRef = `${params.providerId}/${params.modelId}`;
  const profileId = `${params.providerId}:default`;
  return {
    config: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        mode: params.cfg.models?.mode ?? "merge",
        providers: {
          ...params.cfg.models?.providers,
          [params.providerId]: {
            baseUrl: params.baseUrl,
            api: "openai-completions",
            apiKey: params.providerApiKey,
            models: [
              {
                id: params.modelId,
                name: params.modelId,
                reasoning: params.reasoning ?? false,
                input: params.input ?? ["text"],
                cost: SELF_HOSTED_DEFAULT_COST,
                contextWindow: params.contextWindow ?? SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
                maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
              },
            ],
          },
        },
      },
    },
    modelId: params.modelId,
    modelRef,
    profileId,
  };
}

type OpenAICompatibleSelfHostedProviderSetupParams = {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type OpenAICompatibleSelfHostedProviderPromptResult = {
  config: OpenClawConfig;
  credential: AuthProfileCredential;
  modelId: string;
  modelRef: string;
  profileId: string;
};

function buildSelfHostedProviderAuthResult(
  result: OpenAICompatibleSelfHostedProviderPromptResult,
): ProviderAuthResult {
  return {
    profiles: [
      {
        profileId: result.profileId,
        credential: result.credential,
      },
    ],
    configPatch: result.config,
    defaultModel: result.modelRef,
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProvider(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<OpenAICompatibleSelfHostedProviderPromptResult> {
  const baseUrlRaw = await params.prompter.text({
    message: `${params.providerLabel} base URL`,
    initialValue: params.defaultBaseUrl,
    placeholder: params.defaultBaseUrl,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const apiKeyRaw = await params.prompter.text({
    message: `${params.providerLabel} API key`,
    placeholder: "sk-... (or any non-empty string)",
    validate: (value) => (value?.trim() ? undefined : "Required"),
    sensitive: true,
  });
  const modelIdRaw = await params.prompter.text({
    message: `${params.providerLabel} model`,
    placeholder: params.modelPlaceholder,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });

  const baseUrl = (baseUrlRaw ?? "").trim().replace(/\/+$/, "");
  const apiKey = normalizeStringifiedOptionalString(apiKeyRaw) ?? "";
  const modelId = normalizeStringifiedOptionalString(modelIdRaw) ?? "";
  const credential: AuthProfileCredential = {
    type: "api_key",
    provider: params.providerId,
    key: apiKey,
  };
  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    cfg: params.cfg,
    providerId: params.providerId,
    baseUrl,
    providerApiKey: params.defaultApiKeyEnvVar,
    modelId,
    input: params.input,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  });

  return {
    config: configured.config,
    credential,
    modelId: configured.modelId,
    modelRef: configured.modelRef,
    profileId: configured.profileId,
  };
}

export async function promptAndConfigureOpenAICompatibleSelfHostedProviderAuth(
  params: OpenAICompatibleSelfHostedProviderSetupParams,
): Promise<ProviderAuthResult> {
  const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider(params);
  return buildSelfHostedProviderAuthResult(result);
}

export async function discoverOpenAICompatibleSelfHostedProvider<
  T extends Record<string, unknown>,
>(params: {
  ctx: ProviderDiscoveryContext;
  providerId: string;
  buildProvider: (params: { apiKey?: string }) => Promise<T>;
}): Promise<{ provider: T & { apiKey: string } } | null> {
  if (params.ctx.config.models?.providers?.[params.providerId]) {
    return null;
  }
  const { apiKey, discoveryApiKey } = params.ctx.resolveProviderApiKey(params.providerId);
  if (!apiKey) {
    return null;
  }
  return {
    provider: {
      ...(await params.buildProvider({ apiKey: discoveryApiKey })),
      apiKey,
    },
  };
}

function buildMissingNonInteractiveModelIdMessage(params: {
  authChoice: string;
  providerLabel: string;
  modelPlaceholder: string;
}): string {
  return [
    `Missing --custom-model-id for --auth-choice ${params.authChoice}.`,
    `Pass the ${params.providerLabel} model id to use, for example ${params.modelPlaceholder}.`,
  ].join("\n");
}

function buildSelfHostedProviderCredential(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  resolved: ProviderNonInteractiveApiKeyResult;
}): ApiKeyCredential | null {
  return params.ctx.toApiKeyCredential({
    provider: params.providerId,
    resolved: params.resolved,
  });
}

export async function configureOpenAICompatibleSelfHostedProviderNonInteractive(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  providerLabel: string;
  defaultBaseUrl: string;
  defaultApiKeyEnvVar: string;
  modelPlaceholder: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}): Promise<OpenClawConfig | null> {
  const baseUrl = (
    normalizeOptionalSecretInput(params.ctx.opts.customBaseUrl) ?? params.defaultBaseUrl
  ).replace(/\/+$/, "");
  const modelId = normalizeOptionalSecretInput(params.ctx.opts.customModelId);
  if (!modelId) {
    params.ctx.runtime.error(
      buildMissingNonInteractiveModelIdMessage({
        authChoice: params.ctx.authChoice,
        providerLabel: params.providerLabel,
        modelPlaceholder: params.modelPlaceholder,
      }),
    );
    params.ctx.runtime.exit(1);
    return null;
  }

  const resolved = await params.ctx.resolveApiKey({
    provider: params.providerId,
    flagValue: normalizeOptionalSecretInput(params.ctx.opts.customApiKey),
    flagName: "--custom-api-key",
    envVar: params.defaultApiKeyEnvVar,
    envVarName: params.defaultApiKeyEnvVar,
  });
  if (!resolved) {
    return null;
  }

  const credential = buildSelfHostedProviderCredential({
    ctx: params.ctx,
    providerId: params.providerId,
    resolved,
  });
  if (!credential) {
    return null;
  }

  const configured = buildOpenAICompatibleSelfHostedProviderConfig({
    cfg: params.ctx.config,
    providerId: params.providerId,
    baseUrl,
    providerApiKey: params.defaultApiKeyEnvVar,
    modelId,
    input: params.input,
    reasoning: params.reasoning,
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
  });
  await upsertAuthProfileWithLock({
    profileId: configured.profileId,
    credential,
    agentDir: params.ctx.agentDir,
  });

  const withProfile = applyAuthProfileConfig(configured.config, {
    profileId: configured.profileId,
    provider: params.providerId,
    mode: "api_key",
  });
  params.ctx.runtime.log(`Default ${params.providerLabel} model: ${modelId}`);
  return applyProviderDefaultModel(withProfile, configured.modelRef);
}
