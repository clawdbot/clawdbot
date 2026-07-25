import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildChannelInboundEventContext } from "./inbound-event/context.js";
import { createChannelInboundEnvelopeBuilder } from "./inbound-event/envelope.js";
import { dispatchChannelInboundTurn } from "./turn/kernel.js";

export const DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS = 300_000;
const MAX_RESPONSE_CHARS = 500;
const MAX_COOLDOWN_ENTRIES = 500;
const lastReflectionBySession = new Map<string, number>();

export async function recordChannelFeedbackEvent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  event: Parameters<typeof appendTranscriptEvent>[1];
}): Promise<boolean> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const entry = loadSessionEntryReadOnly({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath,
  });
  if (!entry?.sessionId) {
    return false;
  }
  await appendTranscriptEvent(
    {
      agentId: params.agentId,
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      storePath,
    },
    params.event,
  );
  return true;
}

export type ChannelFeedbackReflectionResult =
  | { status: "cooldown" }
  | { status: "empty" }
  | {
      status: "complete";
      learning: string;
      storePath: string;
      followUp: boolean;
      userMessage?: string;
      responseLength: number;
    };

function buildReflectionPrompt(params: {
  thumbedDownResponse?: string;
  userComment?: string;
}): string {
  const response = params.thumbedDownResponse;
  const truncated =
    response && response.length > MAX_RESPONSE_CHARS
      ? `${truncateUtf16Safe(response, MAX_RESPONSE_CHARS)}...`
      : response;
  return [
    "A user indicated your previous response wasn't helpful.",
    truncated ? `\nYour response was:\n> ${truncated}` : undefined,
    params.userComment ? `\nUser's comment: "${params.userComment}"` : undefined,
    "\nBriefly reflect: what could you improve? Consider tone, length, accuracy, relevance, and specificity. " +
      'Reply with one JSON object only: {"learning":"...","followUp":false,"userMessage":""}. ' +
      "Keep learning to 1-2 sentences. Set followUp only when the user needs a direct reply.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseReflectionResponse(text: string) {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    ...(trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.slice(1, 2) ?? []),
  ];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim()) as Record<string, unknown>;
      const learning = typeof value.learning === "string" ? value.learning.trim() : "";
      if (!learning) {
        continue;
      }
      const followUp =
        value.followUp === true ||
        (typeof value.followUp === "string" &&
          ["true", "yes"].includes(value.followUp.trim().toLowerCase()));
      const userMessage = typeof value.userMessage === "string" ? value.userMessage.trim() : "";
      return { learning, followUp, userMessage: userMessage || undefined };
    } catch {}
  }
  return trimmed ? { learning: trimmed, followUp: false } : null;
}

export async function runChannelFeedbackReflection(params: {
  cfg: OpenClawConfig;
  channel: string;
  channelLabel: string;
  accountId?: string;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "channel";
  thumbedDownResponse?: string;
  userComment?: string;
  cooldownMs?: number;
  onRecordError?: (error: unknown) => void;
  onDispatchError?: (error: unknown) => void;
}): Promise<ChannelFeedbackReflectionResult> {
  const cooldownMs = params.cooldownMs ?? DEFAULT_CHANNEL_FEEDBACK_REFLECTION_COOLDOWN_MS;
  if (
    Date.now() - (lastReflectionBySession.get(params.sessionKey) ?? Number.NEGATIVE_INFINITY) <
    cooldownMs
  ) {
    return { status: "cooldown" };
  }
  const prompt = buildReflectionPrompt(params);
  const timestamp = Date.now();
  const body = createChannelInboundEnvelopeBuilder({
    cfg: params.cfg,
    route: { agentId: params.agentId, sessionKey: params.sessionKey },
  })({
    channel: params.channelLabel,
    from: "system",
    body: prompt,
    timestamp,
  });
  const target = `conversation:${params.conversationId}`;
  const ctxPayload = buildChannelInboundEventContext({
    channel: params.channel,
    accountId: params.accountId,
    messageId: `feedback-reflection:${timestamp}`,
    timestamp,
    from: `${params.channel}:system:${params.conversationId}`,
    sender: { id: "system", name: "system" },
    conversation: { kind: params.conversationKind, id: params.conversationId },
    route: {
      agentId: params.agentId,
      accountId: params.accountId,
      routeSessionKey: params.sessionKey,
      dispatchSessionKey: params.sessionKey,
    },
    reply: { to: target, originatingTo: target },
    message: { body, bodyForAgent: prompt, rawBody: prompt, commandBody: prompt },
    access: { commands: { authorized: false } },
  });
  const responses: string[] = [];
  await dispatchChannelInboundTurn({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    route: { agentId: params.agentId, sessionKey: params.sessionKey },
    ctxPayload,
    record: { onRecordError: params.onRecordError },
    delivery: {
      deliver: async (payload) => {
        if (payload.text) {
          responses.push(payload.text);
        }
        return { visibleReplySent: false };
      },
      onError: (error) => params.onDispatchError?.(error),
    },
    replyPipeline: {},
  });
  const response = responses.join("\n");
  const parsed = parseReflectionResponse(response);
  if (!parsed) {
    return { status: "empty" };
  }
  lastReflectionBySession.set(params.sessionKey, Date.now());
  if (lastReflectionBySession.size > MAX_COOLDOWN_ENTRIES) {
    for (const [key, time] of lastReflectionBySession) {
      if (Date.now() - time >= cooldownMs) {
        lastReflectionBySession.delete(key);
      }
    }
  }
  return {
    status: "complete",
    learning: parsed.learning,
    storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
    followUp: parsed.followUp,
    userMessage: parsed.userMessage,
    responseLength: response.trim().length,
  };
}
