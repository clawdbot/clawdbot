// Ollama setup module handles plugin onboarding behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  OpenClawConfig,
  SecretInput,
  SecretInputMode,
} from "openclaw/plugin-sdk/provider-auth";
import {
  ensureApiKeyFromOptionEnvOrPrompt,
  isNonSecretApiKeyMarker,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  upsertAuthProfileWithLock,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { applyAgentDefaultModelPrimary } from "openclaw/plugin-sdk/provider-onboard";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_CLOUD_DEFAULT_MODELS,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DOCKER_HOST_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from "./defaults.js";
import { readProviderBaseUrl } from "./provider-base-url.js";
import {
  buildOllamaBaseUrlSsrFPolicy,
  buildOllamaProvider,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  isOllamaCloudModel,
  resolveOllamaApiBase,
  type OllamaModelWithContext,
} from "./provider-models.js";
import {
  buildOllamaModelsConfig,
  discoverOllamaModelsForSetup,
  findAvailableOllamaModelName,
  inspectOllamaModelsForSetup,
  mergeUniqueModelNames,
  normalizeOllamaModelName,
} from "./setup-model-selection.js";
import { pullOllamaModel, pullOllamaModelNonInteractive } from "./setup-pull.js";

export { buildOllamaProvider };

const OLLAMA_SUGGESTED_MODELS_LOCAL = [OLLAMA_DEFAULT_MODEL];
const OLLAMA_SUGGESTED_MODELS_CLOUD = OLLAMA_CLOUD_DEFAULT_MODELS.map((model) => model.id);
const OLLAMA_SUGGESTED_MODELS_LOCAL_CLOUD = OLLAMA_CLOUD_DEFAULT_MODELS.map(
  (model) => `${model.id}:cloud`,
);
const OLLAMA_CLOUD_MAX_DISCOVERED_MODELS = 500;
const OLLAMA_RECOMMENDED_TOOLS_MODEL = "gemma4:e4b";
const OLLAMA_RECOMMENDED_TOOLS_MODEL_SIZE = "about 9.6 GB";

type OllamaCloudDefaultModel = (typeof OLLAMA_CLOUD_DEFAULT_MODELS)[number];

type OllamaSetupOptions = {
  customBaseUrl?: string;
  customModelId?: string;
};

type OllamaSetupResult = {
  config: OpenClawConfig;
  credential: SecretInput;
  credentialMode?: SecretInputMode;
};

function isTruthyEnvValue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function resolveOllamaSetupDefaultBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return isTruthyEnvValue(env.OPENCLAW_DOCKER_SETUP)
    ? OLLAMA_DOCKER_HOST_BASE_URL
    : OLLAMA_DEFAULT_BASE_URL;
}

type OllamaInteractiveMode = "cloud-local" | "cloud-only" | "local-only";
type HostBackedOllamaInteractiveMode = Exclude<OllamaInteractiveMode, "cloud-only">;

const HOST_BACKED_OLLAMA_MODE_CONFIG: Record<
  HostBackedOllamaInteractiveMode,
  { includeCloudModels: boolean; noteTitle: string }
> = {
  "cloud-local": {
    includeCloudModels: true,
    noteTitle: "Ollama Cloud + Local",
  },
  "local-only": {
    includeCloudModels: false,
    noteTitle: "Ollama",
  },
};

function buildOllamaUnreachableLines(baseUrl: string, retry: boolean): string[] {
  return [
    `Ollama could not be reached at ${baseUrl}.`,
    "Start or restart the Ollama server for this address.",
    "If Ollama is not installed on that machine, download it at https://ollama.com/download",
    ...(retry ? ["", "Continue when it is running. OpenClaw will retry this address."] : []),
  ];
}

function buildOllamaCloudSigninLines(signinUrl?: string): string[] {
  return [
    "Cloud models on this Ollama host need `ollama signin`.",
    signinUrl ?? "Run `ollama signin` on the configured Ollama host.",
    "",
    "Continuing with local models only for now.",
  ];
}

