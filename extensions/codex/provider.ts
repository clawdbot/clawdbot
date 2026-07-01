/**
 * Codex provider plugin and live app-server model catalog discovery.
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
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
import { buildCodexAppServerUsageSnapshot } from "./src/app-server/rate-limits.js";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;
const LIVE_DISCOVERY_ENV = "OPENCLAW_CODEX_DISCOVERY_LIVE";
const MODEL_DISCOVERY_PAGE_LIMIT = 100;
const CODEX_APP_SERVER_SETUP_METHOD_ID = "app-server";
const CODEX_DEFAULT_MODEL_REF = `${CODEX_PROVIDER_ID}/${FALLBACK_CODEX_MODELS[0].id}`;
const codexCatalogLog = createSubsystemLogger("codex/catalog");
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

type CodexModelLister = (options: {
  timeoutMs: number;
  limit?: number;
  cursor?: string;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
}) => Promise<CodexAppServerModelListResult>;

type CodexRateLimitReader = (options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<typeof requestCodexAppServerRateLimitsLazy>[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}) => Promise<unknown>;

type BuildCodexProviderOptions = {
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
  readRateLimits?: CodexRateLimitReader;
};

type BuildCatalogOptions = {
  env?: NodeJS.ProcessEnv;
  pluginConfig?: unknown;
  listModels?: CodexModelLister;
  onDiscoveryFailure?: (error: unknown) => void;
};

/**
 * Builds the Codex provider plugin, including setup metadata, catalog discovery,
 * dynamic model resolution, and prompt/thinking hooks.
 */
export function buildCodexProvider(options: BuildCodexProviderOptions = {}): ProviderPlugin {
  return {
    id: CODEX_PROVIDER_ID,
    label: "Codex",
    docsPath: "/providers/models",
    auth: [
      {
        id: CODEX_APP_SERVER_SETUP_METHOD_ID,
        label: "Codex app-server",
        hint: "Use the Codex app-server runtime and managed model catalog.",
        kind: "custom",
        wizard: {
          choiceId: CODEX_PROVIDER_ID,
          choiceLabel: "Codex app-server",
          choiceHint: "Use the Codex app-server runtime and managed model catalog.",
          assistantPriority: -40,
          groupId: CODEX_PROVIDER_ID,
          groupLabel: "Codex",
          groupHint: "Codex app-server model provider",
          onboardingScopes: ["text-inference"],
        },
        run: async () => ({ profiles: [], defaultModel: CODEX_DEFAULT_MODEL_REF }),
      },
    ],
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
    fetchUsageSnapshot: async (ctx) => {
      if (ctx.token !== CODEX_APP_SERVER_AUTH_MARKER) {
        return null;
      }
      const runtimePluginConfig = resolvePluginConfigObject(ctx.config, CODEX_PROVIDER_ID);
      const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);
      const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const rateLimits = await (options.readRateLimits ?? requestCodexAppServerRateLimitsLazy)({
        timeoutMs: ctx.timeoutMs,
        agentDir: ctx.agentDir,
        ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
        config: ctx.config,
        startOptions: appServer.start,
      });
      return buildCodexAppServerUsageSnapshot(rateLimits);
    },
    resolveThinkingProfile: ({ modelId, compat }) => ({
      levels: [
        { id: "off" },
        ...resolveCodexThinkingEfforts({
          modelId,
          supportedReasoningEfforts: readCodexSupportedReasoningEfforts(compat),
        }).map((id) => ({ id })),
      ],
    }),
    resolveSystemPromptContribution: ({ config, modelId }) =>
      resolveCodexSystemPromptContribution({ config, modelId }),
    isModernModelRef: ({ modelId }) => isModernCodexModel(modelId),
  };
}

/**
 * Builds the Codex model catalog from live app-server discovery, falling back
 * to built-in model records when discovery is disabled or unavailable.
 */
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
      onDiscoveryFailure: options.onDiscoveryFailure,
    });
  }
  return {
    provider: buildCodexProviderConfig(discovered.length > 0 ? discovered : FALLBACK_CODEX_MODELS),
  };
}

function resolveCodexDynamicModel(modelId: string) {
  const id = modelId.trim();
  if (!id) {
    return undefined;
  }
  const fallbackModel = FALLBACK_CODEX_MODELS.find((model) => model.id === id);
  return normalizeModelCompat({
    ...buildCodexModelDefinition({
      id,
      model: id,
      inputModalities: fallbackModel?.inputModalities ?? ["text"],
      supportedReasoningEfforts: fallbackModel?.supportedReasoningEfforts,
    }),
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_BASE_URL,
  } as ProviderRuntimeModel);
}

