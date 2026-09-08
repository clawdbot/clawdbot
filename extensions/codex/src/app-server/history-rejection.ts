export type CodexHistoryRejectionReason =
  | "item_limit"
  | "byte_limit"
  | "field_limit"
  | "unsupported_user_image"
  | "unsupported_content"
  | "invalid_content"
  | "invalid_pairing"
  | "incomplete_pairing"
  | "provenance_rejected"
  | "malformed_header"
  | "access_rejected"
  | "snapshot_invalidated"
  | "cancelled"
  | "model_unavailable"
  | "history_read_failed";

export type CodexHistoryReadResult<T> =
  | { status: "ok"; value: T }
  | { status: "rejected"; reason: CodexHistoryRejectionReason };

/** Only an owning rejection site can supply a diagnostic; exception text is never evidence. */
export class CodexHistoryRejection extends Error {
  constructor(readonly reason: CodexHistoryRejectionReason) {
    super(`Codex history rejected: ${reason}`);
  }
}

export function codexHistoryRejectionReason(error: unknown): CodexHistoryRejectionReason {
  return error instanceof CodexHistoryRejection ? error.reason : "history_read_failed";
}
