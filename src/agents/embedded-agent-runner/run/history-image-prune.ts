/**
 * Prunes already-processed image payloads from replayed prompt history.
 */
import { buildLateMediaAttachedText } from "../../../sessions/user-turn-transcript.js";
import type { AgentMessage } from "../../runtime/index.js";
import { hasNonBlankUserText } from "./attempt.user-message-boundary.js";

/** Replacement text for old image blocks that were already available to the model. */
const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

/** Replacement text for old textual media references that would otherwise be reloaded. */
const PRUNED_HISTORY_MEDIA_REFERENCE_MARKER =
  "[media reference removed - already processed by model]";

const MEDIA_ATTACHED_HISTORY_REF_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*[^\]]+\]/gi;
const MESSAGE_IMAGE_HISTORY_REF_PATTERN = /\[Image:\s*source:\s*[^\]]+\]/gi;
const INBOUND_MEDIA_URI_HISTORY_REF_PATTERN = /\bmedia:\/\/inbound\/[^\]\s/\\]+/g;

type PrunableContextAgent = {
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>;
};

/**
 * Number of most-recent completed turns whose preceding user/toolResult image
 * blocks are kept intact. Counts all completed turns, not just image-bearing
 * ones, so text-only turns consume the window.
 */
const PRESERVE_RECENT_COMPLETED_TURNS = 3;

function resolvePruneBeforeIndex(messages: AgentMessage[]): number {
  const completedTurnStarts: number[] = [];
  let currentTurnStart = -1;
  let currentTurnHasAssistantReply = false;

  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === "user") {
      if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
        completedTurnStarts.push(currentTurnStart);
      }
      currentTurnStart = i;
      currentTurnHasAssistantReply = false;
      continue;
    }
    if (role === "toolResult") {
      if (currentTurnStart < 0) {
        currentTurnStart = i;
      }
      continue;
    }
    if (role === "assistant" && currentTurnStart >= 0) {
      currentTurnHasAssistantReply = true;
    }
  }

  if (currentTurnStart >= 0 && currentTurnHasAssistantReply) {
    completedTurnStarts.push(currentTurnStart);
  }

  if (completedTurnStarts.length <= PRESERVE_RECENT_COMPLETED_TURNS) {
    return -1;
  }
  return completedTurnStarts.at(-PRESERVE_RECENT_COMPLETED_TURNS) ?? -1;
}

function pruneHistoryMediaReferenceText(text: string): string {
  return text
    .replace(MEDIA_ATTACHED_HISTORY_REF_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(MESSAGE_IMAGE_HISTORY_REF_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER)
    .replace(INBOUND_MEDIA_URI_HISTORY_REF_PATTERN, PRUNED_HISTORY_MEDIA_REFERENCE_MARKER);
}

function cloneMessageWithContent(
  message: Extract<AgentMessage, { role: "user" | "toolResult" }>,
  content: typeof message.content,
): AgentMessage {
  return { ...message, content } as AgentMessage;
}

/** Prunes old image payloads and references before later LLM-boundary synthesis. */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): AgentMessage[] | null {
  const pruneBeforeIndex = resolvePruneBeforeIndex(messages);
  if (pruneBeforeIndex < 0) {
    return null;
  }

  let prunedMessages: AgentMessage[] | null = null;
  for (let i = 0; i < pruneBeforeIndex; i++) {
    const message = messages[i];
    if (!message || (message.role !== "user" && message.role !== "toolResult")) {
      continue;
    }

    // Materialize blank marked turns here so this earlier boundary still prunes stale paths.
    const lateMediaText =
      message.role === "user" && !hasNonBlankUserText(message.content)
        ? buildLateMediaAttachedText(message)
        : undefined;
    const content = lateMediaText
      ? Array.isArray(message.content)
        ? ([{ type: "text", text: lateMediaText }, ...message.content] as typeof message.content)
        : lateMediaText
      : message.content;

    if (typeof content === "string") {
      const prunedText = pruneHistoryMediaReferenceText(content);
      if (prunedText !== message.content) {
        prunedMessages ??= messages.slice();
        prunedMessages[i] = cloneMessageWithContent(message, prunedText);
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const nextContent = content.map((block) => {
      const typed = block as { type?: unknown; text?: unknown } | null | undefined;
      if (typed?.type === "text" && typeof typed.text === "string") {
        const text = pruneHistoryMediaReferenceText(typed.text);
        return text === typed.text ? block : ({ ...block, text } as (typeof content)[number]);
      }
      return typed?.type === "image"
        ? ({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER } as (typeof content)[number])
        : block;
    });
    if (lateMediaText || nextContent.some((block, index) => block !== content[index])) {
      prunedMessages ??= messages.slice();
      prunedMessages[i] = cloneMessageWithContent(message, nextContent);
    }
  }

  return prunedMessages;
}

/** Installs an agent context transform that prunes old image/media history before model input. */
export function installHistoryImagePruneContextTransform(agent: PrunableContextAgent): () => void {
  const originalTransformContext = agent.transformContext;
  agent.transformContext = async (messages: AgentMessage[], signal?: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(agent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    return pruneProcessedHistoryImages(sourceMessages) ?? sourceMessages;
  };
  return () => {
    agent.transformContext = originalTransformContext;
  };
}
