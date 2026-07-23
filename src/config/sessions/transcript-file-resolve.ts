import type { SessionEntry } from "./types.js";

/**
 * Legacy command shim: runtime storage uses the returned session key only as a
 * process-local routing token; SQLite identity travels separately.
 */
export async function resolveSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  return {
    sessionFile: params.sessionKey,
    sessionEntry: params.sessionEntry,
  };
}
