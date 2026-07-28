import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

type TranscriptMessageIdentity = {
  role: string;
  signature: string | null;
  isImported: boolean;
  externalSource: string | null;
  id: string | null;
  sequence: number | null;
  idempotencyKey: string | null;
};

type IndexedHistoryMessage = {
  index: number;
  identity: TranscriptMessageIdentity;
  message: unknown;
};

type HistoryMessageIndex = Map<string, IndexedHistoryMessage[]>;

const liveAuthoritativeUserMessages = new WeakSet<object>();

function readTranscriptMetadata(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function readMetadataString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function hasTranscriptMeta(message: unknown): boolean {
  const metadata = readTranscriptMetadata(message);
  // An idempotency marker alone identifies a locally materialized queued turn;
  // authoritative transcript metadata adds identity, sequence, or kind fields.
  return metadata !== null && Object.keys(metadata).some((key) => key !== "idempotencyKey");
}

export function readTranscriptSequence(message: unknown): number | null {
  const seq = readTranscriptMetadata(message)?.seq;
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

function readTranscriptMessageIdentity(message: unknown): TranscriptMessageIdentity {
  const metadata = readTranscriptMetadata(message);
  const externalId = readMetadataString(metadata?.externalId);
  const importedFrom = readMetadataString(metadata?.importedFrom);
  const cliSessionId = readMetadataString(metadata?.cliSessionId);
  const isImported = Boolean(externalId || importedFrom || cliSessionId);
  // Imported ids are source-local. A partial source tuple cannot prove that
  // two imports came from the same provider and CLI session.
  const externalSource =
    externalId && importedFrom && cliSessionId
      ? JSON.stringify([importedFrom, cliSessionId, externalId])
      : null;
  return {
    role:
      message && typeof message === "object"
        ? normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role)
        : "",
    signature: messageDisplaySignature(message),
    isImported,
    externalSource,
    id: readMetadataString(metadata?.id),
    sequence: readTranscriptSequence(message),
    idempotencyKey: readMetadataString(metadata?.idempotencyKey),
  };
}

function indexHistoryMessage(
  historyIndex: HistoryMessageIndex,
  key: string,
  entry: IndexedHistoryMessage,
): void {
  const entries = historyIndex.get(key);
  if (entries) {
    entries.push(entry);
    return;
  }
  historyIndex.set(key, [entry]);
}

function createHistoryMessageIndex(
  messages: unknown[],
  shouldHideMessage: (message: unknown) => boolean,
): HistoryMessageIndex {
  const historyIndex: HistoryMessageIndex = new Map();
  messages.forEach((message, index) => {
    if (shouldHideMessage(message)) {
      return;
    }
    const identity = readTranscriptMessageIdentity(message);
    const entry = { identity, index, message };
    if (identity.externalSource) {
      indexHistoryMessage(historyIndex, `external:${identity.externalSource}`, entry);
    }
    // Source-local import ids must never collide with canonical native ids.
    if (identity.id && !identity.isImported) {
      indexHistoryMessage(historyIndex, `id:${identity.id}`, entry);
    }
    if (identity.sequence !== null) {
      indexHistoryMessage(historyIndex, `seq:${identity.sequence}`, entry);
    }
    if (identity.idempotencyKey) {
      indexHistoryMessage(historyIndex, `send:${identity.idempotencyKey}`, entry);
    }
    if (identity.signature) {
      indexHistoryMessage(historyIndex, `display:${identity.signature}`, entry);
    }
    if (identity.role) {
      indexHistoryMessage(historyIndex, `role:${identity.role}`, entry);
    }
  });
  return historyIndex;
}

function findTranscriptHistoryAnchor(
  historyIndex: HistoryMessageIndex,
  message: unknown,
): IndexedHistoryMessage | null {
  const identity = readTranscriptMessageIdentity(message);
  // Imported identity is never display-only. Without the complete source
  // tuple, no source-local id can prove ownership of a transcript row.
  if (identity.isImported && !identity.externalSource) {
    return null;
  }
  const authoritativeKeys: string[] = [];
  if (identity.externalSource) {
    authoritativeKeys.push(`external:${identity.externalSource}`);
  }
  if (identity.id && !identity.isImported) {
    authoritativeKeys.push(`id:${identity.id}`);
  }
  if (identity.sequence !== null) {
    authoritativeKeys.push(`seq:${identity.sequence}`);
  }
  for (const key of authoritativeKeys) {
    const entries = historyIndex.get(key) ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      if (identity.role && entry.identity.role !== identity.role) {
        continue;
      }
      if (identity.isImported !== entry.identity.isImported) {
        continue;
      }
      if (identity.externalSource && entry.identity.externalSource !== identity.externalSource) {
        continue;
      }
      if (
        identity.id &&
        (!identity.isImported || entry.identity.id) &&
        entry.identity.id !== identity.id
      ) {
        continue;
      }
      if (
        identity.sequence !== null &&
        entry.identity.sequence !== null &&
        entry.identity.sequence !== identity.sequence
      ) {
        continue;
      }
      // A missing canonical id cannot prove which same-sequence projection is
      // being adopted. Preserve the projection check on every sequence fallback.
      if (
        key.startsWith("seq:") &&
        !identity.externalSource &&
        entry.identity.signature !== identity.signature
      ) {
        continue;
      }
      return entry;
    }
  }
  if (authoritativeKeys.length > 0 || !identity.signature) {
    return null;
  }
  const entries = (historyIndex.get(`display:${identity.signature}`) ?? []).filter(
    (entry) => entry.identity.isImported === identity.isImported,
  );
  const sameInstance = entries.find((entry) => entry.message === message);
  // Display text is not transcript identity. A copied legacy row is safe to
  // anchor only when its visible signature has exactly one history candidate.
  return sameInstance ?? (entries.length === 1 ? (entries[0] ?? null) : null);
}

