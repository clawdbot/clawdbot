// Opencode Go provider module implements model/runtime integration.
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildLiveModelProviderConfig,
  fetchLiveProviderModelIds,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { normalizeModelCompat } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

const PROVIDER_ID = "opencode-go";

const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS = new Set([
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
]);
const OPENCODE_GO_MODELS_ENDPOINT = "https://opencode.ai/zen/go/v1/models";
const OPENCODE_GO_MODELS_TIMEOUT_MS = 5_000;
const OPENCODE_GO_MODELS_CACHE_TTL_MS = 60_000;
type OpencodeGoModelDefinition = ModelDefinitionConfig & {
  provider: typeof PROVIDER_ID;
  api: NonNullable<ModelDefinitionConfig["api"]>;
  baseUrl: string;
  input: Array<"text" | "image">;
};

const T = ["text"] as const;
const TI = ["text", "image"] as const;
const E_HM = ["high", "max"] as const;
const E_LHM = ["low", "high", "max"] as const;
const E_LMH = ["low", "medium", "high"] as const;
const E_NONE_LH = ["none", "low", "high"] as const;
const E_NONE_LMHXM = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const E_MAX = ["max"] as const;

type OpencodeGoCostRow =
  | readonly [number, number, number, number]
  | readonly [number, number, number, number, number, number, number, number, number];
type OpencodeGoModelRow = readonly [
  id: string,
  contextWindow: number,
  maxTokens: number,
  input: ReadonlyArray<"text" | "image">,
  cost: OpencodeGoCostRow,
  reasoningEfforts?: readonly string[],
  contextTokens?: number,
];

const OPENCODE_GO_MODEL_ROWS = [
  ["deepseek-v4-pro", 1_000_000, 384_000, T, [0.435, 0.87, 0.003625, 0], E_HM],
  ["deepseek-v4-flash", 1_000_000, 384_000, T, [0.14, 0.28, 0.0028, 0], E_LHM],
  ["glm-5", 202_752, 32_768, T, [1, 3.2, 0.2, 0]],
  ["glm-5.1", 202_752, 32_768, T, [1.4, 4.4, 0.26, 0]],
  ["glm-5.2", 1_000_000, 131_072, T, [1.4, 4.4, 0.26, 0], E_HM],
  [
    "gpt-5.6-luna",
    1_050_000,
    128_000,
    TI,
    [0.2, 1.2, 0.02, 0.25, 272_000, 0.4, 1.8, 0.04, 0.5],
    E_NONE_LMHXM,
    922_000,
  ],
  ["grok-4.5", 500_000, 500_000, TI, [2, 6, 0.3, 0], E_LMH],
  ["hy3", 256_000, 64_000, T, [0.14, 0.58, 0.035, 0], E_NONE_LH],
  ["hy3-preview", 262_144, 32_768, T, [0, 0, 0, 0]],
  ["kimi-k2.5", 262_144, 65_536, TI, [0.6, 3, 0.1, 0]],
  ["kimi-k2.6", 262_144, 65_536, TI, [0.95, 4, 0.16, 0]],
  ["kimi-k2.7-code", 262_144, 262_144, TI, [0.95, 4, 0.19, 0]],
  ["kimi-k3", 1_048_576, 131_072, TI, [3, 15, 0.3, 0], E_MAX],
  ["mimo-v2-omni", 262_144, 128_000, TI, [0.4, 2, 0.08, 0]],
  ["mimo-v2-pro", 1_048_576, 128_000, T, [1, 3, 0.2, 0, 256_000, 2, 6, 0.4, 0]],
  ["mimo-v2.5", 1_000_000, 128_000, TI, [0.14, 0.28, 0.0028, 0]],
  ["mimo-v2.5-pro", 1_048_576, 128_000, T, [0.435, 0.87, 0.003625, 0]],
  ["minimax-m2.5", 204_800, 65_536, T, [0.3, 1.2, 0.06, 0.375]],
  ["minimax-m2.7", 204_800, 131_072, T, [0.3, 1.2, 0.06, 0.375]],
  ["minimax-m3", 1_000_000, 131_072, TI, [0.3, 1.2, 0.06, 0, 512_000, 0.6, 2.4, 0.12, 0]],
  ["qwen3.5-plus", 262_144, 65_536, TI, [0.2, 1.2, 0.02, 0.25]],
  ["qwen3.7-max", 1_000_000, 65_536, T, [2.5, 7.5, 0.5, 3.125]],
  ["qwen3.7-plus", 1_000_000, 65_536, TI, [0.4, 1.6, 0.04, 0.5, 256_000, 1.2, 4.8, 0.12, 1.5]],
  ["qwen3.8-max", 1_000_000, 131_072, TI, [2, 6, 0.25, 2.5]],
  ["qwen3.6-plus", 1_000_000, 65_536, TI, [0.5, 3, 0.05, 0.625, 256_000, 2, 6, 0.2, 2.5]],
] as const satisfies readonly OpencodeGoModelRow[];

