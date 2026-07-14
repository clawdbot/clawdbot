import type { FastMode, SessionsPatchResult } from "../../api/types.ts";

export type SessionPatch = {
  label?: string | null;
  category?: string | null;
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
};

export type SessionPatchRoute = (
  key: string,
  patch: SessionPatch,
  options?: SessionPatchOptions,
) => Promise<SessionsPatchResult | null>;