export function rememberLiveAuthoritativeUserMessage(message: unknown): void {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return;
  }
  const identity = readTranscriptMessageIdentity(message);
  if (identity.role === "user" && (identity.id !== null || identity.sequence !== null)) {
    liveAuthoritativeUserMessages.add(message);
  }
}

export function preserveLiveAuthoritativeUserMessages(
  historyMessages: unknown[],
  currentMessages: unknown[],
  shouldHideMessage: (message: unknown) => boolean = () => false,
): unknown[] {
  let preservedMessages = historyMessages;
  for (let currentIndex = 0; currentIndex < currentMessages.length; currentIndex += 1) {
    const message = currentMessages[currentIndex];
    if (
      !message ||
      typeof message !== "object" ||
      !liveAuthoritativeUserMessages.has(message) ||
      shouldHideMessage(message)
    ) {
      continue;
    }
    const historyIndex = createHistoryMessageIndex(preservedMessages, shouldHideMessage);
    if (findTranscriptHistoryAnchor(historyIndex, message)) {
      continue;
    }
    const sequence = readTranscriptSequence(message);
    let insertionIndex =
      sequence === null
        ? -1
        : preservedMessages.findIndex((candidate) => {
            const candidateSequence = readTranscriptSequence(candidate);
            return candidateSequence !== null && candidateSequence > sequence;
          });
    if (insertionIndex < 0 && sequence === null) {
      for (const nextMessage of currentMessages.slice(currentIndex + 1)) {
        const anchor = findTranscriptHistoryAnchor(historyIndex, nextMessage);
        if (anchor) {
          insertionIndex = anchor.index;
          break;
        }
      }
    }
    // Only a gateway-projected, identity-backed prompt may outlive a stale
    // snapshot; transcript sequence or the next known row keeps its reply after it.
    preservedMessages = preservedMessages.toSpliced(
      insertionIndex < 0 ? preservedMessages.length : insertionIndex,
      0,
      message,
    );
  }
  return preservedMessages;
}

