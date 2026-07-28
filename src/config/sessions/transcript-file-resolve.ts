// Resolves transcript file targets without depending on transcript read/write facades.
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "./paths.js";
import { resolveAndPersistSessionFile } from "./session-file.js";
import type { SessionEntry } from "./types.js";

/**
 * Resolves the transcript file for a session and persists the resolved target
 * when the caller supplies the owning session store.
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
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const resolvedSessionFile = await resolveAndPersistSessionFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      sessionEntry,
      agentId: sessionPathOpts?.agentId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return {
    sessionFile,
    sessionEntry,
  };
}
