import type {
  ProviderAppGuidedSetupContext,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromEnvOrPrompt,
  normalizeOptionalSecretInput,
  upsertAuthProfileWithLock,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  removeAuthProfileConfig,
  removeProviderAuthProfilesWithLock,
} from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  type ModelProviderConfig,
  selectPreferredLocalModelId,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyProviderDefaultModel } from "openclaw/plugin-sdk/provider-setup";
import {
  buildLlamaCppAuthProfileRemovalPatch,
  LLAMA_CPP_DEFAULT_PROFILE_ID as PROFILE_ID,
} from "../auth-config.js";
import { LLAMA_CPP_PROVIDER_ID, LLAMA_CPP_PROVIDER_LABEL } from "../defaults.js";
import {
  hasLlamaServerAuthorizationHeader,
  resolveLlamaServerProviderHeaders,
  resolveLlamaServerRuntimeApiKey,
} from "./auth.js";
import { LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR, LLAMA_SERVER_DEFAULT_ORIGIN } from "./defaults.js";
import { discoverLlamaServer, type LlamaServerDiscoveryResult } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig } from "./models.js";

function selectSetupModelId(discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>) {
  const healthy = discovery.models.filter((model) => !model.failed);
  const candidates = healthy.length > 0 ? healthy : discovery.models;
  const ordered = candidates.toSorted((left, right) => {
    const leftLoaded = left.status === "loaded" || left.status === "sleeping";
    const rightLoaded = right.status === "loaded" || right.status === "sleeping";
    return Number(rightLoaded) - Number(leftLoaded);
  });
  const ids = ordered.map((model) => model.config.id);
  return selectPreferredLocalModelId(ids) ?? ids[0];
}

function describeDiscoveryFailure(
  result: Exclude<LlamaServerDiscoveryResult, { kind: "success" }>,
): string {
  switch (result.kind) {
    case "unreachable":
      return `llama-server could not be reached at ${result.endpoint.origin}.`;
    case "http-error":
      return `llama-server returned HTTP ${result.status} for ${result.path} at ${result.endpoint.origin}.`;
    case "invalid-response":
      return `llama-server returned an invalid response from ${result.path} at ${result.endpoint.origin}.`;
    default:
      throw new Error("Unexpected llama-server discovery result");
  }
}

function stripAuthOverrides(
  provider: ModelProviderConfig | undefined,
  removeAuthorization: boolean,
): ModelProviderConfig | undefined {
  if (!provider) {
    return provider;
  }
  const headers = removeAuthorization
    ? stripAuthorizationHeader(provider.headers)
    : provider.headers;
  return {
    ...provider,
    auth: undefined,
    apiKey: undefined,
    ...(removeAuthorization ? { headers } : {}),
  };
}

