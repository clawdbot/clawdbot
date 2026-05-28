import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION } from "./version.js";

export type SessionTranscriptHeaderParams = {
  sessionId?: string;
  cwd?: string;
};

export function createSessionTranscriptHeader(params: SessionTranscriptHeaderParams = {}) {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId ?? randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.cwd ?? process.cwd(),
  };
}
