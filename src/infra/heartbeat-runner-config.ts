import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveModelRefFromString, type ModelRef } from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import {
  resolveHeartbeatPromptCore as resolveHeartbeatPromptText,
  resolveHeartbeatPromptForResponseTool,
} from "../auto-reply/heartbeat.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import {
  type HeartbeatConfig,
  resolveHeartbeatConfig,
  resolveHeartbeatIntervalMs,
} from "./heartbeat-config.js";
import type { HeartbeatWakeSource } from "./heartbeat-wake.js";

export {
  isHeartbeatOwnerUnresolved,
  resolveHeartbeatAgents,
  resolveHeartbeatIntervalMs,
  type HeartbeatConfig,
} from "./heartbeat-config.js";
export { resolveHeartbeatSchedulerSeed } from "./heartbeat-schedule.js";

export const heartbeatLog = createSubsystemLogger("gateway/heartbeat");

const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 10 * 60;

export function resolveHeartbeatChannelPlugin(channel: string): ChannelPlugin | undefined {
  const activePlugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  return activePlugin ?? getChannelPlugin(channel as ChannelId);
}

export function resolveHeartbeatTimeoutOverrideSeconds(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
) {
  if (typeof heartbeat?.timeoutSeconds === "number") {
    return heartbeat.timeoutSeconds;
  }
  const agentDefaultTimeoutSeconds = cfg.agents?.defaults?.timeoutSeconds;
  if (
    typeof agentDefaultTimeoutSeconds === "number" &&
    Number.isFinite(agentDefaultTimeoutSeconds)
  ) {
    // Preserve the unlimited sentinel consumed by resolveAgentTimeoutMs.
    return agentDefaultTimeoutSeconds === 0
      ? 0
      : Math.max(1, Math.floor(agentDefaultTimeoutSeconds));
  }
  // The wake dispatcher awaits heartbeat turns serially. Keep unset heartbeat
  // timeouts tied to the cadence instead of the 48h built-in agent default.
  const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, heartbeat);
  if (!intervalMs) {
    return DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, Math.ceil(intervalMs / 1000)));
}

function omitExplicitHeartbeatDestination(heartbeat: HeartbeatConfig | undefined) {
  if (!heartbeat) {
    return undefined;
  }
  const next = { ...heartbeat };
  delete next.to;
  delete next.accountId;
  return next;
}

export function resolveHeartbeatForWake(params: {
  cfg: OpenClawConfig;
  agentId: string;
  configuredHeartbeat?: HeartbeatConfig;
  requestedHeartbeat?: HeartbeatConfig;
  source?: HeartbeatWakeSource;
  mergeRequestedHeartbeat: boolean;
}): HeartbeatConfig | undefined {
  const base = params.configuredHeartbeat ?? resolveHeartbeatConfig(params.cfg, params.agentId);
  const heartbeat =
    params.requestedHeartbeat && params.mergeRequestedHeartbeat
      ? { ...base, ...params.requestedHeartbeat }
      : (params.requestedHeartbeat ?? base);
  return params.source === "cron" && params.requestedHeartbeat?.target === "last"
    ? omitExplicitHeartbeatDestination(heartbeat)
    : heartbeat;
}

function resolveHeartbeatPromptRaw(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt;
}

export function resolveConfiguredHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return resolveHeartbeatPromptText(resolveHeartbeatPromptRaw(cfg, heartbeat));
}

export function resolveHeartbeatResponseToolPrompt(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
) {
  return resolveHeartbeatPromptForResponseTool(resolveHeartbeatPromptRaw(cfg, heartbeat));
}

function resolveHeartbeatModelRef(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
}): ModelRef {
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const heartbeatRaw =
    normalizeOptionalString(params.heartbeat?.model) ??
    normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model) ??
    "";
  const heartbeatRef = heartbeatRaw
    ? resolveModelRefFromString({
        raw: heartbeatRaw,
        defaultProvider,
        aliasIndex,
      })?.ref
    : undefined;
  if (heartbeatRef) {
    return heartbeatRef;
  }
  return {
    provider:
      normalizeOptionalString(params.entry?.providerOverride) ??
      normalizeOptionalString(params.entry?.modelProvider) ??
      defaultProvider,
    model:
      normalizeOptionalString(params.entry?.modelOverride) ??
      normalizeOptionalString(params.entry?.model) ??
      defaultModel,
  };
}

function usesCodexHarness(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
  sessionKey?: string;
}): boolean {
  const modelRef = resolveHeartbeatModelRef(params);
  return (
    resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: modelRef.provider,
      modelId: modelRef.model,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionEntry: params.entry,
    }) === "codex"
  );
}

export function shouldUseHeartbeatResponseToolPrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  chatType?: ChatType;
}): boolean {
  const chatType = normalizeChatType(params.chatType);
  const visibleReplies =
    chatType === "group" || chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  if (visibleReplies === "message_tool") {
    return true;
  }
  if (visibleReplies === "automatic") {
    return false;
  }
  return usesCodexHarness(params);
}

export function isHeartbeatTypingEnabled(params: {
  cfg: OpenClawConfig;
  agentId: string;
  hasChatDelivery: boolean;
}) {
  if (!params.hasChatDelivery) {
    return false;
  }
  const typingMode =
    resolveAgentConfig(params.cfg, params.agentId)?.typingMode ??
    params.cfg.agents?.defaults?.typingMode;
  return typingMode !== "never";
}

export function resolveHeartbeatTypingIntervalSeconds(cfg: OpenClawConfig) {
  const configured = cfg.agents?.defaults?.typingIntervalSeconds;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}
export { tryResolveAmbientHeartbeatAgentId } from "./heartbeat-agent-resolution.js";
