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
  removeProviderAuthProfilesWithLock,
  upsertAuthProfileWithLock,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  type ModelProviderConfig,
  selectPreferredLocalModelId,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyProviderDefaultModel } from "openclaw/plugin-sdk/provider-setup";
import {
  hasLlamaServerAuthorizationHeader,
  resolveLlamaServerProviderHeaders,
  resolveLlamaServerRuntimeApiKey,
} from "./auth.js";
import {
  LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
  LLAMA_SERVER_DEFAULT_ORIGIN,
  LLAMA_SERVER_PROVIDER_ID,
  LLAMA_SERVER_PROVIDER_LABEL,
} from "./defaults.js";
import { discoverLlamaServer, type LlamaServerDiscoveryResult } from "./discovery.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import { buildLlamaServerProviderConfig } from "./models.js";

const PROFILE_ID = `${LLAMA_SERVER_PROVIDER_ID}:default`;

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

function stripCredentialOverrides(
  provider: ModelProviderConfig | undefined,
): ModelProviderConfig | undefined {
  if (!provider) {
    return provider;
  }
  const headers = Object.fromEntries(
    Object.entries(provider.headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== "authorization",
    ),
  );
  return {
    ...provider,
    auth: undefined,
    apiKey: undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

function stripApiKeyOverrides(
  provider: ModelProviderConfig | undefined,
): ModelProviderConfig | undefined {
  return provider
    ? {
        ...provider,
        auth: undefined,
        apiKey: undefined,
      }
    : undefined;
}

function stripEndpointCredentials(
  provider: ModelProviderConfig | undefined,
): ModelProviderConfig | undefined {
  return provider
    ? {
        ...provider,
        apiKey: undefined,
        headers: undefined,
      }
    : undefined;
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

function removeLlamaServerAuthProfileConfig(config: OpenClawConfig): OpenClawConfig {
  const profiles = Object.fromEntries(
    Object.entries(config.auth?.profiles ?? {}).filter(([id]) => id !== PROFILE_ID),
  );
  const order = Object.entries(config.auth?.order ?? {}).reduce<Record<string, string[]>>(
    (nextOrder, [providerId, providerOrder]) => {
      const next = providerOrder.filter((id) => id !== PROFILE_ID);
      if (next.length > 0 || next.length === providerOrder.length) {
        nextOrder[providerId] = next;
      }
      return nextOrder;
    },
    {},
  );
  return {
    ...config,
    auth: {
      ...config.auth,
      profiles,
      order: Object.keys(order).length > 0 ? order : undefined,
    },
  };
}

function stripLlamaServerEndpointAuth(config: OpenClawConfig): OpenClawConfig {
  const withoutProfile = removeLlamaServerAuthProfileConfig(config);
  const provider = withoutProfile.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
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
        [LLAMA_SERVER_PROVIDER_ID]: endpointSafeProvider,
      },
    },
  };
}

function buildAuthProfileRemovalPatch(config: OpenClawConfig): Partial<OpenClawConfig> {
  const profiles = config.auth?.profiles;
  const order = config.auth?.order;
  const profileExists = profiles ? Object.hasOwn(profiles, PROFILE_ID) : false;
  const referencedOrders = Object.entries(order ?? {}).filter(([, ids]) =>
    ids.includes(PROFILE_ID),
  );
  if (!profileExists && referencedOrders.length === 0) {
    return {};
  }
  const profilePatch = profileExists ? { [PROFILE_ID]: undefined } : undefined;
  const orderPatch = Object.fromEntries(
    referencedOrders.map(([providerId, ids]) => {
      const next = ids.filter((id) => id !== PROFILE_ID);
      return [providerId, next.length > 0 ? next : undefined];
    }),
  );
  const authPatch: NonNullable<OpenClawConfig["auth"]> = {};
  // Config patches use undefined map values as deletion markers.
  if (profilePatch) {
    Reflect.set(authPatch, "profiles", profilePatch);
  }
  if (referencedOrders.length > 0) {
    Reflect.set(authPatch, "order", orderPatch);
  }
  return { auth: authPatch };
}

