// Builds diagnostics for Codex plugin config and provider wiring.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  AUTO_AGENT_RUNTIME_ID,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { openAIProviderUsesCodexRuntimeByDefault } from "../agents/openai-routing.js";
import type { AgentModelEntryConfig } from "./types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "./types.agents-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const CODEX_PLUGIN_ID = "codex";
const OPENAI_PROVIDER_ID = "openai";

function normalizeRuntimeId(raw?: string | null): string | undefined {
  return normalizeOptionalAgentRuntimeId(raw);
}

function isCodexRuntimeSelection(raw?: string | null): boolean {
  return normalizeRuntimeId(raw) === CODEX_PLUGIN_ID;
}

function isOpenAiCodexDefaultRuntimeSelection(params: {
  cfg: OpenClawConfig;
  raw?: string | null;
}): boolean {
  const runtime = normalizeRuntimeId(params.raw);
  if (runtime === CODEX_PLUGIN_ID) {
    return true;
  }
  if (runtime !== AUTO_AGENT_RUNTIME_ID && runtime !== "default") {
    return false;
  }
  // "auto"/"default" only means Codex for the official OpenAI route.
  // Custom OpenAI-compatible base URLs stay on the OpenClaw runtime path.
  return openAIProviderUsesCodexRuntimeByDefault({
    provider: OPENAI_PROVIDER_ID,
    config: params.cfg,
  });
}

function parseProviderModelRef(raw: string): { provider: string; model: string } | null {
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= raw.length - 1) {
    return null;
  }
  const provider = normalizeProviderId(raw.slice(0, slashIndex));
  const model = raw.slice(slashIndex + 1).trim();
  return provider && model ? { provider, model } : null;
}

function codexPluginEntryEnabled(cfg: OpenClawConfig): boolean | undefined {
  for (const [pluginId, entry] of Object.entries(cfg.plugins?.entries ?? {})) {
    if (normalizeLowercaseStringOrEmpty(pluginId) === CODEX_PLUGIN_ID) {
      return entry?.enabled;
    }
  }
  return undefined;
}

function openAiProviderRuntimePolicy(cfg: OpenClawConfig): AgentRuntimePolicyConfig | undefined {
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) === OPENAI_PROVIDER_ID) {
      return providerConfig?.agentRuntime?.id?.trim() ? providerConfig.agentRuntime : undefined;
    }
  }
  return undefined;
}

function listConfiguredAgentIds(cfg: OpenClawConfig): Array<string | undefined> {
  const ids: Array<string | undefined> = [undefined];
  for (const agent of cfg.agents?.list ?? []) {
    if (typeof agent.id === "string" && agent.id.trim()) {
      ids.push(agent.id);
    }
  }
  return ids;
}

function openAiProviderModelCanResolveToCodexDefault(params: {
  cfg: OpenClawConfig;
  modelId: string;
}): boolean {
  // Provider model rows are below exact agent model policies in runtime
  // precedence, so inspect the resolved policy instead of the raw row.
  return listConfiguredAgentIds(params.cfg).some((agentId) =>
    isOpenAiCodexDefaultRuntimeSelection({
      cfg: params.cfg,
      raw: resolveModelRuntimePolicy({
        config: params.cfg,
        provider: OPENAI_PROVIDER_ID,
        modelId: params.modelId,
        agentId,
      }).policy?.id,
    }),
  );
}

function openAiHasCodexDefaultRuntimePolicy(cfg: OpenClawConfig): boolean {
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== OPENAI_PROVIDER_ID) {
      continue;
    }
    if (isCodexRuntimeSelection(providerConfig?.agentRuntime?.id)) {
      return true;
    }
    // A model-scoped explicit "auto"/"default" overrides provider-wide PI/OpenClaw
    // policy and falls back to the official OpenAI Codex runtime default.
    if (
      providerConfig?.models?.some(
        (model) =>
          model.agentRuntime?.id?.trim() &&
          openAiProviderModelCanResolveToCodexDefault({ cfg, modelId: model.id }),
      )
    ) {
      return true;
    }
  }
  if (agentModelsHaveCodexDefaultRuntimePolicy(cfg, cfg.agents?.defaults?.models)) {
    return true;
  }
  return (
    cfg.agents?.list?.some((agent) =>
      agentModelsHaveCodexDefaultRuntimePolicy(cfg, agent.models),
    ) ?? false
  );
}

