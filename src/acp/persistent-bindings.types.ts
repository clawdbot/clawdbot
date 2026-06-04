/** Types and normalization helpers for configured channel-to-ACP persistent bindings. */
import { createHash } from "node:crypto";
import { normalizeText } from "@openclaw/acp-core/normalize-text";
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { sanitizeAgentId } from "../routing/session-key.js";

export { normalizeText } from "@openclaw/acp-core/normalize-text";

export type ConfiguredAcpBindingChannel = ChannelId;

/** Normalized configured binding that maps one channel conversation to one ACP session. */
export type ConfiguredAcpBindingSpec = {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  /** Owning OpenClaw agent id (used for session identity/storage). */
  agentId: string;
  /** ACP harness agent id override (falls back to agentId when omitted). */
  acpAgentId?: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  backend?: string;
  label?: string;
};

export type ResolvedConfiguredAcpBinding = {
  spec: ConfiguredAcpBindingSpec;
  record: SessionBindingRecord;
};

type AcpBindingConfigShape = {
  mode?: string;
  cwd?: string;
  backend?: string;
  label?: string;
};

/** Normalizes binding mode, defaulting to persistent sessions. */
export function normalizeMode(value: unknown): AcpRuntimeSessionMode {
  const raw = normalizeOptionalLowercaseString(value);
  return raw === "oneshot" ? "oneshot" : "persistent";
}

/** Extracts supported ACP binding config keys from unknown plugin config. */
export function normalizeBindingConfig(raw: unknown): AcpBindingConfigShape {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const shape = raw as AcpBindingConfigShape;
  const mode = normalizeText(shape.mode);
  return {
    mode: mode ? normalizeMode(mode) : undefined,
    cwd: normalizeText(shape.cwd),
    backend: normalizeText(shape.backend),
    label: normalizeText(shape.label),
  };
}

function buildBindingHash(params: {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.channel}:${params.accountId}:${params.conversationId}`)
    .digest("hex")
    .slice(0, 16);
}

/** Builds the stable generated ACP session key for a configured binding. */
export function buildConfiguredAcpSessionKey(spec: ConfiguredAcpBindingSpec): string {
  const hash = buildBindingHash({
    channel: spec.channel,
    accountId: spec.accountId,
    conversationId: spec.conversationId,
  });
  return `agent:${sanitizeAgentId(spec.agentId)}:acp:binding:${spec.channel}:${spec.accountId}:${hash}`;
}

/** Converts a configured ACP binding spec into an outbound session binding record. */
export function toConfiguredAcpBindingRecord(spec: ConfiguredAcpBindingSpec): SessionBindingRecord {
  return {
    bindingId: `config:acp:${spec.channel}:${spec.accountId}:${spec.conversationId}`,
    targetSessionKey: buildConfiguredAcpSessionKey(spec),
    targetKind: "session",
    conversation: {
      channel: spec.channel,
      accountId: spec.accountId,
      conversationId: spec.conversationId,
      parentConversationId: spec.parentConversationId,
    },
    status: "active",
    boundAt: 0,
    metadata: {
      source: "config",
      mode: spec.mode,
      agentId: spec.agentId,
      ...(spec.acpAgentId ? { acpAgentId: spec.acpAgentId } : {}),
      label: spec.label,
      ...(spec.backend ? { backend: spec.backend } : {}),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
  };
}

/** Parses generated configured-binding session keys back to channel/account identity. */
export function parseConfiguredAcpSessionKey(
  sessionKey: string,
): { channel: ConfiguredAcpBindingChannel; accountId: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const rest = trimmed.slice(trimmed.indexOf(":") + 1);
  const nextSeparator = rest.indexOf(":");
  if (nextSeparator === -1) {
    return null;
  }
  const tokens = rest.slice(nextSeparator + 1).split(":");
  if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") {
    return null;
  }
  const channel = normalizeOptionalLowercaseString(tokens[2]);
  if (!channel) {
    return null;
  }
  return {
    channel: channel as ConfiguredAcpBindingChannel,
    accountId: normalizeAccountId(tokens[3] ?? "default"),
  };
}

export function resolveConfiguredAcpBindingSpecFromRecord(
  record: SessionBindingRecord,
): ConfiguredAcpBindingSpec | null {
  if (record.targetKind !== "session") {
    return null;
  }
  const conversationId = record.conversation.conversationId.trim();
  if (!conversationId) {
    return null;
  }
  const agentId =
    normalizeText(record.metadata?.agentId) ??
    resolveAgentIdFromSessionKey(record.targetSessionKey);
  if (!agentId) {
    return null;
  }
  return {
    channel: record.conversation.channel as ConfiguredAcpBindingChannel,
    accountId: normalizeAccountId(record.conversation.accountId),
    conversationId,
    parentConversationId: normalizeText(record.conversation.parentConversationId),
    agentId,
    acpAgentId: normalizeText(record.metadata?.acpAgentId),
    mode: normalizeMode(record.metadata?.mode),
    cwd: normalizeText(record.metadata?.cwd),
    backend: normalizeText(record.metadata?.backend),
    label: normalizeText(record.metadata?.label),
  };
}

export function toResolvedConfiguredAcpBinding(
  record: SessionBindingRecord,
): ResolvedConfiguredAcpBinding | null {
  const spec = resolveConfiguredAcpBindingSpecFromRecord(record);
  if (!spec) {
    return null;
  }
  return {
    spec,
    record,
  };
}