function buildSetupResult(params: {
  config: OpenClawConfig;
  discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
  modelId: string;
  credentialInput?: SecretInput;
  useApiKey?: boolean;
  clearApiKeyOverrides?: boolean;
  clearStoredProfile?: boolean;
  clearEndpointCredentials?: boolean;
}): ProviderAuthResult {
  const configuredProvider = params.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
  const endpointSafeProvider = params.clearEndpointCredentials
    ? stripEndpointCredentials(configuredProvider)
    : configuredProvider;
  const existingProvider = params.useApiKey
    ? stripCredentialOverrides(endpointSafeProvider)
    : params.clearApiKeyOverrides
      ? stripApiKeyOverrides(endpointSafeProvider)
      : endpointSafeProvider;
  return {
    profiles: params.credentialInput
      ? [
          {
            profileId: PROFILE_ID,
            credential: buildApiKeyCredential(
              LLAMA_SERVER_PROVIDER_ID,
              params.credentialInput,
              undefined,
              { config: params.config },
            ),
          },
        ]
      : [],
    defaultModel: `${LLAMA_SERVER_PROVIDER_ID}/${params.modelId}`,
    configPatch: {
      ...(params.clearStoredProfile ? buildAuthProfileRemovalPatch(params.config) : {}),
      models: {
        mode: params.config.models?.mode ?? "merge",
        providers: {
          [LLAMA_SERVER_PROVIDER_ID]: buildLlamaServerProviderConfig({
            configured: {
              ...existingProvider,
              baseUrl: params.discovery.endpoint.inferenceBaseUrl,
              models: existingProvider?.models ?? [],
            },
            discoveredModels: params.discovery.models,
          }),
        },
      },
    },
  };
}

async function removeDefaultAuthProfile(agentDir?: string): Promise<void> {
  const updated = await removeProviderAuthProfilesWithLock({
    agentDir,
    provider: LLAMA_SERVER_PROVIDER_ID,
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
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  signal?: AbortSignal;
  reuseStoredAuth?: boolean;
}): Promise<LlamaServerDiscoveryResult> {
  const reuseStoredAuth = params.reuseStoredAuth !== false;
  const providerConfig = params.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
  const headers = reuseStoredAuth
    ? await resolveLlamaServerProviderHeaders({
        config: params.config,
        env: params.env,
        headers: providerConfig?.headers,
      })
    : undefined;
  const resolvedApiKey =
    params.apiKey ??
    (reuseStoredAuth && !hasLlamaServerAuthorizationHeader(headers)
      ? await resolveLlamaServerRuntimeApiKey({
          config: params.config,
          agentDir: params.agentDir,
        })
      : undefined);
  return await discoverLlamaServer({
    baseUrl: params.baseUrl,
    apiKey: resolvedApiKey,
    headers,
    signal: params.signal,
    cacheTtlMs: 0,
  });
}

/** Read-only discovery for the guided local-provider setup ladder. */
export async function detectLlamaServerSetup(
  ctx: ProviderAppGuidedSetupContext,
): Promise<{ modelRef: string; detail?: string } | null> {
  const provider = ctx.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
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
    modelRef: `${LLAMA_SERVER_PROVIDER_ID}/${modelId}`,
    detail: `${modelId} at ${discovery.endpoint.origin}`,
  };
}

/** Rechecks one guided candidate and returns the config needed for a live probe. */
export async function prepareLlamaServerSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef: string },
): Promise<ProviderAuthResult | null> {
  const provider = ctx.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
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
  const prefix = `${LLAMA_SERVER_PROVIDER_ID}/`;
  const modelId = ctx.modelRef.startsWith(prefix) ? ctx.modelRef.slice(prefix.length) : "";
  if (!modelId || !discovery.models.some((model) => model.config.id === modelId)) {
    return null;
  }
  return buildSetupResult({ config: ctx.config, discovery, modelId });
}

