import { escapeRegExp } from "../../../../src/shared/regexp.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { isPendingSendMessage, readChatThreadMessageIdentity } from "./chat-thread-items.ts";
import { safeNormalizeMessage } from "./chat-turn-boundary.ts";

function collapseDuplicateSourceKey(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return null;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  if (role !== "assistant" && role !== "user") {
    return null;
  }
  const identity = readChatThreadMessageIdentity(message);
  if (!identity?.isImported) {
    return identity?.id ? `${role}:${identity.id}` : null;
  }
  if (identity.externalSource) {
    return `${role}:import:${identity.externalSource}`;
  }
  return identity.sequence === null ? null : `${role}:import-seq:${identity.sequence}`;
}

function prefersNativeChatSurface(message: unknown): boolean {
  const normalized = safeNormalizeMessage(message);
  if (!normalized) {
    return false;
  }
  const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
  return (role === "user" || role === "assistant") && !(normalized.senderLabel ?? "").trim();
}

function stripSenderLabelPrefix(text: string, senderLabel: string): string {
  const label = senderLabel.trim();
  if (!label) {
    return text;
  }
  return text.replace(new RegExp(`^${escapeRegExp(label)}(?::|：|-|—)?[ \\t]+`), "");
}

function textOnlyMessageParts(message: unknown) {
  const normalized = safeNormalizeMessage(message);
  if (!normalized || normalized.content.length === 0) {
    return null;
  }
  const textParts: string[] = [];
  for (const block of normalized.content) {
    if (block.type !== "text" || typeof block.text !== "string") {
      return null;
    }
    textParts.push(block.text);
  }
  return {
    role: normalizeRoleForGrouping(normalized.role).toLowerCase(),
    senderLabel: (normalized.senderLabel ?? "").trim(),
    senderKey: senderIdentityKey(normalized.sender),
    senderSession: normalized.senderSession,
    text: textParts.join("\n"),
  };
}

function sourceDuplicateDisplayParts(message: unknown) {
  const parts = textOnlyMessageParts(message);
  return parts?.role === "assistant" && parts.text.trim() ? parts : null;
}

function isSameSourceRelayNativeDuplicate(previousMessage: unknown, nextMessage: unknown): boolean {
  const previous = sourceDuplicateDisplayParts(previousMessage);
  const next = sourceDuplicateDisplayParts(nextMessage);
  if (!previous || !next || previous.role !== next.role) {
    return false;
  }
  if (Boolean(previous.senderLabel) === Boolean(next.senderLabel)) {
    return false;
  }
  const labeled = previous.senderLabel ? previous : next;
  const native = previous.senderLabel ? next : previous;
  return (
    labeled.text === native.text ||
    stripSenderLabelPrefix(labeled.text, labeled.senderLabel) === native.text
  );
}

function collapseDuplicateDisplaySignature(message: unknown): string | null {
  if (isPendingSendMessage(message)) {
    return null;
  }
  const parts = textOnlyMessageParts(message);
  if (!parts || !parts.role || parts.role === "tool") {
    return null;
  }
  const text = parts.text.trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  const senderLabel = ["user", "assistant"].includes(parts.role) ? parts.senderLabel : "";
  return JSON.stringify([
    parts.role,
    senderLabel,
    parts.senderKey ?? "",
    parts.senderSession,
    text,
  ]);
}

export function collapseSequentialDuplicateMessages(items: ChatItem[]): ChatItem[] {
  const collapsed: ChatItem[] = [];
  let previousSignature: string | null = null;
  let previousSourceKey: string | null = null;
  let previousSourceIsUnprovenImport = false;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousSignature = null;
      previousSourceKey = null;
      previousSourceIsUnprovenImport = false;
      continue;
    }
    const signature = collapseDuplicateDisplaySignature(item.message);
    const sourceKey = collapseDuplicateSourceKey(item.message);
    const identity = readChatThreadMessageIdentity(item.message);
    const sourceIsUnprovenImport =
      sourceKey === null &&
      identity?.isImported === true &&
      identity.externalSource === null &&
      identity.sequence === null;
    const previous = collapsed[collapsed.length - 1];
    if (
      sourceKey &&
      previousSourceKey === sourceKey &&
      previous?.kind === "message" &&
      isSameSourceRelayNativeDuplicate(previous.message, item.message)
    ) {
      if (!prefersNativeChatSurface(previous.message) && prefersNativeChatSurface(item.message)) {
        collapsed[collapsed.length - 1] = item;
        previousSignature = signature;
      }
      continue;
    }
    if (
      signature &&
      previousSignature === signature &&
      previous?.kind === "message" &&
      !sourceIsUnprovenImport &&
      !previousSourceIsUnprovenImport &&
      !(sourceKey && previousSourceKey && sourceKey !== previousSourceKey)
    ) {
      previous.duplicateCount = (previous.duplicateCount ?? 1) + 1;
      continue;
    }
    collapsed.push(item);
    previousSignature = signature;
    previousSourceKey = sourceKey;
    previousSourceIsUnprovenImport = sourceIsUnprovenImport;
  }

  return collapsed;
}