function agentModelsHaveCodexDefaultRuntimePolicy(
  cfg: OpenClawConfig,
  models: Record<string, AgentModelEntryConfig> | undefined,
): boolean {
  for (const [modelRef, modelConfig] of Object.entries(models ?? {})) {
    const parsed = parseProviderModelRef(modelRef);
    if (
      parsed?.provider === OPENAI_PROVIDER_ID &&
      isOpenAiCodexDefaultRuntimeSelection({
        cfg,
        raw: modelConfig?.agentRuntime?.id,
      })
    ) {
      return true;
    }
  }
  return false;
}

function openAiWildcardRuntimePolicy(
  models: Record<string, AgentModelEntryConfig> | undefined,
): AgentRuntimePolicyConfig | undefined {
  for (const [modelRef, modelConfig] of Object.entries(models ?? {})) {
    const parsed = parseProviderModelRef(modelRef);
    if (
      parsed?.provider === OPENAI_PROVIDER_ID &&
      parsed.model === "*" &&
      modelConfig?.agentRuntime?.id?.trim()
    ) {
      return modelConfig.agentRuntime;
    }
  }
  return undefined;
}

function openAiDefaultRouteRuntimePolicy(
  cfg: OpenClawConfig,
): AgentRuntimePolicyConfig | undefined {
  // This mirrors the default-route slice of resolveModelRuntimePolicy: a global
  // OpenAI wildcard policy is more specific than the provider-level policy.
  return (
    openAiWildcardRuntimePolicy(cfg.agents?.defaults?.models) ?? openAiProviderRuntimePolicy(cfg)
  );
}

function openAiDefaultRouteKeepsCodexUnavailable(cfg: OpenClawConfig): boolean {
  const policy = openAiDefaultRouteRuntimePolicy(cfg);
  if (!policy?.id?.trim()) {
    // With no explicit runtime policy, the OpenAI route only needs Codex on the
    // official OpenAI endpoint. OpenAI-compatible proxies stay on OpenClaw.
    return !openAIProviderUsesCodexRuntimeByDefault({
      provider: OPENAI_PROVIDER_ID,
      config: cfg,
    });
  }
  // Any explicit default-route policy that does not resolve to Codex keeps the
  // external Codex plugin optional, including custom OpenAI-compatible base URLs.
  return !isOpenAiCodexDefaultRuntimeSelection({ cfg, raw: policy.id });
}

/**
 * Reports whether the default OpenAI route intentionally avoids the Codex plugin.
 *
 * Route-specific Codex selections still win; this only answers the missing-plugin
 * diagnostic question for OpenAI defaults and OpenAI-compatible proxy configs.
 */
export function configExplicitlyKeepsCodexUnavailableForOpenAi(cfg: OpenClawConfig): boolean {
  if (openAiHasCodexDefaultRuntimePolicy(cfg)) {
    return false;
  }
  return openAiDefaultRouteKeepsCodexUnavailable(cfg);
}

/**
 * Suppresses missing Codex plugin diagnostics when config makes Codex optional.
 *
 * Explicitly enabled entries still warn so operator intent is honored even when
 * all default routes would otherwise stay on the OpenClaw runtime.
 */
export function shouldSuppressMissingCodexPluginDiagnostics(cfg: OpenClawConfig): boolean {
  const entryEnabled = codexPluginEntryEnabled(cfg);
  if (entryEnabled === true) {
    return false;
  }
  // A disabled entry is an explicit opt-out from the external Codex plugin.
  // Route-specific Codex warnings still come from doctor when Codex is selected.
  return entryEnabled === false || configExplicitlyKeepsCodexUnavailableForOpenAi(cfg);
}
