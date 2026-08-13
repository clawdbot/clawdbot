const VISIBLE_MESSAGE_CURSOR_VERSION = 1;
export const DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES = 1_000;
export const DEFAULT_VISIBLE_MESSAGE_MAX_BYTES = 1_000_000;
export const MAX_VISIBLE_MESSAGE_MAX_MESSAGES = 10_000;
export const MAX_VISIBLE_MESSAGE_MAX_BYTES = 64 * 1024 * 1024;

type VisibleMessageCursor = {
  agentId: string;
  generation: string;
  lastEventSeq: number;
  lastMessagePosition: number;
  sessionId: string;
  version: typeof VISIBLE_MESSAGE_CURSOR_VERSION;
};

export function normalizeVisibleMessageLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return resolved;
}

export function encodeVisibleMessageCursor(cursor: VisibleMessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function createVisibleMessageCursor(params: {
  agentId: string;
  generation: string;
  sessionId: string;
}): VisibleMessageCursor {
  return {
    ...params,
    lastEventSeq: -1,
    lastMessagePosition: -1,
    version: VISIBLE_MESSAGE_CURSOR_VERSION,
  };
}

export function parseVisibleMessageCursor(value: string): VisibleMessageCursor | undefined {
  // The cursor is a continuation hint, not an authorization token. Every field
  // is revalidated against the current scope, generation, and projection.
  if (value.length > 4_096) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<VisibleMessageCursor>;
    if (
      parsed.version !== VISIBLE_MESSAGE_CURSOR_VERSION ||
      typeof parsed.agentId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.generation !== "string" ||
      !Number.isSafeInteger(parsed.lastEventSeq) ||
      (parsed.lastEventSeq ?? -2) < -1 ||
      !Number.isSafeInteger(parsed.lastMessagePosition) ||
      (parsed.lastMessagePosition ?? -2) < -1 ||
      (parsed.lastEventSeq === -1) !== (parsed.lastMessagePosition === -1)
    ) {
      return undefined;
    }
    return parsed as VisibleMessageCursor;
  } catch {
    return undefined;
  }
}