async function listModelsBestEffort(params: {
  listModels: CodexModelLister;
  timeoutMs: number;
  startOptions: CodexAppServerStartOptions;
  onDiscoveryFailure?: (error: unknown) => void;
}): Promise<CodexAppServerModel[]> {
  try {
    const models: CodexAppServerModel[] = [];
    let cursor: string | undefined;
    do {
      // App-server model listing is paginated; collect every visible model so
      // aliases and picker rows match the current Codex account.
      const result = await params.listModels({
        timeoutMs: params.timeoutMs,
        limit: MODEL_DISCOVERY_PAGE_LIMIT,
        cursor,
        startOptions: params.startOptions,
        sharedClient: false,
      });
      models.push(...result.models.filter((model) => !model.hidden));
      cursor = result.nextCursor;
    } while (cursor);
    return models;
  } catch (error) {
    params.onDiscoveryFailure?.(error);
    codexCatalogLog.debug("codex model discovery failed; using fallback catalog", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function listCodexAppServerModelsLazy(options: {
  timeoutMs: number;
  limit?: number;
  cursor?: string;
  startOptions?: CodexAppServerStartOptions;
  sharedClient?: boolean;
}): Promise<CodexAppServerModelListResult> {
  const { listCodexAppServerModels } = await import("./src/app-server/models.js");
  return listCodexAppServerModels(options);
}

async function requestCodexAppServerRateLimitsLazy(options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<
    typeof import("./src/app-server/request.js").requestCodexAppServerJson
  >[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}): Promise<unknown> {
  const { requestCodexAppServerJson } = await import("./src/app-server/request.js");
  return await requestCodexAppServerJson({
    method: "account/rateLimits/read",
    timeoutMs: options.timeoutMs,
    agentDir: options.agentDir,
    ...(options.authProfileId ? { authProfileId: options.authProfileId } : {}),
    config: options.config,
    startOptions: options.startOptions,
    isolated: true,
  });
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

function isKnownXHighCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower.startsWith("gpt-5") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.includes("codex")
  );
}

function normalizeCodexReasoningEfforts(
  efforts: readonly string[] | null | undefined,
): CodexReasoningEffort[] {
  if (!efforts) {
    return [];
  }
  const supported = new Set(efforts.map((effort) => effort.trim().toLowerCase()));
  return CODEX_REASONING_EFFORTS.filter((effort) => supported.has(effort));
}

/** Read app-server reasoning metadata from a runtime model compat union. */
export function readCodexSupportedReasoningEfforts(compat: unknown): string[] | undefined {
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  const efforts = (compat as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  if (!Array.isArray(efforts)) {
    return undefined;
  }
  return efforts.filter((effort): effort is string => typeof effort === "string");
}

function resolveCodexThinkingEfforts(params: {
  modelId: string;
  supportedReasoningEfforts?: readonly string[] | null;
}): CodexReasoningEffort[] {
  if (params.supportedReasoningEfforts) {
    return normalizeCodexReasoningEfforts(params.supportedReasoningEfforts);
  }
  return [
    "minimal",
    "low",
    "medium",
    "high",
    ...(isKnownXHighCodexModel(params.modelId) ? (["xhigh"] as const) : []),
    ...(isMaxReasoningCodexModel(params.modelId) ? (["max"] as const) : []),
  ];
}

/** Map a requested effort onto the authoritative app-server model contract. */
export function resolveCodexSupportedReasoningEffort(params: {
  requested: CodexReasoningEffort;
  supportedReasoningEfforts: readonly string[];
}): CodexReasoningEffort | undefined {
  const supported = normalizeCodexReasoningEfforts(params.supportedReasoningEfforts);
  if (supported.includes(params.requested)) {
    return params.requested;
  }
  const requestedRank = CODEX_REASONING_EFFORTS.indexOf(params.requested);
  return (
    supported.find((effort) => CODEX_REASONING_EFFORTS.indexOf(effort) >= requestedRank) ??
    supported.at(-1)
  );
}

/**
 * Returns true for Codex models that use the modern reasoning effort enum and
 * reject the legacy CLI `minimal` default.
 */
export function isModernCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    lower === "gpt-5.6" ||
    lower.startsWith("gpt-5.6-") ||
    lower === "gpt-5.5" ||
    lower === "gpt-5.4" ||
    lower === "gpt-5.4-mini" ||
    lower === "gpt-5.3-codex-spark"
  );
}

/** Return whether Codex accepts the preview GPT-5.6 `max` reasoning effort. */
export function isMaxReasoningCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return lower === "gpt-5.6" || lower.startsWith("gpt-5.6-");
}
