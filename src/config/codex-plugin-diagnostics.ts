// Builds diagnostics for Codex plugin config and provider wiring.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveEffectiveModelFallbacks,
} from "../agents/agent-scope.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { resolveOpenAIImplicitAgentRuntime } from "../agents/openai-routing.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentModelFallbackValues } from "./model-input.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const CODEX_PLUGIN_ID = "codex";
const OPENAI_PROVIDER_ID = "openai";

type ModelRoute = {
  provider: string;
  modelId: string;
};

function codexPluginEntryEnabled(cfg: OpenClawConfig): boolean | undefined {
  for (const [pluginId, entry] of Object.entries(cfg.plugins?.entries ?? {})) {
    if (normalizeLowercaseStringOrEmpty(pluginId) === CODEX_PLUGIN_ID) {
      return entry?.enabled;
    }
  }
  return undefined;
}

function configuredRuntimeNeedsCodex(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  modelId?: string;
  runtimeId?: string;
}): boolean {
  const runtimeId = normalizeOptionalAgentRuntimeId(params.runtimeId);
  if (runtimeId === CODEX_PLUGIN_ID) {
    return true;
  }
  if (!isDefaultAgentRuntimeId(runtimeId)) {
    return false;
  }
  return (
    resolveOpenAIImplicitAgentRuntime({
      provider: OPENAI_PROVIDER_ID,
      modelId: params.modelId,
      config: params.cfg,
      env: params.env,
    }) === CODEX_PLUGIN_ID
  );
}

/** Resolves effective runtime policy for one canonical provider/model route. */
export function configuredModelRouteNeedsCodex(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId?: string;
  route: ModelRoute;
}): boolean {
  if (normalizeProviderId(params.route.provider) !== OPENAI_PROVIDER_ID) {
    return false;
  }
  const runtime = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: OPENAI_PROVIDER_ID,
    modelId: params.route.modelId,
    agentId: params.agentId,
  }).policy?.id;
  return configuredRuntimeNeedsCodex({
    cfg: params.cfg,
    env: params.env,
    modelId: params.route.modelId,
    runtimeId: runtime,
  });
}

function resolveEffectiveSelectedModelRefs(params: { cfg: OpenClawConfig; agentId: string }): {
  complete: boolean;
  values: ReadonlySet<string>;
} {
  const { cfg, agentId } = params;
  const mainPrimaryRaw = resolveAgentEffectiveModelPrimary(cfg, agentId);
  const mainFallbacks =
    resolveAgentModelFallbacksOverride(cfg, agentId) ??
    resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const subagentPrimaryRaw =
    resolveSubagentConfiguredModelSelection({ cfg, agentId }) ?? mainPrimaryRaw;
  const subagentFallbacks =
    resolveEffectiveModelFallbacks({
      cfg,
      agentId,
      sessionKey: `agent:${agentId}:subagent:codex-diagnostic`,
      hasSessionModelOverride: true,
      modelOverrideSource: "auto",
    }) ?? [];
  const values = new Set<string>();
  for (const raw of [mainPrimaryRaw, ...mainFallbacks, subagentPrimaryRaw, ...subagentFallbacks]) {
    const value = raw?.trim();
    if (value) {
      values.add(value);
    }
  }
  return {
    complete: Boolean(mainPrimaryRaw?.trim() && subagentPrimaryRaw?.trim()),
    values,
  };
}

function configuredRefTargetsAgent(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  path: string;
  agentId: string;
}): boolean {
  const match = /^agents\.list\.(\d+)\./.exec(params.path);
  if (match) {
    const entry = (params.sourceConfigBeforeMigrations ?? params.cfg).agents?.list?.[
      Number(match[1])
    ];
    return Boolean(entry && normalizeAgentId(entry.id) === params.agentId);
  }
  const keyedMatch = /^agents\.entries\.([^.]+)\./.exec(params.path);
  return !keyedMatch || normalizeAgentId(keyedMatch[1] ?? "") === params.agentId;
}

function configuredRefIsEffectiveForAgent(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  path: string;
  value: string;
  agentId: string;
  selectedModelRefs: ReadonlySet<string>;
}): boolean {
  if (!configuredRefTargetsAgent(params)) {
    return false;
  }
  // Defaults may be shadowed by per-agent main/subagent selections. Keep only
  // refs the runtime's inheritance rules leave reachable for this agent.
  if (/^agents\.(?:defaults|list\.\d+)\.(?:model|subagents\.model)(?:\.|$)/.test(params.path)) {
    return params.selectedModelRefs.has(params.value);
  }
  const agent = resolveAgentConfig(params.cfg, params.agentId);
  if (params.path.endsWith(".heartbeat.model")) {
    const heartbeat =
      agent?.heartbeat?.model?.trim() || params.cfg.agents?.defaults?.heartbeat?.model?.trim();
    return heartbeat === params.value;
  }
  if (params.path.endsWith(".utilityModel")) {
    const utilityModel = (agent?.utilityModel ?? params.cfg.agents?.defaults?.utilityModel)?.trim();
    return utilityModel === params.value;
  }
  return true;
}

