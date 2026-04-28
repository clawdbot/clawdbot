const DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS = 60_000;
const MIN_DUPLICATE_USER_MESSAGE_CHARS = 24;

type MessageLike = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
};

type EntryLike = {
  id?: unknown;
  type?: unknown;
  message?: unknown;
};

type DuplicateUserMessageOptions = {
  windowMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUserMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.replace(/\s+/g, " ").trim();
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      return undefined;
    }
    if (block.type === "image") {
      return undefined;
    }
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.join("\n").replace(/\s+/g, " ").trim();
}

function duplicateSignature(message: unknown): { key: string; timestamp: number } | undefined {
  if (!isRecord(message) || message.role !== "user" || typeof message.timestamp !== "number") {
    return undefined;
  }
  const text = normalizeUserMessageContent(message.content);
  if (!text || text.length < MIN_DUPLICATE_USER_MESSAGE_CHARS) {
    return undefined;
  }
  return {
    key: text.normalize("NFC").toLowerCase(),
    timestamp: message.timestamp,
  };
}

export function dedupeDuplicateUserMessagesForCompaction<T extends MessageLike>(
  messages: readonly T[],
  options: DuplicateUserMessageOptions = {},
): T[] {
  const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
  const lastSeenAtByKey = new Map<string, number>();
  let removed = 0;
  const result: T[] = [];
  for (const message of messages) {
    const signature = duplicateSignature(message);
    if (!signature) {
      result.push(message);
      continue;
    }
    const lastSeenAt = lastSeenAtByKey.get(signature.key);
    lastSeenAtByKey.set(signature.key, signature.timestamp);
    if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) {
      removed += 1;
      continue;
    }
    result.push(message);
  }
  return removed > 0 ? result : [...messages];
}

export function collectDuplicateUserMessageEntryIdsForCompaction(
  entries: readonly EntryLike[],
  options: DuplicateUserMessageOptions = {},
): Set<string> {
  const windowMs = options.windowMs ?? DEFAULT_DUPLICATE_USER_MESSAGE_WINDOW_MS;
  const lastSeenAtByKey = new Map<string, number>();
  const duplicateIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || typeof entry.id !== "string") {
      continue;
    }
    const signature = duplicateSignature(
      isRecord(entry.message) ? (entry.message as MessageLike) : undefined,
    );
    if (!signature) {
      continue;
    }
    const lastSeenAt = lastSeenAtByKey.get(signature.key);
    lastSeenAtByKey.set(signature.key, signature.timestamp);
    if (typeof lastSeenAt === "number" && signature.timestamp - lastSeenAt <= windowMs) {
      duplicateIds.add(entry.id);
    }
  }
  return duplicateIds;
}
