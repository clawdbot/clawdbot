// Transcript headers record session identity and version as the first JSONL entry.
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "./version.js";

/** Inputs for the first JSONL entry in a session transcript. */
type SessionTranscriptHeaderParams = {
  sessionId?: string;
  cwd?: string;
  /** Source transcript lineage recorded on forked transcript headers. */
  parentSession?: string;
  /** Stable timestamp shared with sibling records written in the same operation. */
  timestamp?: string;
};

/** Creates a session transcript header entry with current version metadata. */
export function createSessionTranscriptHeader(params: SessionTranscriptHeaderParams = {}) {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId ?? randomUUID(),
    timestamp: params.timestamp ?? new Date().toISOString(),
    cwd: params.cwd ?? process.cwd(),
    ...(params.parentSession ? { parentSession: params.parentSession } : {}),
  };
}