function stripEndpointCredentials(
  provider: ModelProviderConfig | undefined,
): ModelProviderConfig | undefined {
  if (!provider) {
    return undefined;
  }
  const { localService: _localService, ...external } = provider;
  if (!provider.localService) {
    return { ...external, auth: undefined, apiKey: undefined, headers: undefined };
  }
  const {
    auth: _auth,
    apiKey: _apiKey,
    headers: _headers,
    localService: _managedService,
    models: _managedModels,
    params: managedParams,
    timeoutSeconds: _managedTimeout,
    ...externalProvider
  } = provider;
  const { modelCacheDir: _modelCacheDir, ...params } = managedParams ?? {};
  return {
    ...externalProvider,
    models: [],
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

function hasEndpointChanged(provider: ModelProviderConfig | undefined, baseUrl: string): boolean {
  if (!provider) {
    return false;
  }
  const configuredBaseUrl = provider.baseUrl ?? LLAMA_SERVER_DEFAULT_ORIGIN;
  return (
    resolveLlamaServerEndpoint(configuredBaseUrl).inferenceBaseUrl !==
    resolveLlamaServerEndpoint(baseUrl).inferenceBaseUrl
  );
}

function stripLlamaServerEndpointAuth(config: OpenClawConfig): OpenClawConfig {
  const withoutProfile = removeAuthProfileConfig(config, PROFILE_ID);
  const provider = withoutProfile.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const endpointSafeProvider = stripEndpointCredentials(provider);
  if (!endpointSafeProvider) {
    return withoutProfile;
  }
  return {
    ...withoutProfile,
    models: {
      ...withoutProfile.models,
      providers: {
        ...withoutProfile.models?.providers,
        [LLAMA_CPP_PROVIDER_ID]: endpointSafeProvider,
      },
    },
  };
}

type AuthPersistence<T> =
  | { kind: "preserve" }
  | { kind: "upsert"; credential: T }
  | { kind: "remove" };

function stripAuthorizationHeader<T>(
  headers: Record<string, T> | undefined,
): Record<string, T> | undefined {
  const filtered = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"),
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function buildExistingProviderConfig(params: {
  config: OpenClawConfig;
  discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
  resetEndpoint: boolean;
  persistence: AuthPersistence<unknown>;
}): ModelProviderConfig {
  const configured = params.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const endpointSafe = params.resetEndpoint ? stripEndpointCredentials(configured) : configured;
  const existing =
    params.persistence.kind === "preserve"
      ? endpointSafe
      : stripAuthOverrides(endpointSafe, params.persistence.kind === "upsert");
  return buildLlamaServerProviderConfig({
    configured: {
      ...existing,
      baseUrl: params.discovery.endpoint.inferenceBaseUrl,
      models: existing?.models ?? [],
    },
    discoveredModels: params.discovery.models,
  });
}

function buildSetupResult(params: {
  config: OpenClawConfig;
  discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
  modelId: string;
  resetEndpoint: boolean;
  persistence: AuthPersistence<SecretInput>;
}): ProviderAuthResult {
  return {
    profiles:
      params.persistence.kind === "upsert"
        ? [
            {
              profileId: PROFILE_ID,
              credential: buildApiKeyCredential(
                LLAMA_CPP_PROVIDER_ID,
                params.persistence.credential,
                undefined,
                { config: params.config },
              ),
            },
          ]
        : [],
    defaultModel: `${LLAMA_CPP_PROVIDER_ID}/${params.modelId}`,
    configPatch: {
      ...(params.persistence.kind === "remove"
        ? buildLlamaCppAuthProfileRemovalPatch(params.config)
        : {}),
      models: {
        mode: params.config.models?.mode ?? "merge",
        providers: {
          [LLAMA_CPP_PROVIDER_ID]: buildExistingProviderConfig(params),
        },
      },
    },
  };
}

async function removeDefaultAuthProfile(agentDir?: string): Promise<void> {
  const updated = await removeProviderAuthProfilesWithLock({
    agentDir,
    provider: LLAMA_CPP_PROVIDER_ID,
    profileIds: [PROFILE_ID],
  });
  if (!updated) {
    throw new Error(
      "Failed to remove the previous llama-server auth profile; wait a moment and retry.",
    );
  }
}

async function discoverForSetup(params: {
  config: OpenClawConfig;
  baseUrl: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<LlamaServerDiscoveryResult> {
  const providerConfig = params.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const headers = await resolveLlamaServerProviderHeaders({
    config: params.config,
    env: params.env,
    headers: providerConfig?.headers,
  });
  const resolvedApiKey = !hasLlamaServerAuthorizationHeader(headers)
    ? await resolveLlamaServerRuntimeApiKey({ config: params.config })
    : undefined;
  return await discoverLlamaServer({
    baseUrl: params.baseUrl,
    apiKey: resolvedApiKey,
    headers,
    signal: params.signal,
    cacheTtlMs: 0,
  });
}

async function discoverWithAccess(params: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<LlamaServerDiscoveryResult> {
  return await discoverLlamaServer({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    signal: params.signal,
    cacheTtlMs: 0,
  });
}

/** Read-only discovery for the guided local-provider setup ladder. */
export async function detectLlamaServerSetup(
  ctx: ProviderAppGuidedSetupContext,
): Promise<{ modelRef: string; detail?: string } | null> {
  const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (provider?.localService) {
    return null;
  }
  const baseUrl = provider?.baseUrl ?? LLAMA_SERVER_DEFAULT_ORIGIN;
  let discovery: LlamaServerDiscoveryResult;
  try {
    discovery = await discoverForSetup({
      config: ctx.config,
      baseUrl,
      env: ctx.env,
      signal: ctx.signal,
    });
  } catch {
    return null;
  }
  if (discovery.kind !== "success") {
    return null;
  }
  const modelId = selectSetupModelId(discovery);
  if (!modelId) {
    return null;
  }
  return {
    modelRef: `${LLAMA_CPP_PROVIDER_ID}/${modelId}`,
    detail: `${modelId} at ${discovery.endpoint.origin}`,
  };
}

/** Rechecks one guided candidate and returns the config needed for a live probe. */
export async function prepareLlamaServerSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const provider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (provider?.localService) {
    return null;
  }
  let discovery: LlamaServerDiscoveryResult;
  try {
    discovery = await discoverForSetup({
      config: ctx.config,
      baseUrl: provider?.baseUrl ?? LLAMA_SERVER_DEFAULT_ORIGIN,
      env: ctx.env,
      signal: ctx.signal,
    });
  } catch {
    return null;
  }
  if (discovery.kind !== "success") {
    return null;
  }
  const prefix = `${LLAMA_CPP_PROVIDER_ID}/`;
  const modelId = ctx.modelRef.startsWith(prefix) ? ctx.modelRef.slice(prefix.length) : "";
  if (!modelId || !discovery.models.some((model) => model.config.id === modelId)) {
    return null;
  }
  return buildSetupResult({
    config: ctx.config,
    discovery,
    modelId,
    resetEndpoint: false,
    persistence: { kind: "preserve" },
  });
}

/** Interactive setup for an existing llama-server endpoint. */
export async function runLlamaServerSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const defaultOrigin = resolveLlamaServerEndpoint(existing?.baseUrl).origin;
  const baseUrl = await ctx.prompter.text({
    message: `${LLAMA_CPP_PROVIDER_LABEL} URL`,
    initialValue: defaultOrigin,
    placeholder: LLAMA_SERVER_DEFAULT_ORIGIN,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const endpoint = resolveLlamaServerEndpoint(baseUrl);
  const endpointChanged =
    Boolean(existing?.localService) || hasEndpointChanged(existing, endpoint.inferenceBaseUrl);
  const resolvedHeaders = endpointChanged
    ? undefined
    : await resolveLlamaServerProviderHeaders({
        config: ctx.config,
        env: ctx.env,
        headers: existing?.headers,
      });
  const usesApiKey = await ctx.prompter.confirm({
    message: "Does this llama-server require an API key?",
    initialValue: false,
  });
  let apiKey: string | undefined;
  let headers = resolvedHeaders;
  let persistence: AuthPersistence<SecretInput>;
  if (!usesApiKey) {
    persistence = { kind: "remove" };
  } else {
    const hasConfiguredProfile = Boolean(ctx.config.auth?.profiles?.[PROFILE_ID]);
    const profileApiKey =
      !endpointChanged &&
      !hasLlamaServerAuthorizationHeader(resolvedHeaders) &&
      hasConfiguredProfile
        ? await resolveLlamaServerRuntimeApiKey({
            config: ctx.config,
            agentDir: ctx.agentDir,
            profileId: PROFILE_ID,
          })
        : undefined;
    if (profileApiKey) {
      apiKey = profileApiKey;
      persistence = { kind: "preserve" };
    } else {
      let credentialInput: SecretInput | undefined;
      apiKey = await ensureApiKeyFromEnvOrPrompt({
        config: endpointChanged ? stripLlamaServerEndpointAuth(ctx.config) : ctx.config,
        env: endpointChanged ? {} : ctx.env,
        provider: LLAMA_CPP_PROVIDER_ID,
        envLabel: LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
        promptMessage: "Enter the llama-server API key",
        normalize: (value) => value.trim(),
        validate: (value) => (value.trim() ? undefined : "Required"),
        prompter: ctx.prompter,
        secretInputMode: ctx.secretInputMode,
        setCredential: async (input) => {
          credentialInput = input;
        },
      });
      if (credentialInput === undefined) {
        throw new Error("llama-server API-key setup did not produce a credential");
      }
      headers = stripAuthorizationHeader(resolvedHeaders);
      persistence = { kind: "upsert", credential: credentialInput };
    }
  }

  const discovery = await discoverWithAccess({
    baseUrl: endpoint.inferenceBaseUrl,
    apiKey,
    headers,
    signal: ctx.signal,
  });
  if (discovery.kind !== "success") {
    throw new Error(describeDiscoveryFailure(discovery));
  }
  const modelId = selectSetupModelId(discovery);
  if (!modelId) {
    throw new Error(`No llama-server text models were found at ${discovery.endpoint.origin}.`);
  }
  if (persistence.kind === "remove") {
    await removeDefaultAuthProfile(ctx.agentDir);
  }
  return buildSetupResult({
    config: ctx.config,
    discovery,
    modelId,
    resetEndpoint: endpointChanged,
    persistence,
  });
}

async function validateNonInteractiveDiscovery(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
): Promise<{
  discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
  modelId: string;
  resetEndpoint: boolean;
  persistence: AuthPersistence<NonNullable<Awaited<ReturnType<typeof ctx.resolveApiKey>>>>;
} | null> {
  const configuredProvider = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const baseUrl =
    normalizeOptionalSecretInput(ctx.opts.customBaseUrl) ??
    configuredProvider?.baseUrl ??
    LLAMA_SERVER_DEFAULT_ORIGIN;
  const endpointChanged =
    Boolean(configuredProvider?.localService) || hasEndpointChanged(configuredProvider, baseUrl);
  const providerApiKey = normalizeOptionalSecretInput(ctx.opts.llamaServerApiKey);
  const customApiKey = normalizeOptionalSecretInput(ctx.opts.customApiKey);
  const authoredApiKey = providerApiKey ?? customApiKey;
  const hasAuthoredApiKey = authoredApiKey !== undefined;
  const resolvedApiKey = await ctx.resolveApiKey({
    provider: LLAMA_CPP_PROVIDER_ID,
    flagValue: authoredApiKey,
    flagName: providerApiKey === undefined ? "--custom-api-key" : "--llama-server-api-key",
    envVar: LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
    envVarName: LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
    required: false,
  });
  const resolvedHeaders = endpointChanged
    ? undefined
    : await resolveLlamaServerProviderHeaders({
        config: ctx.config,
        env: process.env,
        headers: configuredProvider?.headers,
      });
  let apiKey: string | undefined;
  let headers = resolvedHeaders;
  let persistence: AuthPersistence<NonNullable<typeof resolvedApiKey>>;
  if (hasAuthoredApiKey && resolvedApiKey) {
    apiKey = resolvedApiKey.key;
    headers = stripAuthorizationHeader(resolvedHeaders);
    persistence = { kind: "upsert", credential: resolvedApiKey };
  } else if (endpointChanged || hasLlamaServerAuthorizationHeader(resolvedHeaders)) {
    persistence = { kind: "remove" };
  } else if (resolvedApiKey?.source === "profile") {
    apiKey = resolvedApiKey.key;
    persistence = { kind: "preserve" };
  } else if (resolvedApiKey) {
    apiKey = resolvedApiKey.key;
    persistence = { kind: "upsert", credential: resolvedApiKey };
  } else {
    persistence = { kind: "remove" };
  }
  const discovery = await discoverWithAccess({ baseUrl, apiKey, headers });
  if (discovery.kind !== "success") {
    ctx.runtime.error(describeDiscoveryFailure(discovery));
    ctx.runtime.exit(1);
    return null;
  }
  const requestedModelId = normalizeOptionalSecretInput(ctx.opts.customModelId);
  const modelId = requestedModelId ?? selectSetupModelId(discovery);
  if (!modelId || !discovery.models.some((model) => model.config.id === modelId)) {
    const available = discovery.models.map((model) => model.config.id).join(", ");
    ctx.runtime.error(
      requestedModelId
        ? `llama-server model ${requestedModelId} was not found. Available models: ${available}`
        : `No llama-server text models were found at ${discovery.endpoint.origin}.`,
    );
    ctx.runtime.exit(1);
    return null;
  }
  return {
    discovery,
    modelId,
    resetEndpoint: endpointChanged,
    persistence,
  };
}

export async function validateLlamaServerNonInteractive(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
): Promise<boolean> {
  return Boolean(await validateNonInteractiveDiscovery(ctx));
}

/** Non-interactive setup with optional API-key persistence. */
export async function configureLlamaServerNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const validated = await validateNonInteractiveDiscovery(ctx);
  if (!validated) {
    return null;
  }
  const providerConfig = buildExistingProviderConfig({
    config: ctx.config,
    discovery: validated.discovery,
    resetEndpoint: validated.resetEndpoint,
    persistence: validated.persistence,
  });
  let config: OpenClawConfig = {
    ...ctx.config,
    models: {
      ...ctx.config.models,
      mode: ctx.config.models?.mode ?? "merge",
      providers: {
        ...ctx.config.models?.providers,
        [LLAMA_CPP_PROVIDER_ID]: providerConfig,
      },
    },
  };

  if (validated.persistence.kind === "upsert") {
    const credential = ctx.toApiKeyCredential({
      provider: LLAMA_CPP_PROVIDER_ID,
      resolved: validated.persistence.credential,
    });
    if (!credential) {
      return null;
    }
    await upsertAuthProfileWithLock({
      profileId: PROFILE_ID,
      credential,
      agentDir: ctx.agentDir,
    });
    config = applyAuthProfileConfig(config, {
      profileId: PROFILE_ID,
      provider: LLAMA_CPP_PROVIDER_ID,
      mode: "api_key",
    });
  } else if (validated.persistence.kind === "remove") {
    await removeDefaultAuthProfile(ctx.agentDir);
    config = removeAuthProfileConfig(config, PROFILE_ID);
  }

  ctx.runtime.log(`Default ${LLAMA_CPP_PROVIDER_LABEL} model: ${validated.modelId}`);
  return applyProviderDefaultModel(config, `${LLAMA_CPP_PROVIDER_ID}/${validated.modelId}`);
}
