import { normalizeOptionalString, type FastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionRow,
  SessionRunStatus,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseRawSessionConversationRef } from "../../sessions/session-key-utils.js";
import type { FastModeSource } from "../../shared/fast-mode.js";
/**
 * Shared session-tool data shapes and classification helpers.
 *
 * Keeps list/send/status tools aligned on rows, visibility context, and compact kind/channel labels.
 */
import { resolveSandboxedSessionToolContext } from "./sessions-access.js";
export {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
} from "./sessions-access.js";
export {
  resolveCurrentSessionClientAlias,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  resolveVisibleSessionReference,
  isExpectedSessionLookupMiss,
  shouldResolveSessionIdInput,
} from "./sessions-resolution.js";

/** Coarse session category used by session list/status tools. */
type SessionKind = "main" | "group" | "cron" | "hook" | "node" | "other";

const SESSION_KIND_BY_CLASSIFICATION: Readonly<Record<string, SessionKind>> = {
  main: "main",
  global: "main",
  group: "group",
  channel: "group",
  cron: "cron",
  hook: "hook",
  node: "node",
};

/** Delivery target metadata attached to session rows. */
type SessionListDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

/** Full Gateway session row consumed by session orchestration internals. */
export type GatewaySessionListRow = {
  key: string;
  agentId?: string;
  classification: NonNullable<SessionRow["classification"]>;
  peerKind?: SessionRow["peerKind"];
  kind: SessionRow["kind"];
  channel?: string;
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
  archived?: boolean;
  archivedAt?: number;
  pinned?: boolean;
  pinnedAt?: number;
  sessionId?: string;
  stateVersion?: number;
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
  fastMode?: FastMode;
  effectiveFastMode?: FastMode;
  effectiveFastModeSource?: FastModeSource;
  fastAutoOnSeconds?: number;
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

/** Focused model-facing row returned by sessions_list. */
export type SessionListRow = {
  key: string;
  sessionId?: string;
  agentId: string;
  kind: SessionKind;
  channel: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  parentSessionKey?: string;
  updatedAt?: number;
  archived: boolean;
  pinned: boolean;
  stateVersion?: number;
  model?: string;
  contextTokens?: number;
  totalTokens?: number;
  status?: SessionRunStatus;
  abortedLastRun?: boolean;
  childSessions?: string[];
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

/** Projects the Gateway's authoritative classification into the tool's coarse categories. */
export function classifySessionListKind(params: {
  classification: NonNullable<GatewaySessionListRow["classification"]>;
  peerKind?: GatewaySessionListRow["peerKind"];
}): SessionKind {
  if (params.classification === "thread") {
    return params.peerKind === "group" || params.peerKind === "channel" ? "group" : "other";
  }
  return SESSION_KIND_BY_CLASSIFICATION[params.classification] ?? "other";
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
  return parseRawSessionConversationRef(params.key)?.channel ?? "unknown";
}
