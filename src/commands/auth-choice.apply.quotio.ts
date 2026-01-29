import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { resolveMoltbotAgentDir } from "../agents/agent-paths.js";
import type { MoltbotConfig } from "../config/config.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

const QUOTIO_DEFAULT_BASE_URL = "http://127.0.0.1:18317/v1";
const QUOTIO_DEFAULT_API_KEY = "quotio-local";
const QUOTIO_PROBE_TIMEOUT_MS = 3000;

type QuotioConfigFile = {
  host?: string;
  port?: number;
  "api-keys"?: string[];
};

type QuotioModel = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

type QuotioModelsResponse = {
  object: string;
  data: QuotioModel[];
};

type QuotioDetectionResult = {
  baseUrl: string;
  apiKey: string;
  models: QuotioModel[];
  autoDetected: boolean;
};

function getEnvQuotioConfig(): { baseUrl?: string; apiKey?: string } {
  return {
    baseUrl: process.env.QUOTIO_BASE_URL || process.env.QUOTIO_URL,
    apiKey: process.env.QUOTIO_API_KEY || process.env.QUOTIO_KEY,
  };
}

function getQuotioConfigPaths(): string[] {
  const home = homedir();
  return [
    join(home, "Library", "Application Support", "Quotio", "config.yaml"),
    join(home, ".config", "quotio", "config.yaml"),
    join(home, ".quotio", "config.yaml"),
  ];
}

function readQuotioConfigFile(): { baseUrl?: string; apiKey?: string } {
  for (const configPath of getQuotioConfigPaths()) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const config = parseYaml(content) as QuotioConfigFile;

      if (!config) continue;

      const host = config.host || "127.0.0.1";
      const port = config.port || 18317;
      const apiKeys = config["api-keys"];

      return {
        baseUrl: `http://${host}:${port}/v1`,
        apiKey: apiKeys?.[0],
      };
    } catch {
      continue;
    }
  }
  return {};
}

async function probeQuotioEndpoint(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number = QUOTIO_PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; models: QuotioModel[] }> {
  try {
    const modelsUrl = baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { ok: false, models: [] };
    }

    const data = (await response.json()) as QuotioModelsResponse;
    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      return { ok: false, models: [] };
    }

    return { ok: true, models: data.data };
  } catch {
    return { ok: false, models: [] };
  }
}

async function autoDetectQuotio(): Promise<QuotioDetectionResult | null> {
  const env = getEnvQuotioConfig();
  const fileConfig = readQuotioConfigFile();

  const baseUrl = env.baseUrl || fileConfig.baseUrl || QUOTIO_DEFAULT_BASE_URL;
  const apiKey = env.apiKey || fileConfig.apiKey || QUOTIO_DEFAULT_API_KEY;

  const result = await probeQuotioEndpoint(baseUrl, apiKey);
  if (result.ok) {
    return {
      baseUrl,
      apiKey,
      models: result.models,
      autoDetected: true,
    };
  }

  if (baseUrl !== QUOTIO_DEFAULT_BASE_URL || apiKey !== QUOTIO_DEFAULT_API_KEY) {
    const defaultResult = await probeQuotioEndpoint(
      QUOTIO_DEFAULT_BASE_URL,
      QUOTIO_DEFAULT_API_KEY,
    );
    if (defaultResult.ok) {
      return {
        baseUrl: QUOTIO_DEFAULT_BASE_URL,
        apiKey: QUOTIO_DEFAULT_API_KEY,
        models: defaultResult.models,
        autoDetected: true,
      };
    }
  }

  return null;
}

