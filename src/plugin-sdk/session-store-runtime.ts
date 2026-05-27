// Narrow session-store helpers for channel hot paths.

import { loadSessionStore as loadSessionStoreImpl } from "../config/sessions/store-load.js";

/**
 * @deprecated Use getSessionEntry/listSessionEntries for reads and
 * patchSessionEntry/upsertSessionEntry for writes. loadSessionStore keeps the
 * legacy mutable whole-store shape and will remain a compatibility escape hatch.
 */
export const loadSessionStore = loadSessionStoreImpl;

export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
export {
  resolveSessionFilePath,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
} from "../config/sessions/paths.js";
export { resolveAndPersistSessionFile } from "../config/sessions/session-file.js";
export { readLatestAssistantTextFromSessionTranscript } from "../config/sessions/transcript.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  clearSessionStoreCacheForTest,
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  saveSessionStore,
  updateLastRoute,
  updateSessionStore,
  updateSessionStoreEntry,
  upsertSessionEntry,
} from "../config/sessions/store.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export type { SessionEntry, SessionScope } from "../config/sessions/types.js";
