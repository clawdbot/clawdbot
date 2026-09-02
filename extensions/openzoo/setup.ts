// Openzoo setup module handles plugin onboarding behavior.
import type { ProviderAppGuidedSetupContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeOptionalSecretInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { withAgentModelAliases } from "openclaw/plugin-sdk/provider-onboard";
import {
  applyProviderDefaultModel,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveOpenzooProviderAuthMode } from "./provider-auth.js";
import { buildOpenzooProvider } from "./provider-catalog.js";
import {
  discoverOpenzooModels,
  normalizeOpenzooBaseUrl,
  OPENZOO_DEFAULT_MODEL_ID,
  OPENZOO_DEFAULT_MODEL_REF,
  OPENZOO_LOCAL_API_KEY_PLACEHOLDER,
  OPENZOO_PROVIDER_ID,
  OPENZOO_PROVIDER_LABEL,
  resolveOpenzooBaseUrl,
  resolveOpenzooInfoUrl,
} from "./provider-models.js";

const PROVIDER_ID = OPENZOO_PROVIDER_ID;
const INFO_PROBE_TIMEOUT_MS = 2000;
const OPENZOO_PROXY_IDENTITY = "openzoo proxy";

export type OpenzooInfoProbe =
  | { reachable: true; info: Record<string, unknown> }
  | { reachable: false; status?: number; error?: unknown };

export type OpenzooAppGuidedCandidate = {
  modelRef: string;
  detail?: string;
};

export function isOpenzooProxyInfo(info: Record<string, unknown>): boolean {
  return normalizeOptionalLowercaseString(info.youAreTalkingTo) === OPENZOO_PROXY_IDENTITY;
}

/** Read-only reachability probe; `/v1/info` is served by the proxy itself and never touches upstream. */
export async function fetchOpenzooInfo(params: {
  baseUrl: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<OpenzooInfoProbe> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: resolveOpenzooInfoUrl(params.baseUrl),
      init: { headers: { Accept: "application/json" } },
      timeoutMs: params.timeoutMs ?? INFO_PROBE_TIMEOUT_MS,
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
      auditContext: "openzoo.info_probe",
    });
    try {
      if (!response.ok) {
        return { reachable: false, status: response.status };
      }
      const info = await readProviderJsonObjectResponse(response, "openzoo info");
      return isOpenzooProxyInfo(info)
        ? { reachable: true, info }
        : { reachable: false, status: response.status };
    } finally {
      // A capture tee must not delay the guard's bounded dispatcher release.
      if (!response.bodyUsed) {
        void response.body?.cancel().catch(() => undefined);
      }
      await release();
    }
  } catch (error) {
    return { reachable: false, error };
  }
}

export function buildOpenzooUnreachableNote(baseUrl: string): string[] {
  return [
    `${OPENZOO_PROVIDER_LABEL} proxy could not be reached at ${baseUrl}.`,
    "Start it in another terminal with `npx openzoo` (it prints a funding address; fund it with USDC on Solana or Base), then retry.",
  ];
}

function readConfiguredOpenzooProvider(config: OpenClawConfig): ModelProviderConfig | undefined {
  return config.models?.providers?.[PROVIDER_ID];
}

/** Explicit rows stay authoritative; live rows fill in the rest of the catalog. */
export function mergeOpenzooModels(
  explicit: readonly ModelDefinitionConfig[] | undefined,
  discovered: readonly ModelDefinitionConfig[],
): ModelDefinitionConfig[] {
  const explicitRows = explicit ?? [];
  const explicitIds = new Set(explicitRows.map((model) => model.id));
  return [...explicitRows, ...discovered.filter((model) => !explicitIds.has(model.id))];
}

export function selectOpenzooDefaultModelRef(
  models: readonly ModelDefinitionConfig[],
  requestedModelId?: string,
): string | undefined {
  if (requestedModelId) {
    return models.some((model) => model.id === requestedModelId)
      ? `${PROVIDER_ID}/${requestedModelId}`
      : undefined;
  }
  if (models.some((model) => model.id === OPENZOO_DEFAULT_MODEL_ID)) {
    return OPENZOO_DEFAULT_MODEL_REF;
  }
  const first = models[0];
  return first ? `${PROVIDER_ID}/${first.id}` : undefined;
}

function buildOpenzooSetupProviderConfig(params: {
  existingProvider: ModelProviderConfig | undefined;
  baseUrl: string;
  models: ModelDefinitionConfig[];
}): ModelProviderConfig {
  const existing = params.existingProvider;
  const existingWithoutAuth = existing
    ? (({ auth: _auth, apiKey: _apiKey, ...rest }) => rest)(existing)
    : undefined;
  const existingAuth = resolveOpenzooProviderAuthMode(existing?.apiKey);
  return {
    ...existingWithoutAuth,
    baseUrl: params.baseUrl,
    api: existing?.api ?? "openai-completions",
    // A real operator credential survives; otherwise persist the non-secret local marker.
    ...(existingAuth && existing?.apiKey !== undefined
      ? { auth: existingAuth, apiKey: existing.apiKey }
      : { apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER }),
    models: params.models,
  };
}

