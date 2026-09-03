import { escapeRegExp } from "../../../../src/shared/regexp.js";
import type { ChatItem, NormalizedMessage } from "../../lib/chat/chat-types.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { senderIdentityKey } from "../../lib/chat/sender-label.ts";
import { isPendingSendMessage, readChatThreadMessageIdentity } from "./chat-thread-items.ts";

type PreparedChatItem =
  | Exclude<ChatItem, { kind: "message" }>
  | {
      kind: "message";
      item: Extract<ChatItem, { kind: "message" }>;
      normalized: NormalizedMessage;
    };

function collapseDuplicateSourceKey(
  identity: ReturnType<typeof readChatThreadMessageIdentity>,
  role: string,
): string | null {
  if (role !== "assistant" && role !== "user") {
    return null;
  }
  if (!identity?.isImported) {
    return identity?.id ? `${role}:${identity.id}` : null;
  }
  if (identity.externalSource) {
    return `${role}:import:${identity.externalSource}`;
  }
  return identity.sequence === null ? null : `${role}:import-seq:${identity.sequence}`;
}

function stripSenderLabelPrefix(text: string, senderLabel: string): string {
  return text.replace(new RegExp(`^${escapeRegExp(senderLabel)}(?::|：|-|—)?[ \\t]+`), "");
}

function textOnlyMessageParts(normalized: NormalizedMessage, role: string) {
  if (normalized.content.length === 0) {
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
    role,
    senderLabel: (normalized.senderLabel ?? "").trim(),
    senderKey: senderIdentityKey(normalized.sender),
    senderSession: normalized.senderSession,
    text: textParts.join("\n"),
  };
}

type TextOnlyMessageParts = ReturnType<typeof textOnlyMessageParts>;

function isSameSourceRelayNativeDuplicate(
  previous: TextOnlyMessageParts,
  next: TextOnlyMessageParts,
): boolean {
  if (
    previous?.role !== "assistant" ||
    next?.role !== "assistant" ||
    !previous.text.trim() ||
    !next.text.trim() ||
    Boolean(previous.senderLabel) === Boolean(next.senderLabel)
  ) {
    return false;
  }
  const labeled = previous.senderLabel ? previous : next;
  const native = previous.senderLabel ? next : previous;
  return (
    labeled.text === native.text ||
    stripSenderLabelPrefix(labeled.text, labeled.senderLabel) === native.text
  );
}

function collapseDuplicateDisplaySignature(parts: TextOnlyMessageParts): string | null {
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

export function prepareMessagesForGrouping(items: ChatItem[]): PreparedChatItem[] {
  const collapsed: PreparedChatItem[] = [];
  let previousParts: TextOnlyMessageParts = null;
  let previousSourceKey: string | null = null;
  let previousSourceIsUnprovenImport = false;

  for (const item of items) {
    if (item.kind !== "message") {
      collapsed.push(item);
      previousParts = null;
      previousSourceKey = null;
      previousSourceIsUnprovenImport = false;
      continue;
    }
    // These facts belong to this grouping pass, after canvas/tool projections
    // finish changing content. A later build must see fresh message metadata.
    const normalized = normalizeMessage(item.message);
    const prepared = { kind: "message" as const, item, normalized };
    const role = normalizeRoleForGrouping(normalized.role).toLowerCase();
    const pending = isPendingSendMessage(item.message);
    const parts = pending ? null : textOnlyMessageParts(normalized, role);
    const identity = readChatThreadMessageIdentity(item.message);
    const sourceKey = pending ? null : collapseDuplicateSourceKey(identity, role);
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
      isSameSourceRelayNativeDuplicate(previousParts, parts)
    ) {
      if (!parts?.senderLabel) {
        collapsed[collapsed.length - 1] = prepared;
        previousParts = parts;
      }
      continue;
    }
    // Distinct transcript identities cannot collapse. Compare full display text
    // only for adjacent candidates whose source and role still permit a replay.
    if (
      previous?.kind === "message" &&
      !sourceIsUnprovenImport &&
      !previousSourceIsUnprovenImport &&
      !(sourceKey && previousSourceKey && sourceKey !== previousSourceKey) &&
      parts?.role === previousParts?.role
    ) {
      const signature = collapseDuplicateDisplaySignature(parts);
      if (signature && signature === collapseDuplicateDisplaySignature(previousParts)) {
        previous.item.duplicateCount = (previous.item.duplicateCount ?? 1) + 1;
        continue;
      }
    }
    collapsed.push(prepared);
    previousParts = parts;
    previousSourceKey = sourceKey;
    previousSourceIsUnprovenImport = sourceIsUnprovenImport;
  }

  return collapsed;
}
