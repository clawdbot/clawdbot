import type { FastMode, SessionsPatchResult } from "../../api/types.ts";

export type SessionPatch = {
  label?: string | null;
  category?: string | null;
  boardFace?: "chat" | "dashboard";
  icon?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  fastMode?: FastMode | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
};

export type SessionPatchOptions = {
  agentId?: string;
  /** Capture the current connection now, but dispatch only after this tail settles. */
  waitFor?: Promise<unknown>;
  /**
   * Skips the canonical list refresh this patch forces. Batch callers own one
   * refresh after their last row; otherwise an N-row batch pays N full
   * `sessions.list` round trips while `sessions.changed` already reconciles.
   */
  deferListRefresh?: boolean;
};

export type SessionPatchRoute = (
  key: string,
  patch: SessionPatch,
  options?: SessionPatchOptions,
) => Promise<SessionsPatchResult | null>;
