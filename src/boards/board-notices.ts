import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { enqueueSystemEvent } from "../infra/system-events.js";

const BOARD_EVENT_MAX_BYTES = 8 * 1024;
const BOARD_NOTICE_MAX_CHARS = 500;
const BOARD_EVENT_DEDUPE_MS = 5_000;

const recentNotices = new Map<string, { summary: string; at: number }>();

export class BoardEventPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardEventPayloadError";
  }
}

function serializePayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    return serialized === undefined ? String(payload) : serialized;
  } catch {
    throw new BoardEventPayloadError("board event payload must be JSON serializable");
  }
}

function formatNotice(widget: string, summary: string): string {
  const prefix = "[dashboard] ";
  const suffix = ` on widget ${widget}`;
  const available = BOARD_NOTICE_MAX_CHARS - prefix.length - suffix.length;
  const clipped =
    summary.length <= available
      ? summary
      : `${truncateUtf16Safe(summary, Math.max(0, available - 1))}…`;
  return `${prefix}${clipped}${suffix}`;
}

export function appendBoardEventNotice(params: {
  sessionKey: string;
  widget: string;
  payload: unknown;
  now?: number;
}): boolean {
  const summary = serializePayload(params.payload);
  if (Buffer.byteLength(summary, "utf8") > BOARD_EVENT_MAX_BYTES) {
    throw new BoardEventPayloadError(`board event payload exceeds ${BOARD_EVENT_MAX_BYTES} bytes`);
  }
  const now = params.now ?? Date.now();
  const key = `${params.sessionKey}\0${params.widget}`;
  const recent = recentNotices.get(key);
  if (recent?.summary === summary && now - recent.at < BOARD_EVENT_DEDUPE_MS) {
    return false;
  }
  recentNotices.set(key, { summary, at: now });
  for (const [candidate, notice] of recentNotices) {
    if (now - notice.at >= BOARD_EVENT_DEDUPE_MS) {
      recentNotices.delete(candidate);
    }
  }
  return enqueueSystemEvent(formatNotice(params.widget, summary), {
    sessionKey: params.sessionKey,
    contextKey: `dashboard:${params.widget}:${now}`,
  });
}

export function resetBoardEventNoticeStateForTest(): void {
  recentNotices.clear();
}
