import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
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
  agentId?: string;
  widget: string;
  payload: unknown;
  now?: number;
}): boolean {
  const summary = serializePayload(params.payload);
  if (Buffer.byteLength(summary, "utf8") > BOARD_EVENT_MAX_BYTES) {
    throw new BoardEventPayloadError(`board event payload exceeds ${BOARD_EVENT_MAX_BYTES} bytes`);
  }
  const now = params.now ?? Date.now();
  // Global session keys and widget names can coincide across different owners.
  const key = `${params.agentId ?? ""}\0${params.sessionKey}\0${params.widget}`;
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
  const options = {
    sessionKey: params.sessionKey,
    contextKey: `dashboard:${params.widget}:${now}`,
  };
  return enqueueSystemEvent(
    formatNotice(params.widget, summary),
    params.agentId ? withSystemEventOwner(options, params.agentId) : options,
  );
}

export function resetBoardEventNoticeStateForTest(): void {
  recentNotices.clear();
}
