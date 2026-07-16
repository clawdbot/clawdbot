// Resolves the utility model used for short internal tasks (titles, progress
// narration). Unset config derives the provider-declared small model from the
// agent's primary provider; an explicit empty string disables utility routing.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

type UtilityModelSetting =
  | { kind: "explicit"; modelRef: string }
  | { kind: "disabled" }
  | { kind: "auto" };

/**
 * Reads the configured utility-model setting. A defined-but-empty value is an
 * explicit opt-out ("disabled"), distinct from unset ("auto"); the agent-level
 * value wins over defaults even when it is the empty string.
 */
export function readUtilityModelSetting(cfg: OpenClawConfig, agentId: string): UtilityModelSetting {
  const value =
    resolveAgentConfig(cfg, agentId)?.utilityModel ?? cfg.agents?.defaults?.utilityModel;
  if (value === undefined) {
    return { kind: "auto" };
  }
  const trimmed = value.trim();
  return trimmed ? { kind: "explicit", modelRef: trimmed } : { kind: "disabled" };
}

/**
 * Provider-declared default utility model (manifest
 * `modelCatalog.providers.<id>.defaultUtilityModel`), or undefined when the
 * provider does not declare one. Reads only the process-current plugin
 * metadata snapshot, so the lookup stays synchronous and cheap; contexts
 * without a snapshot simply get no derived default.
 */
function resolveProviderDefaultUtilityModelRef(params: {
  cfg: OpenClawConfig;
  provider: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): string | undefined {
  const provider = params.provider.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }
  const snapshot =
    params.metadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: params.cfg,
      allowWorkspaceScopedSnapshot: true,
    });
  if (!snapshot) {
    return undefined;
  }
  for (const plugin of snapshot.plugins) {
    const defaultUtilityModel = plugin.modelCatalog?.providers?.[provider]?.defaultUtilityModel;
    const modelId = defaultUtilityModel?.trim();
    if (modelId) {
      return `${provider}/${modelId}`;
    }
  }
  return undefined;
}

/**
 * The utility model ref to use for the agent, or undefined when utility
 * routing is disabled or no default exists. Derivation uses the agent's
 * primary provider, so usable auth is already established by construction.
 */
export function resolveUtilityModelRefForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Pass when the caller already resolved the primary provider. */
  primaryProvider?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
}): string | undefined {
  const setting = readUtilityModelSetting(params.cfg, params.agentId);
  if (setting.kind === "explicit") {
    return setting.modelRef;
  }
  if (setting.kind === "disabled") {
    return undefined;
  }
  const provider =
    params.primaryProvider?.trim() ||
    resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId }).provider;
  if (!provider) {
    return undefined;
  }
  const derived = resolveProviderDefaultUtilityModelRef({
    cfg: params.cfg,
    provider,
    metadataSnapshot: params.metadataSnapshot,
  });
  if (!derived) {
    return undefined;
  }
  // The derived default shares the primary's provider, so a trailing auth
  // profile on the primary ref must carry over; otherwise profile-isolated
  // setups would route utility calls through default credentials.
  const primaryRef = resolveAgentEffectiveModelPrimary(params.cfg, params.agentId) ?? "";
  const primaryProfile = primaryRef ? splitTrailingAuthProfile(primaryRef)?.profile : undefined;
  return primaryProfile ? `${derived}@${primaryProfile}` : derived;
}
