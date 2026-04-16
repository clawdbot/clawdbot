import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
import { applyAgentDefaultModelPrimary } from "openclaw/plugin-sdk/provider-onboard";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  OLLAMA_CLOUD_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
} from "./defaults.js";
import {
  buildOllamaBaseUrlSsrFPolicy,
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  resolveOllamaApiBase,
  type OllamaModelWithContext,
} from "./provider-models.js";

const OLLAMA_SUGGESTED_MODELS_LOCAL = [OLLAMA_DEFAULT_MODEL];
const OLLAMA_SUGGESTED_MODELS_CLOUD = ["kimi-k2.5:cloud", "minimax-m2.7:cloud", "glm-5.1:cloud"];
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;

type OllamaSetupOptions = {
  customBaseUrl?: string;
  customModelId?: string;
};

type OllamaSetupResult = {
  config: OpenClawConfig;
  credential: SecretInput;
  credentialMode?: SecretInputMode;
};

type ProviderConfig = {
  baseUrl: string;
  api: "ollama";
  models: ReturnType<typeof buildOllamaModelDefinition>[];
};

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

function buildOllamaUnreachableLines(baseUrl: string): string[] {
  return [
    `Ollama could not be reached at ${baseUrl}.`,
    "Download it at https://ollama.com/download",
    "",
    "Start Ollama and re-run setup.",
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

function normalizeOllamaModelName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("ollama/")) {
    const normalized = trimmed.slice("ollama/".length).trim();
    return normalized || undefined;
  }
  return trimmed;
}

function isOllamaCloudModel(modelName: string | undefined): boolean {
  return normalizeOptionalLowercaseString(modelName)?.endsWith(":cloud") === true;
}