function findOptimisticHistoryMatch(
  historyIndex: HistoryMessageIndex,
  identity: TranscriptMessageIdentity,
  afterIndex: number,
): IndexedHistoryMessage | "ambiguous" | null {
  if (identity.idempotencyKey) {
    const entries = historyIndex.get(`send:${identity.idempotencyKey}`) ?? [];
    // A send already persisted before the active anchor is still consumed;
    // only a later match is allowed to advance that anchor.
    return entries.findLast((entry) => entry.index > afterIndex) ?? entries.at(-1) ?? null;
  }
  if (!identity.signature) {
    return null;
  }
  const entries = (historyIndex.get(`display:${identity.signature}`) ?? []).filter(
    (entry) => entry.index > afterIndex,
  );
  if (entries.length > 1) {
    return "ambiguous";
  }
  if (entries[0]) {
    return entries[0];
  }
  if (identity.role !== "assistant") {
    return null;
  }
  const assistantEntries = (historyIndex.get("role:assistant") ?? []).filter(
    (entry) => entry.index > afterIndex,
  );
  // A persisted assistant can complete a partial stream with different text;
  // never replay that stream as an extra assistant answer.
  if (assistantEntries.length > 1) {
    return "ambiguous";
  }
  return assistantEntries[0] ?? null;
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
  const historyIndex = createHistoryMessageIndex(historyMessages, shouldHideMessage);
  let sharedPreviousIndex = -1;
  let sharedHistoryIndex = -1;
  let sharedHistorySignature: string | null = null;
  for (let index = previousMessages.length - 1; index >= 0; index--) {
    const message = previousMessages[index];
    // Only transcript-backed rows can anchor history; a newer optimistic turn
    // may intentionally repeat an earlier user's exact visible text.
    if (isLocallyOptimisticHistoryMessage(message) || shouldHideMessage(message)) {
      continue;
    }
    const historyEntry = findTranscriptHistoryAnchor(historyIndex, message);
    if (historyEntry) {
      sharedPreviousIndex = index;
      sharedHistoryIndex = historyEntry.index;
      sharedHistorySignature = historyEntry.identity.signature;
      break;
    }
  }
  if (sharedPreviousIndex < 0) {
    return historyMessages;
  }
  const optimisticTail: unknown[] = [];
  let consumedPersistedTurn = false;
  for (const message of previousMessages.slice(sharedPreviousIndex + 1)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideMessage(message)) {
      return historyMessages;
    }
    const identity = readTranscriptMessageIdentity(message);
    if (!identity.signature) {
      return historyMessages;
    }
    // A consumed historical send owns its following optimistic assistant;
    // retaining that stream would duplicate the already-persisted answer.
    if (consumedPersistedTurn && identity.role === "assistant") {
      continue;
    }
    if (optimisticTail.length === 0) {
      const historyMatch = findOptimisticHistoryMatch(historyIndex, identity, sharedHistoryIndex);
      if (historyMatch === "ambiguous") {
        return historyMessages;
      }
      if (historyMatch) {
        if (historyMatch.index > sharedHistoryIndex) {
          sharedHistoryIndex = historyMatch.index;
          sharedHistorySignature = historyMatch.identity.signature;
          consumedPersistedTurn = false;
        } else if (identity.role === "user") {
          consumedPersistedTurn = true;
        }
        continue;
      }
      // Only a pending send with its own identity may cross a repeated
      // projection; identity-free tails may belong to the replaced snapshot.
      if (
        sharedHistoryIndex < historyMessages.length - 1 &&
        (!identity.idempotencyKey ||
          historyMessages.slice(sharedHistoryIndex + 1).some((historyMessage) => {
            if (shouldHideMessage(historyMessage)) {
              return false;
            }
            const historyIdentity = readTranscriptMessageIdentity(historyMessage);
            const historySignature = historyIdentity.signature;
            // A persisted repeat may follow a differently worded anchor; a
            // distinct send key proves that row cannot consume this turn.
            const isDistinctPersistedSend =
              historySignature === identity.signature &&
              historyIdentity.idempotencyKey !== null &&
              historyIdentity.idempotencyKey !== identity.idempotencyKey;
            return (
              sharedHistorySignature === null ||
              historySignature === null ||
              (historySignature !== sharedHistorySignature && !isDistinctPersistedSend) ||
              (historySignature === identity.signature && historyIdentity.idempotencyKey === null)
            );
          }))
      ) {
        return historyMessages;
      }
    }
    if (identity.role === "user") {
      consumedPersistedTurn = false;
    }
    optimisticTail.push(message);
  }
  return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
}