/** Interactive setup for an existing llama-server endpoint. */
export async function runLlamaServerSetup(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const existing = ctx.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
  const defaultOrigin = resolveLlamaServerEndpoint(existing?.baseUrl).origin;
  const baseUrl = await ctx.prompter.text({
    message: `${LLAMA_SERVER_PROVIDER_LABEL} URL`,
    initialValue: defaultOrigin,
    placeholder: LLAMA_SERVER_DEFAULT_ORIGIN,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const endpoint = resolveLlamaServerEndpoint(baseUrl);
  const endpointChanged = hasEndpointChanged(existing, endpoint.inferenceBaseUrl);

  const hasExplicitAuthorization =
    !endpointChanged && hasLlamaServerAuthorizationHeader(existing?.headers);
  let credentialInput: SecretInput | undefined;
  let apiKey =
    endpointChanged || hasExplicitAuthorization
      ? undefined
      : ctx.env?.[LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR]?.trim();
  const usesApiKey =
    Boolean(apiKey) ||
    (await ctx.prompter.confirm({
      message: "Does this llama-server require an API key?",
      initialValue: false,
    }));
  if (usesApiKey && !apiKey) {
    apiKey = await ensureApiKeyFromEnvOrPrompt({
      config: endpointChanged ? stripLlamaServerEndpointAuth(ctx.config) : ctx.config,
      env: endpointChanged ? {} : ctx.env,
      provider: LLAMA_SERVER_PROVIDER_ID,
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
  }

  const discovery = await discoverForSetup({
    config: ctx.config,
    agentDir: ctx.agentDir,
    baseUrl: endpoint.inferenceBaseUrl,
    env: ctx.env,
    apiKey,
    signal: ctx.signal,
    reuseStoredAuth: !endpointChanged,
  });
  if (discovery.kind !== "success") {
    throw new Error(describeDiscoveryFailure(discovery));
  }
  const modelId = selectSetupModelId(discovery);
  if (!modelId) {
    throw new Error(`No llama-server text models were found at ${discovery.endpoint.origin}.`);
  }
  if (!credentialInput) {
    await removeDefaultAuthProfile(ctx.agentDir);
  }
  return buildSetupResult({
    config: ctx.config,
    discovery,
    modelId,
    credentialInput,
    useApiKey: Boolean(apiKey),
    clearApiKeyOverrides: !usesApiKey,
    clearStoredProfile: !credentialInput,
    clearEndpointCredentials: endpointChanged,
  });
}

async function validateNonInteractiveDiscovery(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
): Promise<{
  discovery: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
  modelId: string;
  resolvedApiKey: Awaited<ReturnType<typeof ctx.resolveApiKey>>;
  endpointChanged: boolean;
} | null> {
  const configuredProvider = ctx.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
  const baseUrl =
    normalizeOptionalSecretInput(ctx.opts.customBaseUrl) ??
    configuredProvider?.baseUrl ??
    LLAMA_SERVER_DEFAULT_ORIGIN;
  const endpointChanged = hasEndpointChanged(configuredProvider, baseUrl);
  const providerApiKey = normalizeOptionalSecretInput(ctx.opts.llamaServerApiKey);
  const customApiKey = normalizeOptionalSecretInput(ctx.opts.customApiKey);
  const resolvedApiKey = await ctx.resolveApiKey({
    provider: LLAMA_SERVER_PROVIDER_ID,
    flagValue: providerApiKey ?? customApiKey,
    flagName: providerApiKey === undefined ? "--custom-api-key" : "--llama-server-api-key",
    envVar: LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
    envVarName: LLAMA_SERVER_DEFAULT_API_KEY_ENV_VAR,
    required: false,
  });
  const headers = endpointChanged
    ? undefined
    : await resolveLlamaServerProviderHeaders({
        config: ctx.config,
        env: process.env,
        headers: configuredProvider?.headers,
      });
  const selectedApiKey = endpointChanged
    ? resolvedApiKey?.source === "flag"
      ? resolvedApiKey
      : null
    : hasLlamaServerAuthorizationHeader(headers) && resolvedApiKey?.source !== "flag"
      ? null
      : resolvedApiKey;
  const discovery = await discoverLlamaServer({
    baseUrl,
    apiKey: selectedApiKey?.key,
    headers,
    cacheTtlMs: 0,
  });
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
  return { discovery, modelId, resolvedApiKey: selectedApiKey, endpointChanged };
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
  const configuredProvider = ctx.config.models?.providers?.[LLAMA_SERVER_PROVIDER_ID];
  const endpointSafeProvider = validated.endpointChanged
    ? stripEndpointCredentials(configuredProvider)
    : configuredProvider;
  const existingProvider = validated.resolvedApiKey
    ? stripCredentialOverrides(endpointSafeProvider)
    : endpointSafeProvider;
  const providerConfig = buildLlamaServerProviderConfig({
    configured: {
      ...existingProvider,
      baseUrl: validated.discovery.endpoint.inferenceBaseUrl,
      models: existingProvider?.models ?? [],
    },
    discoveredModels: validated.discovery.models,
  });
  let config: OpenClawConfig = {
    ...ctx.config,
    models: {
      ...ctx.config.models,
      mode: ctx.config.models?.mode ?? "merge",
      providers: {
        ...ctx.config.models?.providers,
        [LLAMA_SERVER_PROVIDER_ID]: providerConfig,
      },
    },
  };

  if (validated.resolvedApiKey) {
    const credential = ctx.toApiKeyCredential({
      provider: LLAMA_SERVER_PROVIDER_ID,
      resolved: validated.resolvedApiKey,
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
      provider: LLAMA_SERVER_PROVIDER_ID,
      mode: "api_key",
    });
  } else {
    await removeDefaultAuthProfile(ctx.agentDir);
    config = removeLlamaServerAuthProfileConfig(config);
  }

  ctx.runtime.log(`Default ${LLAMA_SERVER_PROVIDER_LABEL} model: ${validated.modelId}`);
  return applyProviderDefaultModel(config, `${LLAMA_SERVER_PROVIDER_ID}/${validated.modelId}`);
}
