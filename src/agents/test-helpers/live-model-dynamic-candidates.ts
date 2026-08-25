/**
 * Dynamic live-model candidate expansion.
 * Adds prioritized plugin-discovered live models to static catalog candidates
 * while keeping the hot catalog path provider-agnostic.
 */
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import type {
  prepareProviderDynamicModel,
  runProviderDynamicModel,
} from "../../plugins/provider-runtime.js";
import { resolveProviderModernModelRef } from "../../plugins/provider-runtime.js";
import type { ProviderResolveDynamicModelContext } from "../../plugins/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { liveProvidersShareOwningPlugin } from "../live-provider-owner.js";

type ModelRef = { provider?: string | null; id?: string | null };

const HIGH_SIGNAL_LIVE_MODEL_PRIORITY = [
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "cohere/command-a-plus-05-2026",
  "moonshot/kimi-k3",
  "anthropic/claude-opus-4-6",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "minimax/minimax-m3",
  "openai/gpt-5.6",
  "openrouter/openai/gpt-5.2-chat",
  "openrouter/minimax/minimax-m2.7",
  "opencode-go/glm-5",
  "openrouter/ai21/jamba-large-1.7",
  "xai/grok-4.6",
  "xai/grok-4.5",
  "xai/grok-4.20-0309-reasoning",
  "zai/glm-5.1",
  "fireworks/accounts/fireworks/models/glm-5p1",
  "minimax-portal/minimax-m3",
] as const;

const SMALL_LIVE_MODEL_PRIORITY = [
  "lmstudio/qwen/qwen3.5-9b",
  "vllm/qwen/qwen3-8b",
  "sglang/qwen/qwen3-8b",
  "ollama/gemma3:4b",
  "openrouter/qwen/qwen3.5-9b",
  "openrouter/z-ai/glm-5.1",
  "openrouter/z-ai/glm-5",
  "zai/glm-5.1",
] as const;

export const DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT = HIGH_SIGNAL_LIVE_MODEL_PRIORITY.length;
export const DEFAULT_SMALL_LIVE_MODEL_LIMIT = SMALL_LIVE_MODEL_PRIORITY.length;

const highSignalPriorityIndex = new Map<string, number>(
  HIGH_SIGNAL_LIVE_MODEL_PRIORITY.map((ref, index) => [ref, index] as const),
);
const smallPriorityIndex = new Map<string, number>(
  SMALL_LIVE_MODEL_PRIORITY.map((ref, index) => [ref, index] as const),
);
const excludedProviders = new Set(["codex", "codex-cli"]);
const curatedProviders = new Set(["fireworks", "google", "openrouter", "xai"]);
const directOpenAiModels = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

function canonicalLiveModelRef(ref: ModelRef): string | undefined {
  const provider = normalizeProviderId(ref.provider ?? "");
  const id = normalizeLowercaseStringOrEmpty(ref.id);
  return provider && id ? `${provider}/${id}` : undefined;
}

function listLiveModelRefs(priority: readonly string[]): Array<{ provider: string; id: string }> {
  return priority.map((ref) => {
    const separator = ref.indexOf("/");
    return { provider: ref.slice(0, separator), id: ref.slice(separator + 1) };
  });
}

export function listPrioritizedHighSignalLiveModelRefs(): Array<{ provider: string; id: string }> {
  return listLiveModelRefs(HIGH_SIGNAL_LIVE_MODEL_PRIORITY);
}

export function listPrioritizedSmallLiveModelRefs(): Array<{ provider: string; id: string }> {
  return listLiveModelRefs(SMALL_LIVE_MODEL_PRIORITY);
}

export function getHighSignalLiveModelPriorityIndex(ref: ModelRef): number | null {
  const key = canonicalLiveModelRef(ref);
  return key ? (highSignalPriorityIndex.get(key) ?? null) : null;
}

export function isPrioritizedHighSignalLiveModelRef(ref: ModelRef): boolean {
  const key = canonicalLiveModelRef(ref);
  return key !== undefined && highSignalPriorityIndex.has(key);
}

export function isSmallLiveModelRef(ref: ModelRef): boolean {
  const key = canonicalLiveModelRef(ref);
  return key !== undefined && smallPriorityIndex.has(key);
}

export function isModernModelRef(ref: ModelRef): boolean {
  const provider = normalizeProviderId(ref.provider ?? "");
  const modelId = normalizeLowercaseStringOrEmpty(ref.id);
  return Boolean(
    provider &&
    modelId &&
    resolveProviderModernModelRef({ provider, context: { provider, modelId } }) === true,
  );
}

