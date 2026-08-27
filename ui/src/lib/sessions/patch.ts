import type { SessionPermissionMode } from "../../../../packages/gateway-protocol/src/index.js";
import type { FastMode, SessionsPatchResult } from "../../api/types.ts";

export type SessionToolOverrides = {
  mcpServers?: Record<string, boolean>;
  mcpToolsDeny?: Record<string, string[]>;
  skills?: Record<string, boolean>;
  webSearch?: boolean;
};

export type SessionPatch = {
  label?: string | null;
  icon?: string | null;
  category?: string | null;
  boardFace?: "chat" | "dashboard";
  model?: string | null;
  contextWindow?: string | null;
  thinkingLevel?: string | null;
  fastMode?: FastMode | null;
  verboseLevel?: string | null;
  reasoningLevel?: string | null;
  permissionMode?: SessionPermissionMode | null;
  toolOverrides?: SessionToolOverrides | null;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
};

export type SessionPatchOptions = {
  agentId?: string;
  /** Durable identity observed with the row before the action or edit began. */
  expectedSessionId?: string;
  /** Explicit unread marker observed by an automatic read acknowledgement. */
  expectedMarkedUnreadAt?: number | null;
  /** Keep optimistic model state bound to the UI owner that initiated the patch. */
  ownsModelOverride?: () => boolean;
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
