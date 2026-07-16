import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

function hasTranscriptMeta(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { __openclaw?: unknown })["__openclaw"] &&
    typeof (message as { __openclaw?: unknown })["__openclaw"] === "object",
  );
}

export function readTranscriptSequence(message: unknown): number | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const seq = (metadata as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

export function isLocallyOptimisticHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || hasTranscriptMeta(message)) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  return role === "user" || role === "assistant";
}

export function messageDisplaySignature(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  if (!role) {
    return null;
  }
  const text = extractText(message)?.trim();
  if (text) {
    return `${role}:text:${text}`;
  }
  try {
    const content = JSON.stringify((message as { content?: unknown }).content ?? null);
    return `${role}:content:${content}`;
  } catch {
    return null;
  }
}

export function preserveOptimisticTailMessages(
  historyMessages: unknown[],
  previousMessages: unknown[],
  shouldHideMessage: (message: unknown) => boolean = () => false,
): unknown[] {
  if (previousMessages.length === 0) {
    return historyMessages;
  }
  if (historyMessages.length === 0) {
    const optimisticMessages = previousMessages.filter(
      (message) => isLocallyOptimisticHistoryMessage(message) && !shouldHideMessage(message),
    );
    return optimisticMessages.length === previousMessages.length
      ? previousMessages
      : historyMessages;
  }
  const historySignatureIndexes = new Map<string, number>();
  historyMessages.forEach((message, index) => {
    const signature = messageDisplaySignature(message);
    if (signature) {
      historySignatureIndexes.set(signature, index);
    }
  });
  let sharedPreviousIndex = -1;
  let sharedHistoryIndex = -1;
  for (let index = previousMessages.length - 1; index >= 0; index--) {
    const signature = messageDisplaySignature(previousMessages[index]);
    const historyIndex = signature ? historySignatureIndexes.get(signature) : undefined;
    if (typeof historyIndex === "number") {
      sharedPreviousIndex = index;
      sharedHistoryIndex = historyIndex;
      break;
    }
  }
  if (sharedPreviousIndex < 0 || sharedHistoryIndex < historyMessages.length - 1) {
    return historyMessages;
  }
  const optimisticTail: unknown[] = [];
  for (const message of previousMessages.slice(sharedPreviousIndex + 1)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideMessage(message)) {
      return historyMessages;
    }
    const signature = messageDisplaySignature(message);
    if (!signature || historySignatureIndexes.has(signature)) {
      return historyMessages;
    }
    optimisticTail.push(message);
  }
  return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
}
