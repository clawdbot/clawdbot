import type { ClawdbotConfig } from "../../config/config.js";
import {
  getProviderPlugin,
  normalizeProviderId,
} from "../../providers/plugins/index.js";

const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
const REPLY_SKIP_TOKEN = "REPLY_SKIP";
const DEFAULT_PING_PONG_TURNS = 5;
const MAX_PING_PONG_TURNS = 5;

export type AnnounceTarget = {
  provider: string;
  to: string;
  accountId?: string;
};

export function resolveAnnounceTargetFromKey(
  sessionKey: string,
): AnnounceTarget | null {
  const rawParts = sessionKey.split(":").filter(Boolean);
  const parts =
    rawParts.length >= 3 && rawParts[0] === "agent"
      ? rawParts.slice(2)
      : rawParts;
  if (parts.length < 3) return null;
  const [providerRaw, kind, ...rest] = parts;
  if (kind !== "group" && kind !== "channel") return null;
  const id = rest.join(":").trim();
  if (!id) return null;
  if (!providerRaw) return null;
  const normalizedProvider = normalizeProviderId(providerRaw);
  const provider = normalizedProvider ?? providerRaw.toLowerCase();
  const kindTarget = normalizedProvider
    ? kind === "channel"
      ? `channel:${id}`
      : `group:${id}`
    : id;
  const normalized = normalizedProvider
    ? getProviderPlugin(normalizedProvider)?.messaging?.normalizeTarget?.(
        kindTarget,
      )
    : undefined;
  return { provider, to: normalized ?? kindTarget };
}

export function buildAgentToAgentMessageContext(params: {
  requesterSessionKey?: string;
  requesterProvider?: string;
  targetSessionKey: string;
}) {
  const lines = [
    "Agent-to-agent message context:",
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterProvider
      ? `Agent 1 (requester) provider: ${params.requesterProvider}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildAgentToAgentReplyContext(params: {
  requesterSessionKey?: string;
  requesterProvider?: string;
  targetSessionKey: string;
  targetProvider?: string;
  currentRole: "requester" | "target";
  turn: number;
  maxTurns: number;
}) {
  const currentLabel =
    params.currentRole === "requester"
      ? "Agent 1 (requester)"
      : "Agent 2 (target)";
  const lines = [
    "Agent-to-agent reply step:",
    `Current agent: ${currentLabel}.`,
    `Turn ${params.turn} of ${params.maxTurns}.`,
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterProvider
      ? `Agent 1 (requester) provider: ${params.requesterProvider}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetProvider
      ? `Agent 2 (target) provider: ${params.targetProvider}.`
      : undefined,
    `If you want to stop the ping-pong, reply exactly "${REPLY_SKIP_TOKEN}".`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildAgentToAgentAnnounceContext(params: {
  requesterSessionKey?: string;
  requesterProvider?: string;
  targetSessionKey: string;
  targetProvider?: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply?: string;
}) {
  const lines = [
    "Agent-to-agent announce step:",
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterProvider
      ? `Agent 1 (requester) provider: ${params.requesterProvider}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetProvider
      ? `Agent 2 (target) provider: ${params.targetProvider}.`
      : undefined,
    `Original request: ${params.originalMessage}`,
    params.roundOneReply
      ? `Round 1 reply: ${params.roundOneReply}`
      : "Round 1 reply: (not available).",
    params.latestReply
      ? `Latest reply: ${params.latestReply}`
      : "Latest reply: (not available).",
    `If you want to remain silent, reply exactly "${ANNOUNCE_SKIP_TOKEN}".`,
    "Any other reply will be posted to the target provider.",
    "After this reply, the agent-to-agent conversation is over.",
  ].filter(Boolean);
  return lines.join("\n");
}

export function isAnnounceSkip(text?: string) {
  return (text ?? "").trim() === ANNOUNCE_SKIP_TOKEN;
}

export function isReplySkip(text?: string) {
  return (text ?? "").trim() === REPLY_SKIP_TOKEN;
}

export function resolvePingPongTurns(cfg?: ClawdbotConfig) {
  const raw = cfg?.session?.agentToAgent?.maxPingPongTurns;
  const fallback = DEFAULT_PING_PONG_TURNS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  const rounded = Math.floor(raw);
  return Math.max(0, Math.min(MAX_PING_PONG_TURNS, rounded));
}