function formatOllamaPullStatus(status: string): { text: string; hidePercent: boolean } {
  const trimmed = status.trim();
  const partStatusMatch = trimmed.match(/^([a-z-]+)\s+(?:sha256:)?[a-f0-9]{8,}$/i);
  if (partStatusMatch) {
    return { text: `${partStatusMatch[1]} part`, hidePercent: false };
  }
  if (/^verifying\b.*\bdigest\b/i.test(trimmed)) {
    return { text: "verifying digest", hidePercent: true };
  }
  return { text: trimmed, hidePercent: false };
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
        signal: AbortSignal.timeout(5000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: "ollama-setup.me",
    });
    try {
      if (response.status === 401) {
        const data = (await response.json()) as { signin_url?: string };
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

type OllamaPullChunk = {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
};

type OllamaPullResult = { ok: true } | { ok: false; message: string };

async function pullOllamaModelCore(params: {
  baseUrl: string;
  modelName: string;
  onStatus?: (status: string, percent: number | null) => void;
}): Promise<OllamaPullResult> {
  const baseUrl = resolveOllamaApiBase(params.baseUrl);
  const modelName = normalizeOllamaModelName(params.modelName) ?? params.modelName.trim();
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/api/pull`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(baseUrl),
      auditContext: "ollama-setup.pull",
    });
    try {
      if (!response.ok) {
        return { ok: false, message: `Failed to download ${modelName} (HTTP ${response.status})` };
      }
      if (!response.body) {
        return { ok: false, message: `Failed to download ${modelName} (no response body)` };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const layers = new Map<string, { total: number; completed: number }>();

      const parseLine = (line: string): OllamaPullResult => {
        const trimmed = line.trim();
        if (!trimmed) {
          return { ok: true };
        }
        try {
          const chunk = JSON.parse(trimmed) as OllamaPullChunk;
          if (chunk.error) {
            return { ok: false, message: `Download failed: ${chunk.error}` };
          }
          if (!chunk.status) {
            return { ok: true };
          }
          if (chunk.total && chunk.completed !== undefined) {
            layers.set(chunk.status, { total: chunk.total, completed: chunk.completed });
            let totalSum = 0;
            let completedSum = 0;
            for (const layer of layers.values()) {
              totalSum += layer.total;
              completedSum += layer.completed;
            }
            params.onStatus?.(
              chunk.status,
              totalSum > 0 ? Math.round((completedSum / totalSum) * 100) : null,
            );
          } else {
            params.onStatus?.(chunk.status, null);
          }
        } catch {
          // Ignore malformed streaming lines from Ollama.
        }
        return { ok: true };
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseLine(line);
          if (!parsed.ok) {
            return parsed;
          }
        }
      }

      const trailing = buffer.trim();
      if (trailing) {
        const parsed = parseLine(trailing);
        if (!parsed.ok) {
          return parsed;
        }
      }

      return { ok: true };
    } finally {
      await release();
    }
  } catch (err) {
    const reason = formatErrorMessage(err);
    return { ok: false, message: `Failed to download ${modelName}: ${reason}` };
  }
}

async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  prompter: WizardPrompter,
): Promise<boolean> {
  const spinner = prompter.progress(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({
    baseUrl,
    modelName,
    onStatus: (status, percent) => {
      const displayStatus = formatOllamaPullStatus(status);
      if (displayStatus.hidePercent) {
        spinner.update(`Downloading ${modelName} - ${displayStatus.text}`);
      } else {
        spinner.update(`Downloading ${modelName} - ${displayStatus.text} - ${percent ?? 0}%`);
      }
    },
  });
  if (!result.ok) {
    spinner.stop(result.message);
    return false;
  }
  spinner.stop(`Downloaded ${modelName}`);
  return true;
}

async function pullOllamaModelNonInteractive(
  baseUrl: string,
  modelName: string,
  runtime: RuntimeEnv,
): Promise<boolean> {
  runtime.log(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({ baseUrl, modelName });
  if (!result.ok) {
    runtime.error(result.message);
    return false;
  }
  runtime.log(`Downloaded ${modelName}`);
  return true;
}

async function promptForOllamaCloudCredential(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  opts?: Record<string, unknown>;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  allowSecretRefPrompt?: boolean;
}): Promise<{ credential: SecretInput; credentialMode?: SecretInputMode }> {
  const captured: { credential?: SecretInput; credentialMode?: SecretInputMode } = {};
  const optionToken = normalizeOptionalSecretInput(params.opts?.ollamaApiKey);
  await ensureApiKeyFromOptionEnvOrPrompt({
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
  return { credential: captured.credential, credentialMode: captured.credentialMode };
}

function buildOllamaModelsConfig(
  modelNames: string[],
  discoveredModelsByName?: Map<string, OllamaModelWithContext>,
) {
  return modelNames.map((name) => {
    const discovered = discoveredModelsByName?.get(name);
    // Suggested cloud models may be injected before `/api/tags` exposes them,
    // so keep Kimi vision-capable during setup even without discovered metadata.
    const capabilities =
      discovered?.capabilities ?? (name === "kimi-k2.5:cloud" ? ["vision"] : undefined);
    return buildOllamaModelDefinition(name, discovered?.contextWindow, capabilities);
  });
}

function mergeUniqueModelNames(...groups: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const name of group) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      merged.push(name);
    }
  }
  return merged;
}

function applyOllamaProviderConfig(
  cfg: OpenClawConfig,
  baseUrl: string,
  modelNames: string[],
  discoveredModelsByName?: Map<string, OllamaModelWithContext>,
  apiKey: SecretInput = "OLLAMA_API_KEY",
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
          models: buildOllamaModelsConfig(modelNames, discoveredModelsByName),
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

async function promptForOllamaBaseUrl(prompter: WizardPrompter): Promise<string> {
  const baseUrlRaw = await prompter.text({
    message: "Ollama base URL",
    initialValue: OLLAMA_DEFAULT_BASE_URL,
    placeholder: OLLAMA_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  return resolveOllamaApiBase((baseUrlRaw ?? "").trim().replace(/\/+$/, ""));
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
    return mergeUniqueModelNames(OLLAMA_SUGGESTED_MODELS_LOCAL, OLLAMA_SUGGESTED_MODELS_CLOUD);
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
}): Promise<OllamaSetupResult> {
  const baseUrl = await promptForOllamaBaseUrl(params.prompter);
  const { reachable, models } = await fetchOllamaModels(baseUrl);

  if (!reachable) {
    await params.prompter.note(buildOllamaUnreachableLines(baseUrl).join("\n"), "Ollama");
    throw new WizardCancelledError("Ollama not reachable");
  }

  const enrichedModels = await enrichOllamaModelsWithContext(
    baseUrl,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
  );
  const discoveredModelsByName = new Map(enrichedModels.map((model) => [model.name, model]));
  const discoveredModelNames = models.map((model) => model.name);
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

export async function buildOllamaProvider(
  configuredBaseUrl?: string,
  opts?: { quiet?: boolean },
): Promise<ProviderConfig> {
  const apiBase = resolveOllamaApiBase(configuredBaseUrl);
  const { reachable, models } = await fetchOllamaModels(apiBase);
  if (!reachable && !opts?.quiet) {
    console.warn(`Ollama could not be reached at ${apiBase}.`);
  }
  const discovered = await enrichOllamaModelsWithContext(
    apiBase,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
  );
  return {
    baseUrl: apiBase,
    api: "ollama",
    models: discovered.map((model) =>
      buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities),
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
    const { credential, credentialMode } = await promptForOllamaCloudCredential({
      cfg: params.cfg,
      env: params.env,
      opts: params.opts,
      prompter: params.prompter,
      secretInputMode: params.secretInputMode,
      allowSecretRefPrompt: params.allowSecretRefPrompt,
    });
    return {
      credential,
      credentialMode,
      config: applyOllamaProviderConfig(
        params.cfg,
        OLLAMA_CLOUD_BASE_URL,
        OLLAMA_SUGGESTED_MODELS_CLOUD,
        undefined,
        credential,
      ),
    };
  }
  return await promptAndConfigureHostBackedOllama({
    cfg: params.cfg,
    mode,
    prompter: params.prompter,
  });
}

export async function configureOllamaNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OllamaSetupOptions;
  runtime: RuntimeEnv;
  agentDir?: string;
}): Promise<OpenClawConfig> {
  const baseUrl = resolveOllamaApiBase(
    (params.opts.customBaseUrl?.trim() || OLLAMA_DEFAULT_BASE_URL).replace(/\/+$/, ""),
  );
  const { reachable, models } = await fetchOllamaModels(baseUrl);
  const explicitModel = normalizeOllamaModelName(params.opts.customModelId);

  if (!reachable) {
    params.runtime.error(buildOllamaUnreachableLines(baseUrl).slice(0, 2).join("\n"));
    params.runtime.exit(1);
    return params.nextConfig;
  }

  await storeOllamaCredential(params.agentDir);

  const enrichedModels = await enrichOllamaModelsWithContext(
    baseUrl,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
  );
  const discoveredModelsByName = new Map(enrichedModels.map((model) => [model.name, model]));
  const modelNames = models.map((model) => model.name);
  const orderedModelNames = [
    ...OLLAMA_SUGGESTED_MODELS_LOCAL,
    ...modelNames.filter((name) => !OLLAMA_SUGGESTED_MODELS_LOCAL.includes(name)),
  ];

  const requestedDefaultModelId = explicitModel ?? OLLAMA_SUGGESTED_MODELS_LOCAL[0];
  const availableModelNames = new Set(modelNames);
  const requestedCloudModel = isOllamaCloudModel(requestedDefaultModelId);
  let pulledRequestedModel = false;

  if (requestedCloudModel) {
    availableModelNames.add(requestedDefaultModelId);
  } else if (!modelNames.includes(requestedDefaultModelId)) {
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
  let defaultModelId = requestedDefaultModelId;
  if (
    (pulledRequestedModel || requestedCloudModel) &&
    !allModelNames.includes(requestedDefaultModelId)
  ) {
    allModelNames = [...allModelNames, requestedDefaultModelId];
  }

  if (!availableModelNames.has(requestedDefaultModelId)) {
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
      allModelNames.find((name) => availableModelNames.has(name)) ??
      Array.from(availableModelNames)[0];
    params.runtime.log(
      `Ollama model ${requestedDefaultModelId} was not available; using ${defaultModelId} instead.`,
    );
  }

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
  const baseUrl = params.config.models?.providers?.ollama?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
  const modelName = params.model.slice("ollama/".length);
  if (isOllamaCloudModel(modelName)) {
    return;
  }
  const { models } = await fetchOllamaModels(baseUrl);
  if (models.some((model) => model.name === modelName)) {
    return;
  }
  if (!(await pullOllamaModel(baseUrl, modelName, params.prompter))) {
    throw new WizardCancelledError("Failed to download selected Ollama model");
  }
}