const OPENCODE_GO_MODEL_STATUS = new Map<string, "deprecated" | "preview">([
  ["glm-5", "deprecated"],
  ["qwen3.5-plus", "deprecated"],
  ["mimo-v2-omni", "deprecated"],
  ["kimi-k2.5", "deprecated"],
  ["mimo-v2-pro", "deprecated"],
  ["minimax-m2.5", "deprecated"],
  ["hy3-preview", "preview"],
]);

function titleCaseModelPart(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function formatOpencodeGoModelName(id: string): string {
  if (id === "hy3" || id === "hy3-preview") {
    return id === "hy3" ? "Hy3" : "HY3 Preview";
  }
  if (id.startsWith("qwen")) {
    const [version, ...parts] = id.slice(4).split("-");
    return `Qwen${version}${parts.length ? ` ${parts.map(titleCaseModelPart).join(" ")}` : ""}`;
  }
  const [family = "", ...parts] = id.split("-");
  const prefix: Record<string, string> = {
    deepseek: "DeepSeek",
    glm: "GLM",
    gpt: "GPT",
    grok: "Grok",
    kimi: "Kimi",
    mimo: "MiMo",
    minimax: "MiniMax",
  };
  const separator = family === "glm" || family === "gpt" ? "-" : " ";
  return `${prefix[family] ?? titleCaseModelPart(family)}${separator}${parts.map(titleCaseModelPart).join(" ")}`;
}

function buildOpencodeGoCost(row: OpencodeGoCostRow): ModelDefinitionConfig["cost"] {
  const [input, output, cacheRead, cacheWrite] = row;
  const cost = { input, output, cacheRead, cacheWrite };
  if (row.length === 4) {
    return cost;
  }
  const threshold = row[4];
  const tierInput = row[5];
  const tierOutput = row[6];
  const tierCacheRead = row[7];
  const tierCacheWrite = row[8];
  return {
    ...cost,
    tieredPricing: [
      { ...cost, range: [0, threshold] },
      {
        input: tierInput,
        output: tierOutput,
        cacheRead: tierCacheRead,
        cacheWrite: tierCacheWrite,
        range: [threshold],
      },
    ],
  };
}

function buildOpencodeGoModel(row: OpencodeGoModelRow): OpencodeGoModelDefinition {
  const [id, contextWindow, maxTokens, input, cost, reasoningEfforts, contextTokens] = row;
  const anthropic = id.startsWith("minimax-") || id.startsWith("qwen");
  const api = id.startsWith("gpt-")
    ? "openai-responses"
    : anthropic
      ? "anthropic-messages"
      : "openai-completions";
  const model: OpencodeGoModelDefinition = {
    id,
    name: formatOpencodeGoModelName(id),
    api,
    provider: PROVIDER_ID,
    baseUrl: anthropic ? OPENCODE_GO_ANTHROPIC_BASE_URL : OPENCODE_GO_OPENAI_BASE_URL,
    reasoning: true,
    input: [...input],
    cost: buildOpencodeGoCost(cost),
    contextWindow,
    ...(contextTokens ? { contextTokens } : {}),
    maxTokens,
    ...(reasoningEfforts
      ? {
          compat: {
            supportsUsageInStreaming: true,
            supportsReasoningEffort: true,
            supportedReasoningEfforts: [...reasoningEfforts],
            maxTokensField: "max_tokens",
          },
        }
      : id.startsWith("qwen")
        ? { compat: { thinkingFormat: "qwen" as const } }
        : {}),
  };
  return normalizeModelCompat(model) as OpencodeGoModelDefinition;
}

const OPENCODE_GO_RESOLVABLE_MODELS = OPENCODE_GO_MODEL_ROWS.map(buildOpencodeGoModel);

const OPENCODE_GO_MODEL_BY_ID = new Map(
  OPENCODE_GO_RESOLVABLE_MODELS.map((model) => [model.id, model]),
);
const OPENCODE_GO_MODELS = OPENCODE_GO_RESOLVABLE_MODELS.filter(
  (model) => !OPENCODE_GO_MODEL_STATUS.has(model.id),
);

type FetchOpencodeGoLiveModelIdsParams = {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

export function buildStaticOpencodeGoProviderConfig(apiKey?: string): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models: OPENCODE_GO_MODELS,
  };
}

