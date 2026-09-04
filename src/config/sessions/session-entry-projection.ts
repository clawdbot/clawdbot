import type { AgentPatchedSessionModelFallback } from "./session-model-fallback.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

type RetiredThinkingSelectionQuarantine = {
  thinkingLevelSelection?: unknown;
  modelFallback?: AgentPatchedSessionModelFallback & { prevThinkingLevelSelection?: unknown };
};

export const SESSION_ENTRY_PRIVATE_CLEAR_PATCH = {
  activeWriterRunId: undefined,
  lastRunId: undefined,
  lifecycleRunId: undefined,
  mainRestartRecovery: undefined,
  pendingProjectGitUrl: undefined,
  pendingWorktree: undefined,
  sessionDiffBaselineCapture: undefined,
  transcriptByteCompactionLatch: undefined,
} satisfies Partial<InternalSessionEntry>;

const PRIVATE_SESSION_ENTRY_KEYS = [
  "activeWriterRunId",
  "lastRunId",
  "lifecycleRunId",
  "mainRestartRecovery",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "sessionDiffBaselineCapture",
  "transcriptByteCompactionLatch",
] as const satisfies readonly (keyof InternalSessionEntry)[];

function projectPublicModelFallback(
  fallback: RetiredThinkingSelectionQuarantine["modelFallback"],
): AgentPatchedSessionModelFallback | undefined {
  if (!fallback) {
    return undefined;
  }
  const { prevThinkingLevelSelection: _privateSelection, ...publicFallback } = fallback;
  return publicFallback;
}

function stripPrivateSessionEntryFields(entry: InternalSessionEntry): SessionEntry;
function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry>,
): Partial<SessionEntry>;
function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry> & RetiredThinkingSelectionQuarantine,
): Partial<SessionEntry> {
  const projected = { ...entry };
  for (const key of PRIVATE_SESSION_ENTRY_KEYS) {
    delete projected[key];
  }
  delete projected.thinkingLevelSelection;
  const modelFallback = projectPublicModelFallback(entry.modelFallback);
  if (modelFallback) {
    projected.modelFallback = modelFallback;
  } else {
    delete projected.modelFallback;
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