function buildOpenzooSetupState(params: { config: OpenClawConfig; baseUrl: string }) {
  return {
    modelsMode: params.config.models?.mode ?? "merge",
    agentModels: withAgentModelAliases(params.config.agents?.defaults?.models, [
      { modelRef: OPENZOO_DEFAULT_MODEL_REF, alias: OPENZOO_PROVIDER_LABEL },
    ]),
    // Only the static seed is persisted; refreshable discovery publishes the live catalog.
    providerConfig: buildOpenzooSetupProviderConfig({
      existingProvider: readConfiguredOpenzooProvider(params.config),
      baseUrl: params.baseUrl,
      models: buildOpenzooProvider().models ?? [],
    }),
  };
}

function buildOpenzooAuthResult(params: {
  config: OpenClawConfig;
  baseUrl: string;
  defaultModel: string;
}): ProviderAuthResult {
  const state = buildOpenzooSetupState(params);
  return {
    profiles: [],
    defaultModel: params.defaultModel,
    configPatch: {
      agents: { defaults: { models: state.agentModels } },
      models: {
        mode: state.modelsMode,
        providers: { [PROVIDER_ID]: state.providerConfig },
      },
    },
  };
}

/** Interactive setup: confirm the proxy answers, then seed config with the static catalog. */
export async function promptAndConfigureOpenzooInteractive(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: WizardPrompter;
  signal?: AbortSignal;
}): Promise<ProviderAuthResult> {
  const existingProvider = readConfiguredOpenzooProvider(params.config);
  const defaultBaseUrl = resolveOpenzooBaseUrl({
    env: params.env,
    configuredBaseUrl: existingProvider?.baseUrl,
  });
  const baseUrlRaw = await params.prompter.text({
    message: `${OPENZOO_PROVIDER_LABEL} proxy base URL`,
    initialValue: defaultBaseUrl,
    placeholder: defaultBaseUrl,
    validate: (value) => (normalizeOpenzooBaseUrl(value) ? undefined : "Enter an http(s) URL"),
  });
  const baseUrl = normalizeOpenzooBaseUrl(baseUrlRaw) ?? defaultBaseUrl;
  let probe = await fetchOpenzooInfo({ baseUrl, signal: params.signal });
  while (!probe.reachable) {
    params.signal?.throwIfAborted();
    await params.prompter.note(
      buildOpenzooUnreachableNote(baseUrl).join("\n"),
      OPENZOO_PROVIDER_LABEL,
    );
    const retry = await params.prompter.confirm({
      message: `Retry the ${OPENZOO_PROVIDER_LABEL} proxy connection now?`,
      initialValue: true,
    });
    if (!retry) {
      throw new WizardCancelledError(`${OPENZOO_PROVIDER_LABEL} proxy not reachable`);
    }
    probe = await fetchOpenzooInfo({ baseUrl, signal: params.signal });
  }
  const models = await discoverOpenzooModels({ baseUrl, signal: params.signal });
  const defaultModel = selectOpenzooDefaultModelRef(models) ?? OPENZOO_DEFAULT_MODEL_REF;
  return buildOpenzooAuthResult({ config: params.config, baseUrl, defaultModel });
}

async function validateNonInteractiveOpenzooDiscovery(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
): Promise<{ baseUrl: string; defaultModel: string } | null> {
  const existingProvider = readConfiguredOpenzooProvider(ctx.config);
  const customBaseUrl = normalizeOpenzooBaseUrl(
    normalizeOptionalSecretInput(ctx.opts.customBaseUrl),
  );
  const baseUrl =
    customBaseUrl ??
    resolveOpenzooBaseUrl({ env: process.env, configuredBaseUrl: existingProvider?.baseUrl });
  const requestedModelId = normalizeOptionalSecretInput(ctx.opts.customModelId);
  const probe = await fetchOpenzooInfo({ baseUrl });
  if (!probe.reachable) {
    ctx.runtime.error(buildOpenzooUnreachableNote(baseUrl).join("\n"));
    ctx.runtime.exit(1);
    return null;
  }
  const models = await discoverOpenzooModels({ baseUrl });
  const defaultModel = selectOpenzooDefaultModelRef(models, requestedModelId);
  if (!defaultModel) {
    ctx.runtime.error(
      [
        `${OPENZOO_PROVIDER_LABEL} model ${requestedModelId ?? "(none)"} was not found at ${baseUrl}.`,
        `Run openclaw models list --provider ${PROVIDER_ID} to see the discovered catalog.`,
      ].join("\n"),
    );
    ctx.runtime.exit(1);
    return null;
  }
  return { baseUrl, defaultModel };
}

