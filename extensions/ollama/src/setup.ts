import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  isOllamaCloudModel,
  resolveOllamaApiBase,
  type OllamaModelWithContext,
} from "./provider-models.js";

export { buildOllamaProvider };

const OLLAMA_SUGGESTED_MODELS_LOCAL = [OLLAMA_DEFAULT_MODEL];
const OLLAMA_SUGGESTED_MODELS_CLOUD = [...OLLAMA_CLOUD_DEFAULT_MODELS];
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;
const OLLAMA_CLOUD_MAX_DISCOVERED_MODELS = 500;
const OLLAMA_PULL_RESPONSE_TIMEOUT_MS = 30_000;
const OLLAMA_PULL_STREAM_IDLE_TIMEOUT_MS = 300_000;
const OLLAMA_RECOMMENDED_TOOLS_MODEL = "gemma4:e4b";
const OLLAMA_RECOMMENDED_TOOLS_MODEL_SIZE = "about 9.6 GB";
const OLLAMA_TOOLS_SCAN_CONCURRENCY = 8;

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

type OllamaPullChunk = {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
};

type OllamaPullResult = { ok: true } | { ok: false; message: string };

async function readOllamaPullChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    timeoutId = setTimeout(() => {
      timedOut = true;
      clear();
      void reader.cancel().catch(() => undefined);
      reject(
        new Error(
          `Ollama pull stalled: no data received for ${Math.round(OLLAMA_PULL_STREAM_IDLE_TIMEOUT_MS / 1000)}s`,
        ),
      );
    }, OLLAMA_PULL_STREAM_IDLE_TIMEOUT_MS);

    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (err: unknown) => {
        clear();
        if (!timedOut) {
          reject(toLintErrorObject(err, "Non-Error rejection"));
        }
      },
    );
  });
}

