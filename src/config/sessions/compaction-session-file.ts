// Compaction session-file rotation shares the same owner as session path resolution.
import path from "node:path";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "./paths.js";
import {
  canonicalizeAbsoluteSessionFilePath,
  rewriteSessionFileForNewSessionId,
} from "./session-file-rotation.js";
import type { SessionEntry } from "./types.js";

export function resolveCompactionSessionFile(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath?: string;
  defaultAgentId?: string;
  newSessionId: string;
}): string {
  const agentId = resolveAgentIdFromSessionKey(
    params.sessionKey,
    params.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
  );
  const pathOpts = resolveSessionFilePathOptions({
    agentId,
    storePath: params.storePath,
  });
  const rewrittenSessionFile = rewriteSessionFileForNewSessionId({
    sessionFile: params.entry.sessionFile,
    previousSessionId: params.entry.sessionId,
    nextSessionId: params.newSessionId,
  });
  const normalizedRewrittenSessionFile =
    rewrittenSessionFile && path.isAbsolute(rewrittenSessionFile)
      ? canonicalizeAbsoluteSessionFilePath(rewrittenSessionFile)
      : rewrittenSessionFile;
  return resolveSessionFilePath(
    params.newSessionId,
    normalizedRewrittenSessionFile ? { sessionFile: normalizedRewrittenSessionFile } : undefined,
    pathOpts,
  );
}