export async function resolveOpencodeGoStarterModel(params: {
  apiKey: string;
  preferredModelRef: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const liveModelIds = await fetchLiveProviderModelIds({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_GO_MODELS_ENDPOINT,
    discoveryApiKey: params.apiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
    auditContext: "opencode-go-onboarding-model-discovery",
  });
  const preferredModelId = params.preferredModelRef.replace(`${PROVIDER_ID}/`, "");
  return liveModelIds.includes(preferredModelId) ? params.preferredModelRef : undefined;
}

export async function buildOpencodeGoLiveProviderConfig(
  params: FetchOpencodeGoLiveModelIdsParams = {},
): Promise<ModelProviderConfig> {
  return await buildLiveModelProviderConfig({
    providerId: PROVIDER_ID,
    endpoint: OPENCODE_GO_MODELS_ENDPOINT,
    providerConfig: {
      api: "openai-completions",
      baseUrl: OPENCODE_GO_OPENAI_BASE_URL,
    },
    models: OPENCODE_GO_MODELS,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    timeoutMs: OPENCODE_GO_MODELS_TIMEOUT_MS,
    ttlMs: OPENCODE_GO_MODELS_CACHE_TTL_MS,
    auditContext: "opencode-go-model-discovery",
  });
}

export function listOpencodeGoModelCatalogEntries(): ModelCatalogEntry[] {
  return OPENCODE_GO_RESOLVABLE_MODELS.map((model) => {
    const entry: ModelCatalogEntry = {
      provider: model.provider,
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      contextTokens: model.contextTokens,
      compat: model.compat,
    };
    const status = OPENCODE_GO_MODEL_STATUS.get(model.id);
    if (status) {
      entry.status = status;
    }
    return entry;
  });
}

export function resolveOpencodeGoModel(modelId: string): ProviderRuntimeModel | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  return OPENCODE_GO_MODEL_BY_ID.get(normalizedModelId);
}

export function isOpencodeGoKimiNoReasoningModelId(modelId: unknown): boolean {
  return (
    typeof modelId === "string" &&
    OPENCODE_GO_KIMI_NO_REASONING_MODEL_IDS.has(modelId.trim().toLowerCase())
  );
}

export function normalizeOpencodeGoResolvedModel(
  model: ProviderRuntimeModel,
): ProviderRuntimeModel | undefined {
  if (!isOpencodeGoKimiNoReasoningModelId(model.id)) {
    return undefined;
  }
  const compat =
    model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
      ? model.compat
      : undefined;
  if (!model.reasoning && !compat?.supportsReasoningEffort) {
    return undefined;
  }
  return {
    ...model,
    reasoning: false,
    compat: {
      ...compat,
      supportsReasoningEffort: false,
    },
  };
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeOpencodeGoBaseUrl(params: {
  api?: string | null;
  baseUrl?: string;
}): string | undefined {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENCODE_GO_OPENAI_BASE_URL) {
    return OPENCODE_GO_OPENAI_BASE_URL;
  }
  if (normalized === OPENCODE_GO_ANTHROPIC_BASE_URL) {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go") {
    return OPENCODE_GO_ANTHROPIC_BASE_URL;
  }
  if (normalized === "https://opencode.ai/go/v1") {
    return params.api === "anthropic-messages"
      ? OPENCODE_GO_ANTHROPIC_BASE_URL
      : OPENCODE_GO_OPENAI_BASE_URL;
  }
  return undefined;
}
