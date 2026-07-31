/** Runtime-only dispatch dependencies shared by config-driven reply delivery. */
/** Runtime-only dispatch dependencies shared by config-driven reply delivery. */
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export { resolveStorePath } from "../../config/sessions/paths.js";
export { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";

export function loadSessionStoreEntry(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  readConsistency?: "latest";
  clone?: boolean;
}): SessionEntry | undefined {
  return loadSessionEntryReadOnly(params);
}
