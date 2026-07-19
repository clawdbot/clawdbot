/** Applies agent compaction settings and small-context overflow guards. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AgentCompactionMode } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineInfo } from "../context-engine/types.js";
import { MIN_PROMPT_BUDGET_RATIO, MIN_PROMPT_BUDGET_TOKENS } from "./agent-compaction-constants.js";
import { resolveProviderEndpoint } from "./provider-attribution.js";

export const DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;

type AgentSettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/** Applies configured compaction reserve/keep-recent settings to an agent settings manager. */
export function applyAgentCompactionSettingsFromConfig(params: {
  settingsManager: AgentSettingsManagerLike;
  cfg?: OpenClawConfig;
  /** When known, the resolved context window budget for the current model. */
  contextTokenBudget?: number;
}): {
  didOverride: boolean;
  compaction: { reserveTokens: number; keepRecentTokens: number };
} {
  const currentReserveTokens = params.settingsManager.getCompactionReserveTokens();
  const currentKeepRecentTokens = params.settingsManager.getCompactionKeepRecentTokens();
  const compactionCfg = params.cfg?.agents?.defaults?.compaction;

  const configuredKeepRecentTokens = toPositiveInt(compactionCfg?.keepRecentTokens);
  let reserveTokensFloor = DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR;
  let maxReserveTokens: number | undefined;

  // Cap the floor to a safe fraction of the context window so that
  // small-context models (e.g. Ollama with 16 K tokens) are not starved of
  // prompt budget.  Without this cap the default floor of 20 000 can exceed
  // the entire context window, causing every prompt to be classified as an
  // overflow and triggering an infinite compaction loop.
  const contextTokenBudget = toPositiveInt(params.contextTokenBudget);
  if (contextTokenBudget !== undefined) {
    const minPromptBudget = Math.min(
      MIN_PROMPT_BUDGET_TOKENS,
      Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
    );
    maxReserveTokens = Math.max(0, contextTokenBudget - minPromptBudget);
    reserveTokensFloor = Math.min(reserveTokensFloor, maxReserveTokens);
  }

  let targetReserveTokens = Math.max(currentReserveTokens, reserveTokensFloor);
  if (maxReserveTokens !== undefined) {
    // Cap the effective value too: the harness default or explicit config can otherwise
    // undo the floor cap and make shouldCompact() true from the first token.
    targetReserveTokens = Math.min(targetReserveTokens, maxReserveTokens);
  }
  const targetKeepRecentTokens = configuredKeepRecentTokens ?? currentKeepRecentTokens;

  const overrides: { reserveTokens?: number; keepRecentTokens?: number } = {};
  if (targetReserveTokens !== currentReserveTokens) {
    overrides.reserveTokens = targetReserveTokens;
  }
  if (targetKeepRecentTokens !== currentKeepRecentTokens) {
    overrides.keepRecentTokens = targetKeepRecentTokens;
  }

  const didOverride = Object.keys(overrides).length > 0;
  if (didOverride) {
    params.settingsManager.applyOverrides({ compaction: overrides });
  }

  return {
    didOverride,
    compaction: {
      reserveTokens: targetReserveTokens,
      keepRecentTokens: targetKeepRecentTokens,
    },
  };
}

/** Resolve the compaction mode after provider-backed safeguard promotion. */
export function resolveEffectiveCompactionMode(cfg?: OpenClawConfig): AgentCompactionMode {
  const compaction = cfg?.agents?.defaults?.compaction;
  if (compaction?.provider) {
    return "safeguard";
  }
  return compaction?.mode === "safeguard" ? "safeguard" : "default";
}

/** Resolve whether proactive embedded auto-compaction is enabled (default: true). */
export function resolveCompactionEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.enabled !== false;
}

