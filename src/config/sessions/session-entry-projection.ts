import type { InternalSessionEntry, SessionEntry } from "./types.js";

export const SESSION_ENTRY_PRIVATE_CLEAR_PATCH = {
  activeWriterRunId: undefined,
  lifecycleRunId: undefined,
  mainRestartRecovery: undefined,
  sessionDiffBaselineCapture: undefined,
} satisfies Partial<InternalSessionEntry>;

const PRIVATE_SESSION_ENTRY_KEYS = [
  "activeWriterRunId",
  "lifecycleRunId",
  "mainRestartRecovery",
  "sessionDiffBaselineCapture",
] as const satisfies readonly (keyof InternalSessionEntry)[];

function stripPrivateSessionEntryFields(entry: InternalSessionEntry): SessionEntry;
function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry>,
): Partial<SessionEntry>;
function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry>,
): Partial<SessionEntry> {
  const projected = { ...entry };
  for (const key of PRIVATE_SESSION_ENTRY_KEYS) {
    delete projected[key];
  }
  return projected;
}

export function projectPublicSessionEntry(entry: InternalSessionEntry): SessionEntry {
  return stripPrivateSessionEntryFields(entry);
}

export function projectPublicSessionEntryPatch(
  patch: Partial<InternalSessionEntry>,
): Partial<SessionEntry> {
  return stripPrivateSessionEntryFields(patch);
}