/** Checks proxy reachability and the requested model without mutating config. */
export async function validateOpenzooNonInteractive(
  ctx: Omit<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential">,
): Promise<boolean> {
  return Boolean(await validateNonInteractiveOpenzooDiscovery(ctx));
}

/** Non-interactive setup path used by `openclaw onboard --auth-choice openzoo`. */
export async function configureOpenzooNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const validated = await validateNonInteractiveOpenzooDiscovery(ctx);
  if (!validated) {
    return null;
  }
  const state = buildOpenzooSetupState({ config: ctx.config, baseUrl: validated.baseUrl });
  return applyProviderDefaultModel(
    {
      ...ctx.config,
      agents: {
        ...ctx.config.agents,
        defaults: {
          ...ctx.config.agents?.defaults,
          models: state.agentModels,
        },
      },
      models: {
        ...ctx.config.models,
        mode: state.modelsMode,
        providers: {
          ...ctx.config.models?.providers,
          [PROVIDER_ID]: state.providerConfig,
        },
      },
    },
    validated.defaultModel,
  );
}

/** Live catalog: merges explicit config rows with the proxy's priced model list. */
export async function discoverOpenzooProvider(ctx: ProviderCatalogContext): Promise<{
  provider: ModelProviderConfig;
} | null> {
  const explicit = readConfiguredOpenzooProvider(ctx.config);
  const baseUrl = resolveOpenzooBaseUrl({ env: ctx.env, configuredBaseUrl: explicit?.baseUrl });
  const probe = await fetchOpenzooInfo({ baseUrl });
  if (!probe.reachable && !explicit) {
    // An unconfigured proxy that is not running is not a provider.
    return null;
  }
  const discovered = probe.reachable
    ? await discoverOpenzooModels({ baseUrl })
    : (buildOpenzooProvider().models ?? []);
  const models = mergeOpenzooModels(explicit?.models, discovered);
  const { apiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
  const resolvedApiKey = apiKey ?? explicit?.apiKey;
  const auth = resolveOpenzooProviderAuthMode(resolvedApiKey);
  const explicitWithoutAuth = explicit
    ? (({ auth: _auth, apiKey: _apiKey, models: _models, ...rest }) => rest)(explicit)
    : undefined;
  return {
    provider: {
      ...explicitWithoutAuth,
      baseUrl,
      api: explicit?.api ?? "openai-completions",
      ...(auth && resolvedApiKey !== undefined
        ? { auth, apiKey: resolvedApiKey }
        : { apiKey: OPENZOO_LOCAL_API_KEY_PLACEHOLDER }),
      models,
    },
  };
}

function resolveAppGuidedOpenzooBaseUrl(ctx: ProviderAppGuidedSetupContext): string {
  return resolveOpenzooBaseUrl({
    env: ctx.env,
    configuredBaseUrl: readConfiguredOpenzooProvider(ctx.config)?.baseUrl,
  });
}

/** Read-only reachability probe for app-guided setup. */
export async function detectAppGuidedOpenzooAvailability(
  ctx: ProviderAppGuidedSetupContext,
): Promise<boolean> {
  const probe = await fetchOpenzooInfo({
    baseUrl: resolveAppGuidedOpenzooBaseUrl(ctx),
    signal: ctx.signal,
  });
  return probe.reachable;
}

/** Offers the gateway's own router row when the proxy answers. */
export async function detectAppGuidedOpenzooModel(
  ctx: ProviderAppGuidedSetupContext,
): Promise<OpenzooAppGuidedCandidate | null> {
  const baseUrl = resolveAppGuidedOpenzooBaseUrl(ctx);
  const probe = await fetchOpenzooInfo({ baseUrl, signal: ctx.signal });
  if (!probe.reachable) {
    return null;
  }
  return {
    modelRef: OPENZOO_DEFAULT_MODEL_REF,
    detail: `${OPENZOO_DEFAULT_MODEL_ID} at ${baseUrl}`,
  };
}

/** Rechecks one detected model and returns the config required for a live probe. */
export async function prepareAppGuidedOpenzooSetup(
  ctx: ProviderAppGuidedSetupContext & { modelRef?: string },
): Promise<ProviderAuthResult | null> {
  const baseUrl = resolveAppGuidedOpenzooBaseUrl(ctx);
  const requestedPrefix = `${PROVIDER_ID}/`;
  const requestedModelId = ctx.modelRef?.startsWith(requestedPrefix)
    ? ctx.modelRef.slice(requestedPrefix.length)
    : undefined;
  if (ctx.modelRef && !requestedModelId) {
    return null;
  }
  const probe = await fetchOpenzooInfo({ baseUrl, signal: ctx.signal });
  if (!probe.reachable) {
    return null;
  }
  const models = await discoverOpenzooModels({ baseUrl, signal: ctx.signal });
  const defaultModel = selectOpenzooDefaultModelRef(models, requestedModelId);
  if (!defaultModel) {
    return null;
  }
  return buildOpenzooAuthResult({ config: ctx.config, baseUrl, defaultModel });
}