async function discoverQuotioModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ models: QuotioModel[]; error?: string }> {
  try {
    const modelsUrl = baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`;
    const response = await fetch(modelsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { models: [], error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = (await response.json()) as QuotioModelsResponse;
    if (!data.data || !Array.isArray(data.data)) {
      return { models: [], error: "Invalid response format from /models endpoint" };
    }

    return { models: data.data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], error: message };
  }
}

function buildModelDefinition(model: QuotioModel): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.id,
    reasoning: false,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function applyQuotioProviderConfig(
  config: MoltbotConfig,
  baseUrl: string,
  apiKey: string,
  models: ModelDefinitionConfig[],
): MoltbotConfig {
  return {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        quotio: {
          baseUrl,
          apiKey,
          api: "openai-completions",
          models,
        },
      },
    },
  };
}

function applyQuotioDefaultModel(config: MoltbotConfig, modelRef: string): MoltbotConfig {
  const models = { ...config.agents?.defaults?.models };
  models[modelRef] = models[modelRef] ?? {};

  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        models,
        model: {
          primary: modelRef,
        },
      },
    },
  };
}

export async function applyAuthChoiceQuotio(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "quotio") return null;

  let nextConfig = params.config;
  const agentDir = params.agentDir ?? resolveMoltbotAgentDir();

  await params.prompter.note("Detecting Quotio...", "Auto-detection");

  const detected = await autoDetectQuotio();

  let finalBaseUrl: string;
  let finalApiKey: string;
  let discoveredModels: QuotioModel[];

  if (detected) {
    await params.prompter.note(
      `Found Quotio at ${detected.baseUrl} with ${detected.models.length} model(s).`,
      "Auto-detected",
    );

    const useDetected = await params.prompter.confirm({
      message: `Use detected configuration? (${detected.baseUrl})`,
      initialValue: true,
    });

    if (useDetected) {
      finalBaseUrl = detected.baseUrl;
      finalApiKey = detected.apiKey;
      discoveredModels = detected.models;
    } else {
      const manualConfig = await promptManualConfig(params);
      if (!manualConfig) return { config: params.config };
      finalBaseUrl = manualConfig.baseUrl;
      finalApiKey = manualConfig.apiKey;
      discoveredModels = manualConfig.models;
    }
  } else {
    await params.prompter.note(
      [
        "Could not auto-detect Quotio.",
        "Quotio is a macOS menu bar app that unifies your AI subscriptions with quota tracking.",
        "Download from: https://www.quotio.dev",
        "",
        "If already installed, make sure Quotio is running.",
      ].join("\n"),
      "Not detected",
    );

    const manualConfig = await promptManualConfig(params);
    if (!manualConfig) return { config: params.config };
    finalBaseUrl = manualConfig.baseUrl;
    finalApiKey = manualConfig.apiKey;
    discoveredModels = manualConfig.models;
  }

  if (discoveredModels.length === 0) {
    await params.prompter.note(
      "No models found. Please check your Quotio configuration.",
      "Setup Failed",
    );
    return { config: params.config };
  }

  const modelOptions = discoveredModels.map((m) => ({
    value: m.id,
    label: m.id,
    hint: m.owned_by ? `by ${m.owned_by}` : undefined,
  }));

  const selectedModelId = await params.prompter.select({
    message: "Select default model",
    options: modelOptions,
  });

  const modelDefinitions = discoveredModels.map(buildModelDefinition);
  const defaultModelRef = `quotio/${String(selectedModelId)}`;

  upsertAuthProfile({
    profileId: "quotio:default",
    credential: {
      type: "api_key",
      provider: "quotio",
      key: finalApiKey,
    },
    agentDir,
  });

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "quotio:default",
    provider: "quotio",
    mode: "api_key",
  });

  nextConfig = applyQuotioProviderConfig(nextConfig, finalBaseUrl, finalApiKey, modelDefinitions);

  let agentModelOverride: string | undefined;
  if (params.setDefaultModel) {
    nextConfig = applyQuotioDefaultModel(nextConfig, defaultModelRef);
    await params.prompter.note(`Default model set to ${defaultModelRef}`, "Model configured");
  } else if (params.agentId) {
    agentModelOverride = defaultModelRef;
    await params.prompter.note(
      `Default model set to ${defaultModelRef} for agent "${params.agentId}".`,
      "Model configured",
    );
  }

  return { config: nextConfig, agentModelOverride };
}

async function promptManualConfig(
  params: ApplyAuthChoiceParams,
): Promise<{ baseUrl: string; apiKey: string; models: QuotioModel[] } | null> {
  const baseUrl = await params.prompter.text({
    message: "Enter Quotio base URL",
    initialValue: QUOTIO_DEFAULT_BASE_URL,
    validate: (value) => {
      if (!value?.trim()) return "Base URL is required";
      try {
        new URL(value);
        return undefined;
      } catch {
        return "Invalid URL format";
      }
    },
  });

  const apiKey = await params.prompter.text({
    message: "Enter Quotio API key (or leave default for local)",
    initialValue: QUOTIO_DEFAULT_API_KEY,
  });

  const normalizedBaseUrl = String(baseUrl).trim() || QUOTIO_DEFAULT_BASE_URL;
  const normalizedApiKey = String(apiKey).trim() || QUOTIO_DEFAULT_API_KEY;

  await params.prompter.note("Discovering available models from Quotio...", "Connecting");

  const { models, error } = await discoverQuotioModels(normalizedBaseUrl, normalizedApiKey);

  if (error) {
    await params.prompter.note(
      `Could not fetch models: ${error}\nPlease ensure Quotio is running and try again.`,
      "Discovery Failed",
    );
    return null;
  }

  return { baseUrl: normalizedBaseUrl, apiKey: normalizedApiKey, models };
}
