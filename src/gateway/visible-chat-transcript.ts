// Visible chat transcript projection for agent-facing history/list surfaces.
// Raw transcript bookkeeping remains on disk; these helpers shape what looks like chat.
import {
  isOpenClawDeliveryMirrorAssistantMessage,
  isOpenClawMessageToolMirrorAssistantMessage,
} from "../shared/transcript-only-openclaw-assistant.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

function extractTextContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const entry = message as { content?: unknown; text?: unknown };
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" && typed.type !== "input_text" && typed.type !== "output_text") {
      return undefined;
    }
    if (typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isTerminalSourceDeliveryConfirmation(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return false;
  }
  const text = extractTextContent(message)?.trim();
  if (!text) {
    return false;
  }
  return /^Sent\b.+\bin\s+(?:WhatsApp|Telegram|Discord|Slack|Signal|SMS|iMessage|the chat)\.?$/i.test(
    text,
  );
}

function isToolHistoryBlockType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return (
    normalized === "toolcall" ||
    normalized === "tool_call" ||
    normalized === "tooluse" ||
    normalized === "tool_use" ||
    normalized === "toolresult" ||
    normalized === "tool_result"
  );
}

function isAssistantToolOnlyMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }
  return (
    message.content.length > 0 &&
    message.content.every(
      (block) =>
        block &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        isToolHistoryBlockType((block as { type?: unknown }).type),
    )
  );
}

function isToolArtifactMessage(message: Record<string, unknown>): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase().replace(/_/g, "") : "";
  return (
    role === "tool" ||
    role === "toolresult" ||
    role === "function" ||
    isAssistantToolOnlyMessage(message)
  );
}

function normalizeMirrorText(message: unknown): string | undefined {
  const text = extractTextContent(message)?.trim();
  return text ? text : undefined;
}

function markSegmentReplacedDeliveryMirrors(
  segment: Array<{ index: number; message: Record<string, unknown> }>,
  replacedIndexes: Set<number>,
): void {
  if (segment.length === 0) {
    return;
  }
  const syntheticMirrorCounts = new Map<string, number>();
  const deliveryMirrorIndexes = new Map<string, number[]>();
  for (const { index, message } of segment) {
    const text = normalizeMirrorText(message);
    if (!text) {
      continue;
    }
    if (isOpenClawMessageToolMirrorAssistantMessage(message)) {
      syntheticMirrorCounts.set(text, (syntheticMirrorCounts.get(text) ?? 0) + 1);
      continue;
    }
    if (isOpenClawDeliveryMirrorAssistantMessage(message)) {
      const indexes = deliveryMirrorIndexes.get(text) ?? [];
      indexes.push(index);
      deliveryMirrorIndexes.set(text, indexes);
    }
  }
  for (const [text, count] of syntheticMirrorCounts) {
    const indexes = deliveryMirrorIndexes.get(text);
    if (!indexes?.length) {
      continue;
    }
    for (const index of indexes.slice(-count)) {
      replacedIndexes.add(index);
    }
  }
}

function replacedDeliveryMirrorIndexes(messages: Array<Record<string, unknown>>): Set<number> {
  const replacedIndexes = new Set<number>();
  let segment: Array<{ index: number; message: Record<string, unknown> }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "user") {
      markSegmentReplacedDeliveryMirrors(segment, replacedIndexes);
      segment = [];
    }
    segment.push({ index, message });
  }
  markSegmentReplacedDeliveryMirrors(segment, replacedIndexes);
  return replacedIndexes;
}

function stripDeliveryMirrorMetadata(message: Record<string, unknown>): Record<string, unknown> {
  if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
    return message;
  }
  const { provider, model, openclawDeliveryMirror, ...visible } = message;
  void provider;
  void model;
  void openclawDeliveryMirror;
  return visible;
}

export function projectVisibleChatTranscriptMessages(
  messages: unknown[],
  options?: { maxChars?: number; stripEnvelope?: boolean; stripDeliveryMirrorMetadata?: boolean },
): Array<Record<string, unknown>> {
  const projected = projectChatDisplayMessages(messages, options);
  const replacedMirrorIndexes = replacedDeliveryMirrorIndexes(projected);
  const deliveryEvidenceIndexes = new Set<number>();
  const withoutToolArtifacts = projected.filter((message, index) => {
    if (isToolArtifactMessage(message)) {
      deliveryEvidenceIndexes.add(index);
      return false;
    }
    if (!isOpenClawDeliveryMirrorAssistantMessage(message)) {
      return true;
    }
    deliveryEvidenceIndexes.add(index);
    return !replacedMirrorIndexes.has(index);
  });

  let sawDeliveryEvidence = false;
  let visibleIndex = 0;
  return withoutToolArtifacts
    .filter((message) => {
      while (visibleIndex < projected.length && projected[visibleIndex] !== message) {
        if (deliveryEvidenceIndexes.has(visibleIndex)) {
          sawDeliveryEvidence = true;
        }
        visibleIndex += 1;
      }
      if (deliveryEvidenceIndexes.has(visibleIndex)) {
        sawDeliveryEvidence = true;
      }
      visibleIndex += 1;
      if (isOpenClawMessageToolMirrorAssistantMessage(message)) {
        sawDeliveryEvidence = true;
        return true;
      }
      if (sawDeliveryEvidence && isTerminalSourceDeliveryConfirmation(message)) {
        return false;
      }
      if (message.role === "user") {
        sawDeliveryEvidence = false;
      }
      return true;
    })
    .map((message) =>
      options?.stripDeliveryMirrorMetadata === true
        ? stripDeliveryMirrorMetadata(message)
        : message,
    );
}