/**
 * Detect providers whose shared model runtime `isContextOverflow` Case 2 (silent overflow)
 * fires on a successful turn and triggers OpenClaw runtime's `_runAutoCompaction` from
 * inside `Session.prompt()`, collapsing `agent.state.messages` before the
 * provider call (openclaw#75799).
 *
 * True on any of: `zai-native` endpoint class, normalized provider id `zai`,
 * a `z-ai/` / `openrouter/z-ai/` model-id namespace prefix, or a bare `glm-`
 * model id (no namespace prefix) — the latter covers in-house gateways that
 * expose Zhipu's GLM family directly without a `z-ai/` qualifier. Intentionally
 * narrow: namespaced GLM ids that route through other providers (e.g.
 * `ollama/glm-*`, `opencode-go/glm-*`) are NOT included because their hosts
 * have their own overflow accounting and may not exhibit the z.ai silent-
 * overflow shape. Other providers documented as silently truncating are not
 * added without a reproducible repro.
 */
export function isSilentOverflowProneModel(model: {
  provider?: string | null;
  modelId?: string | null;
  baseUrl?: string | null;
}): boolean {
  const provider = normalizeProviderId(typeof model.provider === "string" ? model.provider : "");
  if (provider === "zai") {
    return true;
  }
  if (typeof model.baseUrl === "string" && model.baseUrl.length > 0) {
    if (resolveProviderEndpoint(model.baseUrl).endpointClass === "zai-native") {
      return true;
    }
  }
  if (typeof model.modelId === "string" && model.modelId.length > 0) {
    const normalized = model.modelId.toLowerCase();
    if (
      normalized.startsWith("z-ai/") ||
      normalized.startsWith("openrouter/z-ai/") ||
      normalized.startsWith("glm-")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Disable OpenClaw runtime's `_checkCompaction → _runAutoCompaction` (which would otherwise
 * fire from inside `Session.prompt()` and reassign `agent.state.messages`
 * before the provider call) when OpenClaw or a plugin owns compaction:
 * `contextEngineInfo.ownsCompaction === true`, effective safeguard compaction,
 * an active model that is silent-overflow-prone (openclaw#75799), or
 * `agents.defaults.compaction.enabled: false`.
 * Default-mode runs against ordinary providers keep OpenClaw runtime's auto-compaction as
 * the existing baseline. Overflow recovery and OpenClaw preemptive overflow handling stay
 * available when config disables only proactive auto-compaction.
 */
function shouldDisableAgentAutoCompaction(params: {
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
  silentOverflowProneProvider?: boolean;
  compactionEnabled?: boolean;
}): boolean {
  return (
    params.compactionEnabled === false ||
    params.contextEngineInfo?.ownsCompaction === true ||
    params.compactionMode === "safeguard" ||
    params.silentOverflowProneProvider === true
  );
}

/**
 * Apply the auto-compaction guard. Callers that reload a `DefaultResourceLoader`
 * MUST call this AGAIN after each `reload()` — `settingsManager.reload()`
 * rehydrates `compaction.enabled` from disk and silently restores OpenClaw runtime's
 * default-on behavior, undoing the guard. Mirrors the existing
 * `applyAgentCompactionSettingsFromConfig` re-call pattern at the same sites.
 */
export function applyAgentAutoCompactionGuard(params: {
  settingsManager: AgentSettingsManagerLike;
  contextEngineInfo?: ContextEngineInfo;
  compactionMode?: AgentCompactionMode;
  silentOverflowProneProvider?: boolean;
  /** When false, disable proactive embedded auto-compaction from config. */
  compactionEnabled?: boolean;
}): { supported: boolean; disabled: boolean } {
  const disable = shouldDisableAgentAutoCompaction({
    contextEngineInfo: params.contextEngineInfo,
    compactionMode: params.compactionMode,
    silentOverflowProneProvider: params.silentOverflowProneProvider,
    compactionEnabled: params.compactionEnabled,
  });
  const hasMethod = typeof params.settingsManager.setCompactionEnabled === "function";
  if (!disable || !hasMethod) {
    return { supported: hasMethod, disabled: false };
  }
  params.settingsManager.setCompactionEnabled!(false);
  return { supported: true, disabled: true };
}
