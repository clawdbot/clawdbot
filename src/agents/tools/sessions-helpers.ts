/**
 * Shared session-tool data shapes and classification helpers.
 *
 * Keeps list/send/status tools aligned on rows, visibility context, and compact kind/channel labels.
 */
export {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-access.js";
import { resolveSandboxedSessionToolContext } from "./sessions-access.js";
export {
  resolveCurrentSessionClientAlias,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-resolution.js";
export {
  extractAssistantText,
  sanitizeTextContent,
  stripToolMessages,
} from "./chat-history-text.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Coarse session category used by session list/status tools. */
export type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

/** Delivery target metadata attached to session rows. */
export type SessionListDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

/** Compact run status shown by session tools. */
export type SessionRunStatus = "running" | "done" | "failed" | "killed" | "timeout";

/** Normalized session row returned by session list-style tools. */
export type SessionListRow = {
  key: string;
  agentId?: string;
  kind: SessionKind;
  channel: string;
  origin?: {
    provider?: string;
    accountId?: string;
  };
  spawnedBy?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  parentSessionKey?: string;
  deliveryContext?: SessionListDeliveryContext;
  updatedAt?: number | null;
  sessionId?: string;
  model?: string;
  contextTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  childSessions?: string[];
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  responseUsage?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  transcriptPath?: string;
  messages?: unknown[];
};

/** Resolves config plus sandbox visibility context for a session tool call. */
export function resolveSessionToolContext(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  const cfg = opts?.config ?? getRuntimeConfig();
  return {
    cfg,
    ...resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: opts?.agentSessionKey,
      sandboxed: opts?.sandboxed,
    }),
  };
}

/** Classifies a session key/gateway kind into the row category used by tools. */
export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) {
    return "main";
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (params.gatewayKind === "group") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    // Gateway-less archived rows still encode group/channel shape in the session key.
    return "group";
  }
  return "other";
}

/** Derives the best channel label for a session row. */
export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  const channel = normalizeOptionalString(params.channel ?? undefined);
  if (channel) {
    return channel;
  }
  const lastChannel = normalizeOptionalString(params.lastChannel ?? undefined);
  if (lastChannel) {
    return lastChannel;
  }
  const parts = params.key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return parts[0];
  }
  return "unknown";
}
