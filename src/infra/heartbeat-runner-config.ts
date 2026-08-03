import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  listAgentIds,
  listAgentEntries,
  resolveAgentConfig,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveModelRefFromString, type ModelRef } from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  resolveHeartbeatPromptForResponseTool,
} from "../auto-reply/heartbeat.js";
import { resolveDefaultModel } from "../auto-reply/reply/directive-handling.defaults.js";
import { normalizeChatType, type ChatType } from "../channels/chat-type.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readStoredDeviceIdentityReadOnly } from "./device-identity-store.js";
import { loadOrCreateDeviceIdentity } from "./device-identity.js";
import { resolveActiveHoursTimezone } from "./heartbeat-active-hours.js";
import { resolveHeartbeatIntervalMs } from "./heartbeat-summary.js";
import type { HeartbeatWakeSource } from "./heartbeat-wake.js";

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
    return Math.max(1, Math.floor(agentDefaultTimeoutSeconds));
  }
  // The wake dispatcher awaits heartbeat turns serially. Keep unset heartbeat
  // timeouts tied to the cadence instead of the 48h built-in agent default.
  const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, heartbeat);
  if (!intervalMs) {
    return DEFAULT_HEARTBEAT_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS, Math.ceil(intervalMs / 1000)));
}

export type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
type HeartbeatAgent = {
  agentId: string;
  heartbeat?: HeartbeatConfig;
};

export function canHeartbeatDeliverCommitments(heartbeat?: HeartbeatConfig): boolean {
  return (normalizeOptionalString(heartbeat?.target) ?? "none") !== "none";
}

type ActiveHoursSchedule = {
  start?: string;
  end?: string;
  timezone: string;
};

export function resolveActiveHoursSchedule(
  cfg: OpenClawConfig,
  heartbeat?: HeartbeatConfig,
): ActiveHoursSchedule | undefined {
  const activeHours = heartbeat?.activeHours;
  if (!activeHours) {
    return undefined;
  }
  return {
    start: activeHours.start,
    end: activeHours.end,
    timezone: resolveActiveHoursTimezone(cfg, activeHours.timezone),
  };
}

export function activeHoursConfigMatch(a?: ActiveHoursSchedule, b?: ActiveHoursSchedule): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.start === b.start && a.end === b.end && a.timezone === b.timezone;
}

export function resolveHeartbeatSchedulerSeed(
  explicitSeed?: string,
  options: { env?: NodeJS.ProcessEnv; readOnly?: boolean } = {},
) {
  const normalized = normalizeOptionalString(explicitSeed);
  if (normalized) {
    return normalized;
  }
  const env = options.env ?? process.env;
  try {
    const identity = options.readOnly
      ? readStoredDeviceIdentityReadOnly({ env })
      : loadOrCreateDeviceIdentity({ env });
    if (identity) {
      return identity.deviceId;
    }
  } catch {
    // A deterministic fallback keeps scheduling available when identity state
    // is absent or unreadable; read-only Doctor previews never create it.
  }
  return createHash("sha256")
    .update(env.HOME ?? "")
    .update("\0")
    .update(process.cwd())
    .digest("hex");
}

function hasExplicitHeartbeatAgents(cfg: OpenClawConfig) {
  const list = listAgentEntries(cfg);
  return list.some((entry) => Boolean(entry?.heartbeat));
}

function resolveHeartbeatConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = cfg.agents?.defaults?.heartbeat;
  if (!agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(cfg, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

export function resolveAmbientHeartbeatAgentId(cfg: OpenClawConfig): string {
  const configured = normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId);
  return normalizeAgentId(configured ?? resolveDefaultAgentId(cfg));
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

export function resolveHeartbeatAgents(cfg: OpenClawConfig): HeartbeatAgent[] {
  const list = listAgentEntries(cfg);
  if (hasExplicitHeartbeatAgents(cfg)) {
    return list
      .filter((entry) => entry?.heartbeat)
      .map((entry) => {
        const id = normalizeAgentId(entry.id);
        return { agentId: id, heartbeat: resolveHeartbeatConfig(cfg, id) };
      })
      .filter((entry) => entry.agentId);
  }
  const configuredAgentId = normalizeOptionalString(cfg.agents?.defaults?.heartbeat?.agentId);
  if (configuredAgentId) {
    const agentId = normalizeAgentId(configuredAgentId);
    return [{ agentId, heartbeat: resolveHeartbeatConfig(cfg, agentId) }];
  }
  if (cfg.agents?.defaults?.heartbeat) {
    return listAgentIds(cfg).map((agentId) => ({
      agentId,
      heartbeat: resolveHeartbeatConfig(cfg, agentId),
    }));
  }
  const fallbackId = resolveAmbientHeartbeatAgentId(cfg);
  return [{ agentId: fallbackId, heartbeat: resolveHeartbeatConfig(cfg, fallbackId) }];
}

function resolveHeartbeatPromptRaw(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
  return heartbeat?.prompt ?? cfg.agents?.defaults?.heartbeat?.prompt;
}

export function resolveHeartbeatPrompt(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig) {
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

export function resolveHeartbeatAckMaxChars(_cfg: OpenClawConfig, _heartbeat?: HeartbeatConfig) {
  return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
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