function configuredProviderPoliciesNeedCodex(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  agentIds: string[],
): boolean {
  for (const agentId of agentIds) {
    const genericPolicy = resolveModelRuntimePolicy({
      config: cfg,
      provider: OPENAI_PROVIDER_ID,
      agentId,
    }).policy;
    if (
      genericPolicy?.id?.trim() &&
      configuredRuntimeNeedsCodex({ cfg, env, runtimeId: genericPolicy.id })
    ) {
      return true;
    }
  }
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== OPENAI_PROVIDER_ID) {
      continue;
    }
    for (const model of providerConfig.models ?? []) {
      if (!model.agentRuntime?.id?.trim()) {
        continue;
      }
      const parsed = parseModelCatalogRef(model.id);
      const modelId = parsed?.provider === OPENAI_PROVIDER_ID ? parsed.modelId : model.id.trim();
      if (
        modelId &&
        modelId !== "*" &&
        agentIds.some((agentId) =>
          configuredModelRouteNeedsCodex({
            cfg,
            env,
            agentId,
            route: { provider: OPENAI_PROVIDER_ID, modelId },
          }),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function configuredModelRefsNeedCodex(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentIds: string[];
}): { complete: boolean; needsCodex: boolean } {
  const refs = collectConfiguredModelRefs(params.sourceConfigBeforeMigrations ?? params.cfg);
  let complete = true;
  for (const agentId of params.agentIds) {
    const selected = resolveEffectiveSelectedModelRefs({ cfg: params.cfg, agentId });
    complete &&= selected.complete;
    const primary = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId,
      manifestPlugins: [],
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: primary.provider,
      manifestPlugins: [],
    });
    for (const ref of refs) {
      if (
        !configuredRefIsEffectiveForAgent({
          cfg: params.cfg,
          sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
          path: ref.path,
          value: ref.value,
          agentId,
          selectedModelRefs: selected.values,
        })
      ) {
        continue;
      }
      const resolved = resolveModelRefFromString({
        cfg: params.cfg,
        raw: ref.value,
        defaultProvider: primary.provider,
        aliasIndex,
        allowManifestNormalization: false,
      });
      const route = resolved
        ? { provider: resolved.ref.provider, modelId: resolved.ref.model }
        : undefined;
      if (
        route &&
        configuredModelRouteNeedsCodex({ cfg: params.cfg, env: params.env, agentId, route })
      ) {
        return { complete, needsCodex: true };
      }
    }
  }
  return { complete, needsCodex: false };
}

function defaultOpenAiRouteNeedsCodex(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  agentIds: string[],
): boolean {
  return agentIds.some((agentId) => {
    const runtimeId = resolveModelRuntimePolicy({
      config: cfg,
      provider: OPENAI_PROVIDER_ID,
      agentId,
    }).policy?.id;
    return configuredRuntimeNeedsCodex({ cfg, env, runtimeId });
  });
}

function configNeedsCodexForOpenAi(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  sourceConfigBeforeMigrations?: OpenClawConfig,
): boolean {
  const agentIds = listAgentIds(cfg);
  const configuredRefs = configuredModelRefsNeedCodex({
    cfg,
    env,
    agentIds,
    sourceConfigBeforeMigrations,
  });
  if (configuredRefs.needsCodex) {
    return true;
  }
  if (configuredProviderPoliciesNeedCodex(cfg, env, agentIds)) {
    return true;
  }
  return configuredRefs.complete ? false : defaultOpenAiRouteNeedsCodex(cfg, env, agentIds);
}

/** Suppresses missing Codex diagnostics when no effective OpenAI route selects it. */
export function shouldSuppressMissingCodexPluginDiagnostics(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  sourceConfigBeforeMigrations?: OpenClawConfig,
): boolean {
  const entryEnabled = codexPluginEntryEnabled(cfg);
  if (entryEnabled === true) {
    return false;
  }
  // A disabled entry is an explicit opt-out; doctor reports selected-route conflicts.
  return (
    entryEnabled === false || !configNeedsCodexForOpenAi(cfg, env, sourceConfigBeforeMigrations)
  );
}
