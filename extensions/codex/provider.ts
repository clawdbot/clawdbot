import { resolvePluginConfigObject } from "openclaw/plugin-sdk/config-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeModelCompat,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveCodexSystemPromptContribution } from "./prompt-overlay.js";
import {
  buildCodexModelDefinition,
  buildCodexProviderConfig,
  CODEX_APP_SERVER_AUTH_MARKER,
  CODEX_BASE_URL,
  CODEX_PROVIDER_ID,
  FALLBACK_CODEX_MODELS,
} from "./provider-catalog.js";
import {
  type CodexAppServerStartOptions,
  readCodexPluginConfig,
  resolveCodexAppServerRuntimeOptions,
} from "./src/app-server/config.js";
import type {
  CodexAppServerModel,
  CodexAppServerModelListResult,
} from "./src/app-server/models.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;
const LIVE_DISCOVERY_ENV = "OPENCLAW_CODEX_DISCOVERY_LIVE";

type CodexModelLister = (options: {
  timeoutMs: number;
  limit?: number;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
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

export function buildCodexProvider(options: BuildCodexProviderOptions = {}): ProviderPlugin {
  return {
    id: CODEX_PROVIDER_ID,
    label: "Codex",
    docsPath: "/providers/models",
    auth: [],
    catalog: {
      order: "late",
      run: async (ctx) => {
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, CODEX_PROVIDER_ID);
        const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);
        return await buildCodexProviderCatalog({
          env: ctx.env,
          pluginConfig,
          listModels: options.listModels,
        });
      },
    },
    staticCatalog: {
      order: "late",
      run: async () => ({
        provider: buildCodexProviderConfig(FALLBACK_CODEX_MODELS),
      }),
    },
    resolveDynamicModel: (ctx) => resolveCodexDynamicModel(ctx.modelId),
    resolveSyntheticAuth: () => ({
      apiKey: CODEX_APP_SERVER_AUTH_MARKER,
      source: "codex-app-server",
      mode: "token",
    }),
    resolveThinkingProfile: ({ modelId }) => ({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        ...(isKnownXHighCodexModel(modelId) ? [{ id: "xhigh" as const }] : []),
      ],
    }),
    resolveSystemPromptContribution: ({ config, modelId }) =>
      resolveCodexSystemPromptContribution({ config, modelId }),
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
    discovered = await listModelsBestEffort({
      listModels: options.listModels ?? listCodexAppServerModelsLazy,
      timeoutMs,
      startOptions: appServer.start,
    });
  }
  return {
    provider: buildCodexProviderConfig(discovered.length > 0 ? discovered : FALLBACK_CODEX_MODELS),
  };
}

function resolveCodexDynamicModel(modelId: string): ProviderRuntimeModel | undefined {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  return normalizeModelCompat({
    ...buildCodexModelDefinition({
      id,
      model: id,
      inputModalities: ["text", "image"],
      supportedReasoningEfforts: shouldDefaultToReasoningModel(id) ? ["medium"] : [],
    }),
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
  } as ProviderRuntimeModel);
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
      sharedClient: false,
    });
    return result.models.filter((model) => !model.hidden);
  } catch {
    return [];
  }
}

async function listCodexAppServerModelsLazy(options: {
  timeoutMs: number;
  limit?: number;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
}): Promise<CodexAppServerModelListResult> {
  const { listCodexAppServerModels } = await import("./src/app-server/models.js");
  return listCodexAppServerModels(options);
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
