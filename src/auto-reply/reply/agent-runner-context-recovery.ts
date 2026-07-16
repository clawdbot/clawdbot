import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const DEFAULT_RESERVE_TOKENS_FLOOR = 20_000;

/** Computes a reserve-token floor scaled to the selected context window. */
function computeContextAwareReserveTokensFloor(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || contextWindow <= 0) {
    return DEFAULT_RESERVE_TOKENS_FLOOR;
  }
  if (contextWindow >= 1_000_000) {
    return 100_000;
  }
  if (contextWindow >= 200_000) {
    return 50_000;
  }
  if (contextWindow >= 100_000) {
    return 35_000;
  }
  return DEFAULT_RESERVE_TOKENS_FLOOR;
}

function resolveContextWindowForCompactionHint(params: {
  cfg: FollowupRun["run"]["config"];
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  agentId?: string;
  activeSessionEntry?: SessionEntry;
}): number | undefined {
  let modelWindow: number | undefined;
  const entryProvider = params.activeSessionEntry?.modelProvider;
  const entryModel = params.activeSessionEntry?.model;
  const runtimeProvider = params.runtimeProvider ?? entryProvider;
  const runtimeModel = params.runtimeModel ?? entryModel;
  const hasExplicitRuntimeRef = Boolean(params.runtimeProvider && params.runtimeModel);
  if (runtimeProvider && runtimeModel) {
    const resolved = resolveContextTokensForModel({
      cfg: params.cfg,
      provider: runtimeProvider,
      model: runtimeModel,
      allowAsyncLoad: false,
    });
    if (typeof resolved === "number" && resolved > 0) {
      modelWindow = resolved;
    }
  }
  const sessionWindow = normalizePositiveContextTokens(params.activeSessionEntry?.contextTokens);
  const sessionMatchesRuntimeRef = runtimeProvider === entryProvider && runtimeModel === entryModel;
  const trustedSessionWindow =
    !hasExplicitRuntimeRef || sessionMatchesRuntimeRef ? sessionWindow : undefined;
  if (modelWindow === undefined && sessionMatchesRuntimeRef && sessionWindow !== undefined) {
    modelWindow = sessionWindow;
  }
  if (
    modelWindow === undefined &&
    !hasExplicitRuntimeRef &&
    params.primaryProvider &&
    params.primaryModel
  ) {
    const resolved = resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.primaryProvider,
      model: params.primaryModel,
      allowAsyncLoad: false,
    });
    if (typeof resolved === "number" && resolved > 0) {
      modelWindow = resolved;
    }
  }
  const contextWindow = modelWindow ?? trustedSessionWindow;
  const agentCap = resolveAgentContextTokensForHint({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (agentCap !== undefined && contextWindow !== undefined) {
    return Math.min(agentCap, contextWindow);
  }
  return agentCap ?? contextWindow;
}

function buildContextOverflowResetHint(contextWindowTokens: number | undefined): string {
  const reserveFloor = computeContextAwareReserveTokensFloor(contextWindowTokens);
  return (
    "\n\nTo prevent this, increase your compaction buffer by setting " +
    `\`agents.defaults.compaction.reserveTokensFloor\` to ${reserveFloor} or higher in your config.`
  );
}

type ModelRefLike = {
  provider: string;
  model: string;
};

function resolveAgentHeartbeatModelRaw(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
}): string | undefined {
  const defaultModel = normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model);
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentModel = agentId
    ? normalizeOptionalString(
        params.cfg.agents?.list?.find(
          (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId,
        )?.heartbeat?.model,
      )
    : undefined;
  return agentModel ?? defaultModel;
}

function normalizeModelRefForCompare(ref: ModelRefLike | undefined) {
  if (!ref) {
    return undefined;
  }
  const provider = normalizeLowercaseStringOrEmpty(ref.provider);
  const model = normalizeLowercaseStringOrEmpty(ref.model);
  return provider && model ? { provider, model } : undefined;
}

function modelRefsEqual(left: ModelRefLike | undefined, right: ModelRefLike | undefined) {
  const normalizedLeft = normalizeModelRefForCompare(left);
  const normalizedRight = normalizeModelRefForCompare(right);
  return (
    normalizedLeft !== undefined &&
    normalizedRight !== undefined &&
    normalizedLeft.provider === normalizedRight.provider &&
    normalizedLeft.model === normalizedRight.model
  );
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  }
  return `${Math.round(tokens / 1024)}k`;
}

function normalizePositiveContextTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveAgentContextTokensForHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
}): number | undefined {
  const defaultContextTokens = normalizePositiveContextTokens(
    params.cfg.agents?.defaults?.contextTokens,
  );
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentContextTokens = agentId
    ? normalizePositiveContextTokens(
        params.cfg.agents?.list?.find(
          (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === agentId,
        )?.contextTokens,
      )
    : undefined;
  return agentContextTokens ?? defaultContextTokens;
}

function resolveContextWindowForHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  ref: ModelRefLike;
  activeSessionEntry?: SessionEntry;
}) {
  const sessionContextTokens = normalizePositiveContextTokens(
    params.activeSessionEntry?.contextTokens,
  );
  const modelContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.ref.provider,
    model: params.ref.model,
    allowAsyncLoad: false,
  });
  const contextTokens = modelContextTokens ?? sessionContextTokens;
  if (contextTokens === undefined) {
    return undefined;
  }
  const agentContextTokens = resolveAgentContextTokensForHint({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return agentContextTokens !== undefined
    ? Math.min(agentContextTokens, contextTokens)
    : contextTokens;
}

function resolveHeartbeatBleedHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  activeSessionEntry?: SessionEntry;
}): string | undefined {
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  const runtimeProvider = normalizeOptionalString(params.activeSessionEntry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.activeSessionEntry?.model);
  if (!primaryProvider || !primaryModel || !runtimeProvider || !runtimeModel) {
    return undefined;
  }

  const primaryRef = { provider: primaryProvider, model: primaryModel };
  const runtimeRef = { provider: runtimeProvider, model: runtimeModel };
  if (modelRefsEqual(primaryRef, runtimeRef)) {
    return undefined;
  }
  const heartbeatModelRaw = resolveAgentHeartbeatModelRaw({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRef = heartbeatModelRaw
    ? resolveModelRefFromString({
        cfg: params.cfg,
        raw: heartbeatModelRaw,
        defaultProvider: primaryProvider,
      })?.ref
    : undefined;
  if (!modelRefsEqual(runtimeRef, heartbeatRef)) {
    return undefined;
  }

  const runtimeWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    agentId: params.agentId,
    ref: runtimeRef,
    activeSessionEntry: params.activeSessionEntry,
  });
  const primaryWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    agentId: params.agentId,
    ref: primaryRef,
  });
  if (
    typeof runtimeWindow === "number" &&
    typeof primaryWindow === "number" &&
    runtimeWindow >= primaryWindow
  ) {
    return undefined;
  }

  const runtimeLabel =
    typeof runtimeWindow === "number" && runtimeWindow > 0
      ? ` (${formatContextWindowLabel(runtimeWindow)} context)`
      : "";
  return (
    `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}` +
    `${runtimeLabel} instead of ${primaryProvider}/${primaryModel}. This matches the configured ` +
    "`heartbeat.model`, so the overflow is likely heartbeat model bleed rather than a " +
    "compaction-buffer problem. Set `heartbeat.isolatedSession: true`, enable " +
    "`heartbeat.lightContext: true`, or use a heartbeat model with a larger context window."
  );
}

/** Builds recovery instructions for context-overflow failures. */
export function buildContextOverflowRecoveryText(params: {
  duringCompaction?: boolean;
  preserveSessionMapping?: boolean;
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  activeSessionEntry?: SessionEntry;
}): string {
  const prefix = params.preserveSessionMapping
    ? "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session."
    : params.duringCompaction
      ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again."
      : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.";
  const primaryContextWindow = resolveContextWindowForCompactionHint({
    cfg: params.cfg,
    primaryProvider: params.primaryProvider,
    primaryModel: params.primaryModel,
    runtimeProvider: params.runtimeProvider,
    runtimeModel: params.runtimeModel,
    agentId: params.agentId,
    activeSessionEntry: params.activeSessionEntry,
  });
  const explicitRuntimeMatchesSession =
    !params.runtimeProvider ||
    !params.runtimeModel ||
    (params.runtimeProvider === params.activeSessionEntry?.modelProvider &&
      params.runtimeModel === params.activeSessionEntry?.model);
  const heartbeatBleedHint = explicitRuntimeMatchesSession
    ? resolveHeartbeatBleedHint({
        cfg: params.cfg,
        agentId: params.agentId,
        primaryProvider: params.primaryProvider,
        primaryModel: params.primaryModel,
        activeSessionEntry: params.activeSessionEntry,
      })
    : undefined;
  return prefix + (heartbeatBleedHint ?? buildContextOverflowResetHint(primaryContextWindow));
}
