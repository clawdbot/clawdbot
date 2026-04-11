import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  listCodexAppServerModels,
  type CodexAppServerModel,
  type CodexAppServerModelListResult,
} from "./harness.js";
import {
  type CodexAppServerStartOptions,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
} from "./src/app-server/config.js";
import { clearSharedCodexAppServerClient } from "./src/app-server/shared-client.js";

const PROVIDER_ID = "codex";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;
const LIVE_DISCOVERY_ENV = "OPENCLAW_CODEX_DISCOVERY_LIVE";

type CodexModelLister = (options: {
  timeoutMs: number;
  limit?: number;
  startOptions?: CodexAppServerStartOptions;
}) => Promise<CodexAppServerModelListResult>;

type BuildCodexProviderOptions = {
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
};

type BuildCatalogOptions = {
  env?: NodeJS.ProcessEnv;
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
};

const FALLBACK_CODEX_MODELS = [
  {
    id: "gpt-5.4",
    model: "gpt-5.4",
    displayName: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    isDefault: true,
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4-mini",
    model: "gpt-5.4-mini",
    displayName: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.2",
    model: "gpt-5.2",
    displayName: "gpt-5.2",
    inputModalities: ["text", "image"],
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
] satisfies CodexAppServerModel[];

export function buildCodexProvider(options: BuildCodexProviderOptions = {}): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: "Codex",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "late",
      run: async (ctx) =>
        buildCodexProviderCatalog({
          env: ctx.env,
          pluginConfig: options.pluginConfig,
          listModels: options.listModels,
        }),
    },
    resolveDynamicModel: (ctx) => resolveCodexDynamicModel(ctx.modelId),
    resolveSyntheticAuth: () => ({
      apiKey: "codex-app-server",
      source: "codex-app-server",
      mode: "token",
    }),
    supportsXHighThinking: ({ modelId }) => isKnownXHighCodexModel(modelId),
    isModernModelRef: ({ modelId }) => isModernCodexModel(modelId),
  };
}

export async function buildCodexProviderCatalog(
  options: BuildCatalogOptions = {},
): Promise<{ provider: ModelProviderConfig }> {
  const config = readCodexPluginConfig(options.pluginConfig);
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const timeoutMs = normalizeTimeoutMs(config.discovery?.timeoutMs);
  let discovered: CodexAppServerModel[] = [];
  if (config.discovery?.enabled !== false && !shouldSkipLiveDiscovery(options.env)) {
    try {
      discovered = await listModelsBestEffort({
        listModels: options.listModels ?? listCodexAppServerModels,
        timeoutMs,
        startOptions: appServer.start,
      });
    } finally {
      clearSharedCodexAppServerClient();
    }
  }
  const models = (discovered.length > 0 ? discovered : FALLBACK_CODEX_MODELS).map(
    codexModelToDefinition,
  );
  return {
    provider: {
      baseUrl: CODEX_BASE_URL,
      auth: "token",
      api: "openai-codex-responses",
      models,
    },
  };
}

function resolveCodexDynamicModel(modelId: string): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  return normalizeModelCompat({
    ...buildModelDefinition({
      id,
      model: id,
      inputModalities: ["text", "image"],
      supportedReasoningEfforts: shouldDefaultToReasoningModel(id) ? ["medium"] : [],
    }),
    provider: PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
  } as ProviderRuntimeModel);
}

function codexModelToDefinition(model: CodexAppServerModel): ModelDefinitionConfig {
  return buildModelDefinition(model);
}

function buildModelDefinition(model: {
  id: string;
  model: string;
  displayName?: string;
  inputModalities: string[];
  supportedReasoningEfforts: string[];
}): ModelDefinitionConfig {
  const id = model.id.trim() || model.model.trim();
  return {
    id,
    name: model.displayName?.trim() || id,
    api: "openai-codex-responses",
    reasoning: model.supportedReasoningEfforts.length > 0 || shouldDefaultToReasoningModel(id),
    input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsReasoningEffort: model.supportedReasoningEfforts.length > 0,
      supportsUsageInStreaming: true,
    },
  };
}

async function listModelsBestEffort(params: {
  listModels: CodexModelLister;
  timeoutMs: number;
  startOptions: CodexAppServerStartOptions;
}): Promise<CodexAppServerModel[]> {
  try {
    const result = await params.listModels({
      timeoutMs: params.timeoutMs,
      limit: 100,
      startOptions: params.startOptions,
    });
    return result.models.filter((model) => !model.hidden);
  } catch {
    return [];
  }
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function shouldSkipLiveDiscovery(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env[LIVE_DISCOVERY_ENV]?.trim().toLowerCase();
  if (override === "0" || override === "false") {
    return true;
  }
  return Boolean(env.VITEST) && override !== "1";
}

function shouldDefaultToReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4")
  );
}

function isKnownXHighCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.includes("codex")
  );
}

function isModernCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower === "gpt-5.4" || lower === "gpt-5.4-mini" || lower === "gpt-5.2";
}