export function isHighSignalLiveModelRef(ref: ModelRef): boolean {
  const provider = normalizeProviderId(ref.provider ?? "");
  const id = normalizeLowercaseStringOrEmpty(ref.id);
  const modelName = id.split("/").pop() ?? "";
  const geminiVersion = id.match(/(?:^|\/)gemini-(\d+)(?:[.-]|$)/);
  if (
    !isModernModelRef(ref) ||
    !id ||
    (geminiVersion && Number.parseInt(geminiVersion[1] ?? "0", 10) < 3) ||
    /(?:^|-)latest(?:-|$)/.test(modelName) ||
    modelName === "minimax-m2.1" ||
    modelName.startsWith("minimax-m2.1:") ||
    /^glm-4(?:$|[.\-p])/.test(modelName) ||
    (curatedProviders.has(provider) && !highSignalPriorityIndex.has(`${provider}/${id}`))
  ) {
    return false;
  }

  const isOpenAiFamily =
    provider === "openrouter"
      ? id.startsWith("openai/")
      : provider === "opencode"
        ? modelName.startsWith("gpt-")
        : ["openai", "codex-cli", "github-copilot", "microsoft-foundry"].includes(provider);
  if (
    isOpenAiFamily &&
    (provider === "openai" ? !directOpenAiModels.has(modelName) : !modelName.startsWith("gpt-5.2"))
  ) {
    return false;
  }

  const normalized = id.replace(/[_.]/g, "-");
  if (!/\bclaude\b/i.test(normalized)) {
    return true;
  }
  if (/\bhaiku\b/i.test(normalized) || /\bclaude-3(?:[-.]5|[-.]7)\b/i.test(normalized)) {
    return false;
  }
  const version = normalized.match(/\bclaude-[a-z0-9-]*?-(\d+)(?:-(\d+))?(?:\b|[-])/i);
  const major = Number.parseInt(version?.[1] ?? "0", 10);
  const minor = Number.parseInt(version?.[2] ?? "0", 10);
  return major > 4 || (major === 4 && minor >= 6);
}

export function shouldExcludeProviderFromDefaultHighSignalLiveSweep(params: {
  provider?: string | null;
  useExplicitModels: boolean;
  providerFilter?: ReadonlySet<string> | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  resolveProviderOwners?: (provider: string) => readonly string[] | undefined;
}): boolean {
  const provider = normalizeProviderId(params.provider ?? "");
  if (!provider || params.useExplicitModels || !excludedProviders.has(provider)) {
    return false;
  }
  const ownerCache = new Map<string, readonly string[]>();
  for (const filterEntry of params.providerFilter ?? []) {
    const requestedProvider = normalizeProviderId(filterEntry);
    if (requestedProvider === provider || excludedProviders.has(requestedProvider)) {
      return false;
    }
    if (
      requestedProvider &&
      (params.resolveProviderOwners
        ? (params.resolveProviderOwners(requestedProvider) ?? []).some((owner) =>
            (params.resolveProviderOwners?.(provider) ?? []).includes(owner),
          )
        : liveProvidersShareOwningPlugin(requestedProvider, provider, {
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
            ownerCache,
          }))
    ) {
      return false;
    }
  }
  return true;
}

function selectPrioritizedLiveItems<T>(
  items: T[],
  maxItems: number,
  refOf: (item: T) => ModelRef,
  providerOf: (item: T) => string,
  priority: readonly string[],
): T[] {
  if (maxItems <= 0 || items.length <= maxItems) {
    return items;
  }
  const remaining = [...items];
  const selected: T[] = [];
  for (const ref of priority) {
    const index = remaining.findIndex((item) => canonicalLiveModelRef(refOf(item)) === ref);
    if (index >= 0) {
      selected.push(...remaining.splice(index, 1));
    }
    if (selected.length >= maxItems) {
      return selected;
    }
  }
  const grouped = new Map<string, T[]>();
  for (const item of remaining) {
    const provider = providerOf(item);
    const group = grouped.get(provider);
    if (group) {
      group.push(item);
    } else {
      grouped.set(provider, [item]);
    }
  }
  while (selected.length < maxItems && grouped.size > 0) {
    for (const [provider, group] of grouped) {
      const item = group.shift();
      if (item) {
        selected.push(item);
      }
      if (group.length === 0) {
        grouped.delete(provider);
      }
      if (selected.length >= maxItems) {
        break;
      }
    }
  }
  return selected;
}

export function selectHighSignalLiveItems<T>(
  items: T[],
  maxItems: number,
  refOf: (item: T) => ModelRef,
  providerOf: (item: T) => string,
): T[] {
  return selectPrioritizedLiveItems(
    items,
    maxItems,
    refOf,
    providerOf,
    HIGH_SIGNAL_LIVE_MODEL_PRIORITY,
  );
}

export function selectSmallLiveItems<T>(
  items: T[],
  maxItems: number,
  refOf: (item: T) => ModelRef,
  providerOf: (item: T) => string,
): T[] {
  return selectPrioritizedLiveItems(items, maxItems, refOf, providerOf, SMALL_LIVE_MODEL_PRIORITY);
}

