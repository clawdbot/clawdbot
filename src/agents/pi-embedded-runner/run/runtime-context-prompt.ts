import { truncateUtf16Safe } from "../../../utils.js";
import {
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentTurnPromptContext } from "./params.js";
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE };

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";
const MAX_CURRENT_TURN_CONTEXT_STRING_CHARS = 2_000;

type RuntimeContextSession = {
  sendCustomMessage: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "nextTurn"; triggerTurn?: boolean },
  ) => Promise<void>;
};

type RuntimeContextPromptParts = {
  prompt: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

function neutralizeMarkdownFences(value: string): string {
  return value.replaceAll("```", "`\u200b``");
}

function truncateCurrentTurnContextString(value: string): string {
  if (value.length <= MAX_CURRENT_TURN_CONTEXT_STRING_CHARS) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, MAX_CURRENT_TURN_CONTEXT_STRING_CHARS - 14)).trimEnd()}…[truncated]`;
}

function sanitizeCurrentTurnContextString(value: string): string {
  return neutralizeMarkdownFences(truncateCurrentTurnContextString(value.replaceAll("\0", "")));
}

export function buildCurrentTurnPromptContextSuffix(
  context: CurrentTurnPromptContext | undefined,
): string {
  const replyChain = context?.replyChain?.filter(
    (entry) =>
      entry.body?.trim() ||
      entry.mediaType?.trim() ||
      entry.mediaPath?.trim() ||
      entry.mediaRef?.trim(),
  );
  if (replyChain && replyChain.length > 0) {
    const payload = replyChain.map((entry) => ({
      message_id: entry.messageId ? sanitizeCurrentTurnContextString(entry.messageId) : undefined,
      thread_id: entry.threadId ? sanitizeCurrentTurnContextString(entry.threadId) : undefined,
      sender: entry.sender ? sanitizeCurrentTurnContextString(entry.sender) : undefined,
      sender_id: entry.senderId ? sanitizeCurrentTurnContextString(entry.senderId) : undefined,
      sender_username: entry.senderUsername
        ? sanitizeCurrentTurnContextString(entry.senderUsername)
        : undefined,
      timestamp: entry.timestamp,
      body: entry.body ? sanitizeCurrentTurnContextString(entry.body) : undefined,
      is_quote: entry.isQuote === true ? true : undefined,
      media_type: entry.mediaType ? sanitizeCurrentTurnContextString(entry.mediaType) : undefined,
      media_path: entry.mediaPath ? sanitizeCurrentTurnContextString(entry.mediaPath) : undefined,
      media_ref: entry.mediaRef ? sanitizeCurrentTurnContextString(entry.mediaRef) : undefined,
      reply_to_id: entry.replyToId ? sanitizeCurrentTurnContextString(entry.replyToId) : undefined,
      forwarded_from: entry.forwardedFrom
        ? sanitizeCurrentTurnContextString(entry.forwardedFrom)
        : undefined,
      forwarded_from_id: entry.forwardedFromId
        ? sanitizeCurrentTurnContextString(entry.forwardedFromId)
        : undefined,
      forwarded_from_username: entry.forwardedFromUsername
        ? sanitizeCurrentTurnContextString(entry.forwardedFromUsername)
        : undefined,
      forwarded_date: entry.forwardedDate,
    }));
    return [
      "",
      "Reply chain of current user message (untrusted, nearest first):",
      "```json",
      JSON.stringify(payload, null, 2),
      "```",
    ].join("\n");
  }
  const reply = context?.reply;
  const replyBody = reply?.body?.trim();
  if (!reply || !replyBody) {
    return "";
  }
  const payload = {
    sender_label: reply.senderLabel
      ? sanitizeCurrentTurnContextString(reply.senderLabel)
      : undefined,
    is_quote: reply.isQuote === true ? true : undefined,
    body: sanitizeCurrentTurnContextString(replyBody),
  };
  return [
    "",
    "Reply target of current user message (untrusted, for context):",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

function removeLastPromptOccurrence(text: string, prompt: string): string | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + prompt.length).trimStart();
  return [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  if (transcriptPrompt === undefined || transcriptPrompt === params.effectivePrompt) {
    return { prompt: params.effectivePrompt };
  }

  const prompt = transcriptPrompt.trim();
  const runtimeContext =
    removeLastPromptOccurrence(params.effectivePrompt, transcriptPrompt)?.trim() ||
    params.effectivePrompt.trim();
  if (!prompt) {
    return runtimeContext
      ? {
          prompt: OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
          runtimeContext,
          runtimeOnly: true,
          runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext),
        }
      : { prompt: "" };
  }

  return runtimeContext ? { prompt, runtimeContext } : { prompt };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  return [
    params.kind === "runtime-event"
      ? OPENCLAW_RUNTIME_EVENT_HEADER
      : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    params.runtimeContext,
  ].join("\n");
}

export function buildRuntimeContextSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "next-turn" });
}

export function buildRuntimeEventSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "runtime-event" });
}

export async function queueRuntimeContextForNextTurn(params: {
  session: RuntimeContextSession;
  runtimeContext?: string;
}): Promise<void> {
  const runtimeContext = params.runtimeContext?.trim();
  if (!runtimeContext) {
    return;
  }
  await params.session.sendCustomMessage(
    {
      customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      content: runtimeContext,
      display: false,
      details: { source: "openclaw-runtime-context" },
    },
    { deliverAs: "nextTurn" },
  );
}