async function pullOllamaModelCore(params: {
  baseUrl: string;
  modelName: string;
  onStatus?: (status: string, percent: number | null) => void;
  signal?: AbortSignal;
}): Promise<OllamaPullResult> {
  const baseUrl = resolveOllamaApiBase(params.baseUrl);
  const modelName = normalizeOllamaModelName(params.modelName) ?? params.modelName.trim();
  const responseController = new AbortController();
  const responseTimeout = setTimeout(
    responseController.abort.bind(responseController),
    OLLAMA_PULL_RESPONSE_TIMEOUT_MS,
  );
  try {
    params.signal?.throwIfAborted();
    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/api/pull`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      },
      signal: params.signal
        ? AbortSignal.any([responseController.signal, params.signal])
        : responseController.signal,
      policy: buildOllamaBaseUrlSsrFPolicy(baseUrl),
      auditContext: "ollama-setup.pull",
    });
    clearTimeout(responseTimeout);
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
        const { done, value } = await readOllamaPullChunkWithIdleTimeout(reader);
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
  } finally {
    clearTimeout(responseTimeout);
  }
}

async function pullOllamaModel(
  baseUrl: string,
  modelName: string,
  prompter: WizardPrompter,
  signal?: AbortSignal,
): Promise<boolean> {
  const spinner = prompter.progress(`Downloading ${modelName}...`);
  const result = await pullOllamaModelCore({
    baseUrl,
    modelName,
    ...(signal ? { signal } : {}),
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

function getOllamaLatestDedupeKey(name: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return normalized.endsWith(":latest") ? normalized.slice(0, -":latest".length) : normalized;
}

function isExplicitLatestOllamaModel(name: string): boolean {
  return normalizeLowercaseStringOrEmpty(name).endsWith(":latest");
}

function shouldReplaceOllamaModelName(existing: string, candidate: string): boolean {
  return !isExplicitLatestOllamaModel(existing) && isExplicitLatestOllamaModel(candidate);
}

function mergeUniqueModelNames(...groups: string[][]): string[] {
  const indexByKey = new Map<string, number>();
  const merged: string[] = [];
  for (const group of groups) {
    for (const name of group) {
      const key = getOllamaLatestDedupeKey(name);
      const existingIndex = indexByKey.get(key);
      if (existingIndex !== undefined) {
        const existing = expectDefined(merged[existingIndex], "indexed Ollama model name");
        if (shouldReplaceOllamaModelName(existing, name)) {
          merged[existingIndex] = name;
        }
        continue;
      }
      indexByKey.set(key, merged.length);
      merged.push(name);
    }
  }
  return merged;
}

function findAvailableOllamaModelName(modelName: string, availableModelNames: Iterable<string>) {
  const wantedKey = getOllamaLatestDedupeKey(modelName);
  for (const available of availableModelNames) {
    if (getOllamaLatestDedupeKey(available) === wantedKey) {
      return available;
    }
  }
  return undefined;
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
    return mergeUniqueModelNames(OLLAMA_SUGGESTED_MODELS_LOCAL, OLLAMA_SUGGESTED_MODELS_CLOUD);
  }

  await params.prompter.note(
    buildOllamaCloudSigninLines(auth.signinUrl).join("\n"),
    modeConfig.noteTitle,
  );
  return OLLAMA_SUGGESTED_MODELS_LOCAL;
}

function parseOllamaSetupShowInfo(data: {
  model_info?: Record<string, unknown>;
  capabilities?: unknown;
  parameters?: unknown;
}): Pick<OllamaModelWithContext, "contextWindow" | "capabilities"> {
  let contextWindow: number | undefined;
  for (const [key, value] of Object.entries(data.model_info ?? {})) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
      contextWindow = Math.floor(value);
      break;
    }
  }
  if (typeof data.parameters === "string") {
    for (const line of data.parameters.split(/\r?\n/)) {
      const match = line.trim().match(/^num_ctx\s+(-?\d+)\b/);
      const parsed = match?.[1] ? Number.parseInt(match[1], 10) : undefined;
      if (parsed && parsed > 0 && (contextWindow === undefined || parsed > contextWindow)) {
        contextWindow = parsed;
      }
    }
  }
  const capabilities = Array.isArray(data.capabilities)
    ? data.capabilities.filter((value): value is string => typeof value === "string")
    : undefined;
  return { contextWindow, capabilities };
}

async function inspectOllamaModelsForSetup(
  baseUrl: string,
  models: OllamaModelWithContext[],
  signal?: AbortSignal,
): Promise<{ inspected: OllamaModelWithContext[]; inspectionFailures: string[] }> {
  const apiBase = resolveOllamaApiBase(baseUrl);
  const inspected: OllamaModelWithContext[] = [];
  const inspectionFailures: string[] = [];
  for (let index = 0; index < models.length; index += OLLAMA_TOOLS_SCAN_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = models.slice(index, index + OLLAMA_TOOLS_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (model) => {
        try {
          const requestSignal = signal
            ? AbortSignal.any([AbortSignal.timeout(3000), signal])
            : AbortSignal.timeout(3000);
          const { response, release } = await fetchWithSsrFGuard({
            url: `${apiBase}/api/show`,
            init: {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: model.name }),
              signal: requestSignal,
            },
            signal: requestSignal,
            policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
            auditContext: "ollama-setup.tools-scan",
          });
          try {
            if (!response.ok) {
              throw new Error(`Ollama model inspection failed with HTTP ${response.status}`);
            }
            const data = await readProviderJsonResponse<{
              model_info?: Record<string, unknown>;
              capabilities?: unknown;
              parameters?: unknown;
            }>(response, "ollama-setup.tools-scan");
            return Object.assign({}, model, parseOllamaSetupShowInfo(data));
          } finally {
            await release();
          }
        } catch (error) {
          signal?.throwIfAborted();
          // Fail open per model: one stale/corrupt local model (observed: a
          // months-old pull whose /api/show returns HTTP 500) must not brick
          // the whole setup. Mark the failure with EMPTY capabilities: undefined
          // means "never inspected" and downstream config building optimistically
          // defaults that to supportsTools, which would advertise a broken model
          // as tools-capable (ClawSweeper P2 on #109797).
          inspectionFailures.push(`${model.name}: ${formatErrorMessage(error)}`);
          return Object.assign({}, model, { capabilities: [] as string[] });
        }
      }),
    );
    inspected.push(...results);
  }
  return { inspected, inspectionFailures };
}

async function promptAndConfigureHostBackedOllama(params: {
  cfg: OpenClawConfig;
  mode: HostBackedOllamaInteractiveMode;
  prompter: WizardPrompter;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<OllamaSetupResult> {
  const baseUrl = await promptForOllamaBaseUrl(params.prompter, params.env);
  const { reachable, models } = await fetchOllamaModels(baseUrl);

  if (!reachable) {
    await params.prompter.note(buildOllamaUnreachableLines(baseUrl).join("\n"), "Ollama");
    throw new WizardCancelledError("Ollama not reachable");
  }

  const firstScan = await inspectOllamaModelsForSetup(
    baseUrl,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
    params.signal,
  );
  let inspectedModels = firstScan.inspected;
  const inspectionFailures = [...firstScan.inspectionFailures];
  const supportsTools = (model: OllamaModelWithContext) =>
    model.capabilities?.includes("tools") === true;
  let hasToolsCapableModel = inspectedModels.some(supportsTools);
  if (!hasToolsCapableModel && models.length > OLLAMA_CONTEXT_ENRICH_LIMIT) {
    const remainingScan = await inspectOllamaModelsForSetup(
      baseUrl,
      models.slice(OLLAMA_CONTEXT_ENRICH_LIMIT),
      params.signal,
    );
    inspectedModels = [...inspectedModels, ...remainingScan.inspected];
    inspectionFailures.push(...remainingScan.inspectionFailures);
    hasToolsCapableModel = remainingScan.inspected.some(supportsTools);
  }
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
  const discoveredModelsByName = new Map(inspectedModels.map((model) => [model.name, model]));
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
  const orderedModelNames = mergeUniqueModelNames(OLLAMA_SUGGESTED_MODELS_LOCAL, modelNames);

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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