export function resolveHighSignalLiveModelLimit(params: {
  rawMaxModels?: string;
  useExplicitModels: boolean;
  defaultLimit?: number;
}): number {
  const raw = params.rawMaxModels?.trim();
  return raw
    ? (parseStrictNonNegativeInteger(raw) ?? 0)
    : params.useExplicitModels
      ? 0
      : (params.defaultLimit ?? DEFAULT_HIGH_SIGNAL_LIVE_MODEL_LIMIT);
}

type ProviderRuntimeModule = typeof import("../../plugins/provider-runtime.js");
type DynamicModelResolver = typeof runProviderDynamicModel;
type DynamicModelPreparer = typeof prepareProviderDynamicModel;
type DynamicModelNormalizer = (model: Model, agentDir: string) => Model | Promise<Model>;

const providerRuntimeLoader = createLazyImportLoader<ProviderRuntimeModule>(
  () => import("../../plugins/provider-runtime.js"),
);

async function prepareProviderDynamicModelDefault(
  params: Parameters<DynamicModelPreparer>[0],
): ReturnType<DynamicModelPreparer> {
  const { prepareProviderDynamicModel } = await providerRuntimeLoader.load();
  return await prepareProviderDynamicModel(params);
}

async function runProviderDynamicModelDefault(
  params: Parameters<DynamicModelResolver>[0],
): Promise<ReturnType<DynamicModelResolver>> {
  const { runProviderDynamicModel } = await providerRuntimeLoader.load();
  return runProviderDynamicModel(params);
}

async function normalizeDynamicModelDefault(
  model: Model,
  agentDir: string,
  options: { config?: OpenClawConfig; workspaceDir?: string },
): Promise<Model> {
  const { normalizeDiscoveredAgentModel } = await import("../agent-model-discovery.js");
  return normalizeDiscoveredAgentModel(model, agentDir, options);
}

function liveModelKey(provider: string, id: string): string | null {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedId = normalizeLowercaseStringOrEmpty(id);
  return normalizedProvider && normalizedId ? `${normalizedProvider}/${normalizedId}` : null;
}

/**
 * Append prioritized dynamic live models that are not already present.
 *
 * Provider hooks can prepare credentials/session state, resolve the current
 * model metadata, and then pass through the same model normalizer used by agent
 * discovery so downstream catalog code sees one canonical shape.
 */
export async function appendPrioritizedDynamicLiveModels(params: {
  models: Model[];
  config?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelRegistry: ProviderResolveDynamicModelContext["modelRegistry"];
  resolveDynamicModel?: DynamicModelResolver;
  prepareDynamicModel?: DynamicModelPreparer;
  normalizeModel?: DynamicModelNormalizer;
  refs?: Array<{ provider: string; id: string }>;
}): Promise<{ models: Model[]; added: Model[] }> {
  const resolveDynamicModel = params.resolveDynamicModel ?? runProviderDynamicModelDefault;
  const prepareDynamicModel = params.prepareDynamicModel ?? prepareProviderDynamicModelDefault;
  const refs = params.refs ?? listPrioritizedHighSignalLiveModelRefs();
  const seen = new Set<string>();
  for (const model of params.models) {
    const key = liveModelKey(model.provider, model.id);
    if (key) {
      seen.add(key);
    }
  }

  const models = [...params.models];
  const added: Model[] = [];
  for (const ref of refs) {
    const requestedKey = liveModelKey(ref.provider, ref.id);
    if (!requestedKey || seen.has(requestedKey)) {
      continue;
    }
    const providerConfig = findNormalizedProviderValue(
      params.config?.models?.providers,
      ref.provider,
    );
    // Dynamic model hooks receive the originally requested provider/id so they
    // can map aliases or live service identifiers before returning a catalog row.
    const context = {
      config: params.config,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      provider: ref.provider,
      modelId: ref.id,
      modelRegistry: params.modelRegistry,
      providerConfig,
    };
    const prepared = await prepareDynamicModel({
      provider: ref.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      context,
    });
    const resolved =
      prepared ??
      (await resolveDynamicModel({
        provider: ref.provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        context,
      }));
    if (!resolved) {
      continue;
    }
    const model = params.normalizeModel
      ? await params.normalizeModel(resolved as Model, params.agentDir)
      : await normalizeDynamicModelDefault(resolved as Model, params.agentDir, {
          config: params.config,
          workspaceDir: params.workspaceDir,
        });
    const resolvedKey = liveModelKey(model.provider, model.id);
    // De-dupe against the resolved identity as well as the requested ref; hooks
    // may canonicalize provider ids or return aliases.
    if (!resolvedKey || seen.has(resolvedKey)) {
      continue;
    }
    seen.add(resolvedKey);
    models.push(model);
    added.push(model);
  }
  return { models, added };
}
