import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../../../agents/agent-runtime-id.js";
import { resolveConfiguredProviderFallback } from "../../../agents/configured-provider-fallback.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { normalizeConfiguredProviderCatalogModelId } from "../../../agents/model-ref-shared.js";
import { configuredModelRouteNeedsCodex } from "../../../config/codex-plugin-diagnostics.js";
import type { AgentRuntimePolicyConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import type { MutableRecord } from "./codex-route-types.js";

export function normalizeRuntimeString(value: unknown): string | undefined {
  return normalizeOptionalAgentRuntimeId(value);
}

export function asAgentRuntimePolicyConfig(value: unknown): AgentRuntimePolicyConfig | undefined {
  const record = asMutableRecord(value);
  return record ? { id: typeof record.id === "string" ? record.id : undefined } : undefined;
}

export function readLegacyDefaultsRuntime(defaults: unknown): AgentRuntimePolicyConfig | undefined {
  return asAgentRuntimePolicyConfig(asMutableRecord(defaults)?.agentRuntime);
}

export function isOpenAICodexModelRef(model: string | undefined): model is string {
  return normalizeString(model)?.startsWith("openai-codex/") === true;
}

export function isOpenAICodexAuthProfileRef(profile: unknown): boolean {
  return normalizeString(profile)?.startsWith("openai-codex:") === true;
}

export function isProviderlessModelRef(model: unknown): model is string {
  const normalized = normalizeString(model);
  return Boolean(normalized && !normalized.includes("/"));
}

export function toCanonicalOpenAIModelRef(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId ? `openai/${modelId}` : undefined;
}

export function toOpenAIModelId(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId || undefined;
}

export function resolveRuntime(params: {
  agentRuntime?: AgentRuntimePolicyConfig;
  defaultsRuntime?: AgentRuntimePolicyConfig;
}): string | undefined {
  return (
    normalizeRuntimeString(params.agentRuntime?.id) ??
    normalizeRuntimeString(params.defaultsRuntime?.id)
  );
}

export function readModelConfigPrimaryRef(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  const record = asMutableRecord(value);
  if (typeof record?.primary === "string") {
    return record.primary.trim() || undefined;
  }
  return undefined;
}

export function readAgentPrimaryModelRef(agent: unknown, fallback?: string): string | undefined {
  const record = asMutableRecord(agent);
  if (!record) {
    return fallback;
  }
  return readModelConfigPrimaryRef(record.model) ?? fallback;
}

export function modelRefUsesCodexRuntime(params: {
  cfg: OpenClawConfig;
  modelRef: string | undefined;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const effectiveModelRef = params.modelRef?.trim() || `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  if (isOpenAICodexModelRef(effectiveModelRef)) {
    return true;
  }
  return canonicalOpenAIModelUsesCodexRuntime({
    cfg: params.cfg,
    modelRef: resolveRuntimeModelRef({
      cfg: params.cfg,
      modelRef: effectiveModelRef,
      agentId: params.agentId,
    }),
    agentId: params.agentId,
    env: params.env,
  });
}

export function resolveRuntimeModelRef(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): string {
  const effectiveModelRef =
    normalizeProviderModelRefAuthProfile(params.modelRef) ?? `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  const legacyCodexModel = toCanonicalOpenAIModelRef(effectiveModelRef);
  if (legacyCodexModel) {
    return legacyCodexModel;
  }
  return (
    resolveKnownCompatModelAliasRef(effectiveModelRef) ??
    resolveConfiguredModelAliasRef({
      cfg: params.cfg,
      modelRef: effectiveModelRef,
      agentId: params.agentId,
    }) ??
    resolveConfiguredBareModelRef({
      cfg: params.cfg,
      modelRef: effectiveModelRef,
      agentId: params.agentId,
    }) ??
    normalizeDefaultProviderModelRef(
      effectiveModelRef,
      resolveDefaultProviderForAliasContext({ cfg: params.cfg, agentId: params.agentId }),
    )
  );
}

function normalizeProviderModelRefAuthProfile(modelRef: string): string | undefined {
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return undefined;
  }
  return splitTrailingAuthProfile(trimmed).model || trimmed;
}

function resolveKnownCompatModelAliasRef(modelRef: string): string | undefined {
  const normalized = normalizeString(modelRef);
  if (!normalized?.startsWith("openrouter:")) {
    return undefined;
  }
  const modelId = normalized.slice("openrouter:".length).trim();
  return modelId ? `openrouter/openrouter/${modelId}` : undefined;
}

function resolveConfiguredModelAliasRef(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): string | undefined {
  const aliasKey = normalizeString(params.modelRef);
  if (!aliasKey) {
    return undefined;
  }
  const defaultProvider = resolveDefaultProviderForAliasContext({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return resolveAliasFromModelsMap(
    asMutableRecord(params.cfg.agents?.defaults?.models),
    aliasKey,
    defaultProvider,
  );
}

function resolveDefaultProviderForAliasContext(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string {
  const primaryModelRef =
    readModelConfigPrimaryRef(findAgentById(params.cfg, params.agentId)?.model) ??
    readModelConfigPrimaryRef(params.cfg.agents?.defaults?.model);
  if (primaryModelRef) {
    const effectivePrimaryModelRef =
      normalizeProviderModelRefAuthProfile(primaryModelRef) ?? primaryModelRef;
    const legacyCodexModel = toCanonicalOpenAIModelRef(effectivePrimaryModelRef);
    const compatModelRef = resolveKnownCompatModelAliasRef(effectivePrimaryModelRef);
    const primaryAliasRef = resolveAliasFromModelsMap(
      asMutableRecord(params.cfg.agents?.defaults?.models),
      normalizeString(effectivePrimaryModelRef) ?? "",
      DEFAULT_PROVIDER,
    );
    const parsed =
      parseModelRef(
        primaryAliasRef ?? compatModelRef ?? legacyCodexModel ?? effectivePrimaryModelRef,
      ) ??
      parseModelRef(
        resolveConfiguredBareModelRef({
          cfg: params.cfg,
          modelRef: effectivePrimaryModelRef,
          agentId: params.agentId,
        }) ?? "",
      );
    return normalizeProviderId(parsed?.provider ?? DEFAULT_PROVIDER) || DEFAULT_PROVIDER;
  }
  const implicit = parseModelRef(resolveImplicitDefaultAgentModelRef(params.cfg));
  return normalizeProviderId(implicit?.provider ?? DEFAULT_PROVIDER) || DEFAULT_PROVIDER;
}

function findAgentById(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): MutableRecord | undefined {
  if (!agentId) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  return agents
    .map((agent) => asMutableRecord(agent))
    .find(
      (agent) =>
        normalizeAgentId(typeof agent?.id === "string" ? agent.id : undefined) ===
        normalizedAgentId,
    );
}

function resolveAliasFromModelsMap(
  models: MutableRecord | undefined,
  aliasKey: string,
  defaultProvider: string,
): string | undefined {
  for (const [modelRef, entry] of Object.entries(models ?? {})) {
    if (normalizeString(asMutableRecord(entry)?.alias) !== aliasKey) {
      continue;
    }
    const compatRef = resolveKnownCompatModelAliasRef(modelRef);
    if (compatRef) {
      return compatRef;
    }
    return modelRef.includes("/")
      ? normalizeDefaultProviderModelRef(modelRef)
      : `${defaultProvider}/${modelRef}`;
  }
  return undefined;
}

function resolveConfiguredBareModelRef(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): string | undefined {
  const modelId = params.modelRef.trim();
  if (!modelId || modelId.includes("/")) {
    return undefined;
  }
  const matches = new Set<string>();
  const pushModelMapMatches = (models: MutableRecord | undefined) => {
    for (const key of Object.keys(models ?? {})) {
      const parsed = parseModelRef(key);
      if (parsed?.modelId === modelId) {
        matches.add(`${parsed.provider}/${parsed.modelId}`);
      }
    }
  };
  pushModelMapMatches(asMutableRecord(params.cfg.agents?.defaults?.models));
  for (const [provider, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    for (const model of providerConfig?.models ?? []) {
      if (providerCatalogModelMatches(provider, model?.id, modelId)) {
        matches.add(`${normalizeProviderId(provider)}/${modelId}`);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function providerCatalogModelMatches(
  provider: string,
  catalogModelId: string | undefined,
  modelId: string,
): boolean {
  const rawId = catalogModelId?.trim();
  if (!rawId) {
    return false;
  }
  const normalizedId = normalizeConfiguredProviderCatalogModelId(provider, rawId);
  if (normalizedId === modelId) {
    return true;
  }
  return normalizeString(normalizedId) === normalizeString(modelId);
}

export function normalizeDefaultProviderModelRef(
  modelRef: string,
  defaultProvider = DEFAULT_PROVIDER,
): string {
  return modelRef.includes("/") ? modelRef : `${defaultProvider}/${modelRef}`;
}

function normalizeProviderModelRef(provider: string, modelId: string): string {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModelId = normalizeConfiguredProviderCatalogModelId(normalizedProvider, modelId);
  const slash = normalizedModelId.indexOf("/");
  if (
    slash > 0 &&
    normalizeProviderId(normalizedModelId.slice(0, slash)) === normalizedProvider &&
    slash < normalizedModelId.length - 1
  ) {
    return `${normalizedProvider}/${normalizedModelId.slice(slash + 1)}`;
  }
  return `${normalizedProvider}/${normalizedModelId}`;
}

export function resolveImplicitDefaultAgentModelRef(cfg: OpenClawConfig): string {
  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  return fallbackProvider
    ? normalizeProviderModelRef(fallbackProvider.provider, fallbackProvider.model)
    : `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
}

export function agentUsesCodexRuntimeForCompaction(params: {
  cfg: OpenClawConfig;
  agent: unknown;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const runtime = concreteRuntimeId(normalizeString(params.currentRuntime));
  if (runtime) {
    return runtime === "codex";
  }
  return modelRefUsesCodexRuntime({
    cfg: params.cfg,
    modelRef: readAgentPrimaryModelRef(params.agent, params.inheritedModelRef),
    agentId: params.agentId,
    env: params.env,
  });
}

function concreteRuntimeId(runtime: string | undefined): string | undefined {
  return runtime && runtime !== "auto" && runtime !== "default" ? runtime : undefined;
}

export function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash >= modelRef.length - 1) {
    return undefined;
  }
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

export function canonicalOpenAIModelUsesCodexRuntime(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const parsed = parseModelRef(params.modelRef);
  if (!parsed) {
    return false;
  }
  return configuredModelRouteNeedsCodex({
    cfg: params.cfg,
    env: params.env ?? process.env,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    route: { provider: parsed.provider, modelId: parsed.modelId },
  });
}