export async function checkOllamaCloudAuth(
  baseUrl: string,
): Promise<{ signedIn: boolean; signinUrl?: string }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/me`,
      init: {
        method: "POST",
      },
      // Guard-owned timeoutMs also bounds DNS/proxy preflight; init.signal does not.
      timeoutMs: 5000,
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: "ollama-setup.me",
    });
    try {
      if (response.status === 401) {
        const data = await readProviderJsonResponse<{ signin_url?: string }>(
          response,
          "ollama.cloud-auth",
        );
        return { signedIn: false, signinUrl: data.signin_url };
      }
      if (!response.ok) {
        return { signedIn: false };
      }
      return { signedIn: true };
    } finally {
      await release();
    }
  } catch {
    return { signedIn: false };
  }
}

async function promptForOllamaCloudCredential(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  opts?: Record<string, unknown>;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  allowSecretRefPrompt?: boolean;
}): Promise<{
  credential: SecretInput;
  credentialMode?: SecretInputMode;
  discoveryApiKey: string;
}> {
  const captured: { credential?: SecretInput; credentialMode?: SecretInputMode } = {};
  const optionToken = normalizeOptionalSecretInput(params.opts?.ollamaApiKey);
  const discoveryApiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token: optionToken ?? normalizeOptionalSecretInput(params.opts?.token),
    tokenProvider: optionToken
      ? "ollama"
      : normalizeOptionalSecretInput(params.opts?.tokenProvider),
    secretInputMode:
      params.allowSecretRefPrompt === false
        ? (params.secretInputMode ?? "plaintext")
        : params.secretInputMode,
    config: params.cfg,
    env: params.env,
    expectedProviders: ["ollama"],
    provider: "ollama",
    envLabel: "OLLAMA_API_KEY",
    promptMessage: "Ollama API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: params.prompter,
    setCredential: async (apiKey, mode) => {
      captured.credential = apiKey;
      captured.credentialMode = mode;
    },
  });
  if (!captured.credential) {
    throw new Error("Missing Ollama API key input.");
  }
  if (
    typeof captured.credential === "string" &&
    isNonSecretApiKeyMarker(captured.credential, { includeEnvVarName: false })
  ) {
    throw new Error("Cloud-only Ollama setup requires a real OLLAMA_API_KEY.");
  }
  return {
    credential: captured.credential,
    credentialMode: captured.credentialMode,
    discoveryApiKey,
  };
}

function applyOllamaProviderConfig(
  cfg: OpenClawConfig,
  baseUrl: string,
  modelNames: string[],
  discoveredModelsByName?: Map<string, OllamaModelWithContext>,
  apiKey: SecretInput = "OLLAMA_API_KEY",
  defaultModels: readonly OllamaCloudDefaultModel[] = [],
): OpenClawConfig {
  return {
    ...cfg,
    models: {
      ...cfg.models,
      mode: cfg.models?.mode ?? "merge",
      providers: {
        ...cfg.models?.providers,
        ollama: {
          baseUrl,
          api: "ollama",
          apiKey,
          models: buildOllamaModelsConfig(modelNames, discoveredModelsByName, defaultModels),
        },
      },
    },
  };
}

async function storeOllamaCredential(agentDir?: string): Promise<void> {
  await upsertAuthProfileWithLock({
    profileId: "ollama:default",
    credential: { type: "api_key", provider: "ollama", key: "ollama-local" },
    agentDir,
  });
}

async function promptForOllamaBaseUrl(
  prompter: WizardPrompter,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const defaultBaseUrl = resolveOllamaSetupDefaultBaseUrl(env);
  const baseUrlRaw = await prompter.text({
    message: "Ollama base URL",
    initialValue: defaultBaseUrl,
    placeholder: defaultBaseUrl,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  return resolveOllamaApiBase((baseUrlRaw ?? defaultBaseUrl).trim().replace(/\/+$/, ""));
}

async function resolveHostBackedSuggestedModelNames(params: {
  mode: HostBackedOllamaInteractiveMode;
  baseUrl: string;
  prompter: WizardPrompter;
}): Promise<string[]> {
  const modeConfig = HOST_BACKED_OLLAMA_MODE_CONFIG[params.mode];
  if (!modeConfig.includeCloudModels) {
    return OLLAMA_SUGGESTED_MODELS_LOCAL;
  }

  const auth = await checkOllamaCloudAuth(params.baseUrl);
  if (auth.signedIn) {
    return mergeUniqueModelNames(
      OLLAMA_SUGGESTED_MODELS_LOCAL,
      OLLAMA_SUGGESTED_MODELS_LOCAL_CLOUD,
    );
  }

  await params.prompter.note(
    buildOllamaCloudSigninLines(auth.signinUrl).join("\n"),
    modeConfig.noteTitle,
  );
  return OLLAMA_SUGGESTED_MODELS_LOCAL;
}

async function promptAndConfigureHostBackedOllama(params: {
  cfg: OpenClawConfig;
  mode: HostBackedOllamaInteractiveMode;
  prompter: WizardPrompter;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<OllamaSetupResult> {
  const baseUrl = await promptForOllamaBaseUrl(params.prompter, params.env);
  let discovery = await discoverOllamaModelsForSetup({
    baseUrl,
    inspectTools: true,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (!discovery.reachable) {
    await params.prompter.note(buildOllamaUnreachableLines(baseUrl, true).join("\n"), "Ollama");
    const shouldRetry = await params.prompter.confirm({
      message: "Retry this Ollama address now?",
      initialValue: true,
    });
    if (!shouldRetry) {
      throw new WizardCancelledError("Ollama setup cancelled");
    }
    params.signal?.throwIfAborted();
    discovery = await discoverOllamaModelsForSetup({
      baseUrl,
      inspectTools: true,
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  if (!discovery.reachable) {
    throw new WizardCancelledError(`Ollama is still not reachable at ${baseUrl}`);
  }

  const {
    models,
    inspectedModels,
    discoveredModelsByName,
    inspectionFailures,
    hasToolsCapableModel,
  } = discovery;

  if (inspectionFailures.length > 0) {
    await params.prompter.note(
      [
        "Some installed models could not be inspected and were skipped:",
        ...inspectionFailures.slice(0, 5).map((line) => `- ${line}`),
        ...(inspectionFailures.length > 5 ? [`…and ${inspectionFailures.length - 5} more`] : []),
      ].join("\n"),
      "Ollama",
    );
  }
  let discoveredModelNames = models.map((model) => model.name);
  // A pull offer is only meaningful when inspection actually worked: if every
  // scan failed we cannot know what is installed, so recommending a multi-GB
  // download would be guesswork against a misbehaving server.
  const inspectionUsable =
    inspectedModels.length === 0 || inspectionFailures.length < inspectedModels.length;
  if (!hasToolsCapableModel && inspectionUsable) {
    const shouldPullRecommended = await params.prompter.confirm({
      message: `No tools-capable Ollama model is installed. Pull ${OLLAMA_RECOMMENDED_TOOLS_MODEL} (${OLLAMA_RECOMMENDED_TOOLS_MODEL_SIZE})?`,
      initialValue: false,
    });
    if (shouldPullRecommended) {
      if (
        !(await pullOllamaModel(
          baseUrl,
          OLLAMA_RECOMMENDED_TOOLS_MODEL,
          params.prompter,
          params.signal,
        ))
      ) {
        throw new WizardCancelledError("Failed to download recommended Ollama model");
      }
      params.signal?.throwIfAborted();
      const recommendedScan = await inspectOllamaModelsForSetup(
        baseUrl,
        [{ name: OLLAMA_RECOMMENDED_TOOLS_MODEL }],
        params.signal,
      );
      // Unlike the pre-existing-model scan, a just-pulled model that cannot be
      // verified is a hard failure: configuring it unenriched would silently
      // drop the tools capability the pull was for.
      if (recommendedScan.inspectionFailures.length > 0) {
        throw new WizardCancelledError(
          `Failed to verify pulled Ollama model: ${recommendedScan.inspectionFailures[0]}`,
        );
      }
      const [recommendedModel] = recommendedScan.inspected;
      if (recommendedModel) {
        discoveredModelsByName.set(recommendedModel.name, recommendedModel);
      }
      discoveredModelNames = mergeUniqueModelNames(discoveredModelNames, [
        OLLAMA_RECOMMENDED_TOOLS_MODEL,
      ]);
    }
  }
  const suggestedModelNames = await resolveHostBackedSuggestedModelNames({
    mode: params.mode,
    baseUrl,
    prompter: params.prompter,
  });

  return {
    credential: "ollama-local",
    config: applyOllamaProviderConfig(
      params.cfg,
      baseUrl,
      mergeUniqueModelNames(suggestedModelNames, discoveredModelNames),
      discoveredModelsByName,
    ),
  };
}

export async function promptAndConfigureOllama(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  opts?: Record<string, unknown>;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  allowSecretRefPrompt?: boolean;
  signal?: AbortSignal;
}): Promise<OllamaSetupResult> {
  const mode = (await params.prompter.select({
    message: "Ollama mode",
    options: [
      {
        value: "cloud-local",
        label: "Cloud + Local",
        hint: "Route cloud and local models through your Ollama host",
      },
      { value: "cloud-only", label: "Cloud only", hint: "Hosted Ollama models via ollama.com" },
      { value: "local-only", label: "Local only", hint: "Local models only" },
    ],
  })) as OllamaInteractiveMode;
  if (mode === "cloud-only") {
    const { credential, credentialMode, discoveryApiKey } = await promptForOllamaCloudCredential({
      cfg: params.cfg,
      env: params.env,
      opts: params.opts,
      prompter: params.prompter,
      secretInputMode: params.secretInputMode,
      allowSecretRefPrompt: params.allowSecretRefPrompt,
    });
    const { models: rawDiscoveredModels } = await fetchOllamaModels(OLLAMA_CLOUD_BASE_URL, {
      apiKey: discoveryApiKey,
    });
    const discoveredModels = rawDiscoveredModels.slice(0, OLLAMA_CLOUD_MAX_DISCOVERED_MODELS);
    const discoveredModelNames = discoveredModels.map((model) => model.name);
    const modelNames =
      discoveredModelNames.length > 0
        ? mergeUniqueModelNames(OLLAMA_SUGGESTED_MODELS_CLOUD, discoveredModelNames)
        : OLLAMA_SUGGESTED_MODELS_CLOUD;
    return {
      credential,
      credentialMode,
      config: applyOllamaProviderConfig(
        params.cfg,
        OLLAMA_CLOUD_BASE_URL,
        modelNames,
        undefined,
        credential,
        OLLAMA_CLOUD_DEFAULT_MODELS,
      ),
    };
  }
  return await promptAndConfigureHostBackedOllama({
    cfg: params.cfg,
    mode,
    prompter: params.prompter,
    env: params.env,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

export async function configureOllamaNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OllamaSetupOptions;
  runtime: RuntimeEnv;
  agentDir?: string;
}): Promise<OpenClawConfig> {
  const baseUrl = resolveOllamaApiBase(
    (params.opts.customBaseUrl?.trim() || resolveOllamaSetupDefaultBaseUrl()).replace(/\/+$/, ""),
  );
  const { reachable, models, discoveredModelsByName } = await discoverOllamaModelsForSetup({
    baseUrl,
  });
  const explicitModel = normalizeOllamaModelName(params.opts.customModelId);

  if (!reachable) {
    params.runtime.error(buildOllamaUnreachableLines(baseUrl, false).join("\n"));
    params.runtime.exit(1);
    return params.nextConfig;
  }

  const modelNames = models.map((model) => model.name);
  // Configured local models are advertised as available, so suggested models
  // belong in the inventory only when Ollama actually reports them as installed.
  const orderedModelNames = mergeUniqueModelNames(
    OLLAMA_SUGGESTED_MODELS_LOCAL.filter(
      (modelName) => findAvailableOllamaModelName(modelName, modelNames) !== undefined,
    ),
    modelNames,
  );

  const requestedDefaultModelId =
    explicitModel ??
    expectDefined(OLLAMA_SUGGESTED_MODELS_LOCAL[0], "default suggested Ollama model");
  const availableModelNames = new Set(modelNames);
  const availableDefaultModelId = findAvailableOllamaModelName(
    requestedDefaultModelId,
    availableModelNames,
  );
  const requestedCloudModel = isOllamaCloudModel(requestedDefaultModelId);
  let pulledRequestedModel = false;

  if (requestedCloudModel) {
    availableModelNames.add(requestedDefaultModelId);
  } else if (!availableDefaultModelId) {
    pulledRequestedModel = await pullOllamaModelNonInteractive(
      baseUrl,
      requestedDefaultModelId,
      params.runtime,
    );
    if (pulledRequestedModel) {
      availableModelNames.add(requestedDefaultModelId);
    }
  }

  let allModelNames = orderedModelNames;
  let defaultModelId = availableDefaultModelId ?? requestedDefaultModelId;
  if (
    (pulledRequestedModel || requestedCloudModel) &&
    !allModelNames.includes(requestedDefaultModelId)
  ) {
    allModelNames = [...allModelNames, requestedDefaultModelId];
  }

  if (!findAvailableOllamaModelName(defaultModelId, availableModelNames)) {
    if (availableModelNames.size === 0) {
      params.runtime.error(
        [
          `No Ollama models are available at ${baseUrl}.`,
          "Pull a model first, then re-run setup.",
        ].join("\n"),
      );
      params.runtime.exit(1);
      return params.nextConfig;
    }

    defaultModelId =
      allModelNames.find((name) => findAvailableOllamaModelName(name, availableModelNames)) ??
      expectDefined(availableModelNames.values().next().value, "available Ollama setup model");
    params.runtime.log(
      `Ollama model ${requestedDefaultModelId} was not available; using ${defaultModelId} instead.`,
    );
  }

  if (!requestedCloudModel && !discoveredModelsByName.has(defaultModelId)) {
    // Explicit and newly pulled models can fall outside the bounded catalog scan.
    const selectedModel = expectDefined(
      (
        await enrichOllamaModelsWithContext(baseUrl, [
          models.find((model) => model.name === defaultModelId) ?? { name: defaultModelId },
        ])
      )[0],
      "selected Ollama setup model",
    );
    discoveredModelsByName.set(defaultModelId, selectedModel);
  }

  // Failed setup must not leave a durable local profile behind.
  await storeOllamaCredential(params.agentDir);

  const config = applyOllamaProviderConfig(
    params.nextConfig,
    baseUrl,
    allModelNames,
    discoveredModelsByName,
  );
  params.runtime.log(`Default Ollama model: ${defaultModelId}`);
  return applyAgentDefaultModelPrimary(config, `ollama/${defaultModelId}`);
}

export async function ensureOllamaModelPulled(params: {
  config: OpenClawConfig;
  model: string;
  prompter: WizardPrompter;
}): Promise<void> {
  if (!params.model.startsWith("ollama/")) {
    return;
  }
  const baseUrl =
    readProviderBaseUrl(params.config.models?.providers?.ollama) ?? OLLAMA_DEFAULT_BASE_URL;
  const modelName = params.model.slice("ollama/".length);
  if (isOllamaCloudModel(modelName)) {
    return;
  }
  const { models } = await fetchOllamaModels(baseUrl);
  if (
    findAvailableOllamaModelName(
      modelName,
      models.map((model) => model.name),
    )
  ) {
    return;
  }
  if (!(await pullOllamaModel(baseUrl, modelName, params.prompter))) {
    throw new WizardCancelledError("Failed to download selected Ollama model");
  }
}
