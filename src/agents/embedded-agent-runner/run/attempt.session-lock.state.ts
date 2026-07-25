import type { OwnedSessionTranscriptPublishedEntry } from "../../../config/sessions/transcript-write-context.js";
import { resolveEmbeddedSessionFileKey } from "../session-file-key.js";
import {
  sameSessionFileFingerprint,
  type SessionFileFingerprint,
} from "./attempt.session-lock.fence.js";

type OwnedSessionFileWrite = {
  generation: number;
  fingerprint: SessionFileFingerprint;
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
  requiresReload?: true;
};

type OwnedSessionFileWriteHistory = {
  activeFenceGenerations: Map<symbol, number>;
  writes: OwnedSessionFileWrite[];
};

type TrustedSessionFileState = {
  generation: number;
  fingerprint: SessionFileFingerprint;
};

// Controllers in the same OpenClaw process can legitimately take turns writing
// the same session file while another attempt is released for model I/O. Track
// only fingerprints that changed while OpenClaw held the write lock so the
// takeover fence can distinguish those locked in-process writes from unowned
// external file changes.
const ownedSessionFileWrites = new Map<string, OwnedSessionFileWriteHistory>();
const trustedSessionFileStates = new Map<string, TrustedSessionFileState>();
let ownedSessionFileWriteGeneration = 0;

export function resolveSessionFileFenceKey(sessionFile: string): string {
  return resolveEmbeddedSessionFileKey(sessionFile);
}

export function resetSessionFileFenceStateForTest(): void {
  ownedSessionFileWrites.clear();
  trustedSessionFileStates.clear();
  ownedSessionFileWriteGeneration = 0;
}

export function resolveOwnedSessionFileWriteHistory(
  sessionFileKey: string,
): OwnedSessionFileWriteHistory {
  const existing = ownedSessionFileWrites.get(sessionFileKey);
  if (existing) {
    return existing;
  }
  const created = {
    activeFenceGenerations: new Map<symbol, number>(),
    writes: [],
  };
  ownedSessionFileWrites.set(sessionFileKey, created);
  return created;
}

export function getOwnedSessionFileWriteHistory(
  sessionFileKey: string,
): OwnedSessionFileWriteHistory | undefined {
  return ownedSessionFileWrites.get(sessionFileKey);
}

export function pruneOwnedSessionFileWriteHistory(
  sessionFileKey: string,
  history: OwnedSessionFileWriteHistory,
): void {
  if (history.activeFenceGenerations.size === 0) {
    ownedSessionFileWrites.delete(sessionFileKey);
    return;
  }
  const oldestFenceGeneration = Math.min(...history.activeFenceGenerations.values());
  history.writes = history.writes.filter((write) => write.generation > oldestFenceGeneration);
}

export function recordOwnedSessionFileWrite(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[],
  requiresReload?: true,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
    ...(publishedEntries ? { publishedEntries: [...publishedEntries] } : {}),
    ...(requiresReload ? { requiresReload } : {}),
  };
  const history = resolveOwnedSessionFileWriteHistory(sessionFileKey);
  history.writes.push(state);
  pruneOwnedSessionFileWriteHistory(sessionFileKey, history);
  trustedSessionFileStates.set(sessionFileKey, state);
  return ownedSessionFileWriteGeneration;
}

export function recordTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  };
  trustedSessionFileStates.set(sessionFileKey, state);
  return ownedSessionFileWriteGeneration;
}

export function trustSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number | undefined {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  if (trusted) {
    return sameSessionFileFingerprint(trusted.fingerprint, fingerprint)
      ? trusted.generation
      : undefined;
  }
  ownedSessionFileWriteGeneration += 1;
  trustedSessionFileStates.set(sessionFileKey, {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  });
  return ownedSessionFileWriteGeneration;
}

export function isTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): boolean {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  return trusted !== undefined && sameSessionFileFingerprint(trusted.fingerprint, fingerprint);
}
