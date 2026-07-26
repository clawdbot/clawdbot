// Session skill suggestions are one-shot hints consumed by the next interactive turn.
import {
  loadSessionEntryReadOnly,
  patchSessionEntry,
  type SessionAccessScope,
} from "./session-accessor.js";
import type { PendingSkillSuggestion, SessionEntry } from "./types.js";

const MAX_SKILL_CAPTURE_SIGNAL_HASHES = 32;

type SessionSkillSuggestionScope = Pick<
  SessionAccessScope,
  "agentId" | "env" | "sessionKey" | "storePath"
>;

type SessionSkillSuggestionConsumption = {
  entry: SessionEntry;
  suggestion?: PendingSkillSuggestion;
};

function normalizeSignalHashes(signalHashes: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const value of signalHashes) {
    const hash = value.trim();
    if (hash && !normalized.includes(hash)) {
      normalized.push(hash);
    }
  }
  return normalized;
}

function appendSignalHashes(entry: SessionEntry, signalHashes: readonly string[]): string[] {
  const hashes = [...(entry.skillCaptureSignalHashes ?? [])];
  for (const hash of signalHashes) {
    const previousIndex = hashes.indexOf(hash);
    if (previousIndex >= 0) {
      hashes.splice(previousIndex, 1);
    }
    hashes.push(hash);
  }
  return hashes.slice(-MAX_SKILL_CAPTURE_SIGNAL_HASHES);
}

/** Reads recent durable-instruction fingerprints, oldest first. */
export function readSessionSkillCaptureSignalHashes(
  options: SessionSkillSuggestionScope,
): string[] | undefined {
  const entry = loadSessionEntryReadOnly({ ...options, readConsistency: "latest" });
  return entry ? [...(entry.skillCaptureSignalHashes ?? [])] : undefined;
}

/** Records processed durable-instruction fingerprints in a bounded newest-last ring. */
export async function recordSessionSkillCaptureSignals(
  options: SessionSkillSuggestionScope & { signalHashes: readonly string[] },
): Promise<boolean> {
  const signalHashes = normalizeSignalHashes(options.signalHashes);
  if (signalHashes.length === 0) {
    return false;
  }
  const result = await patchSessionEntry(
    options,
    (entry) => ({ skillCaptureSignalHashes: appendSignalHashes(entry, signalHashes) }),
    { preserveActivity: true },
  );
  return Boolean(result);
}

/** Atomically claims one instruction group and returns only the hashes added by this claim. */
export async function claimSessionSkillCaptureSignals(
  options: SessionSkillSuggestionScope & {
    signalHash: string;
    signalHashes: readonly string[];
  },
): Promise<string[] | undefined> {
  const signalHash = options.signalHash.trim();
  const signalHashes = normalizeSignalHashes(options.signalHashes);
  if (!signalHash || signalHashes.length === 0) {
    return undefined;
  }
  let claimedSignalHashes: string[] | undefined;
  const result = await patchSessionEntry(
    options,
    (entry) => {
      if (entry.skillCaptureSignalHashes?.includes(signalHash)) {
        return null;
      }
      claimedSignalHashes = signalHashes.filter(
        (hash) => !entry.skillCaptureSignalHashes?.includes(hash),
      );
      return {
        skillCaptureSignalHashes: appendSignalHashes(entry, signalHashes),
      };
    },
    { preserveActivity: true },
  );
  return result ? claimedSignalHashes : undefined;
}

/** Releases a failed claim so a later agent-end replay can retry the group. */
export async function releaseSessionSkillCaptureSignals(
  options: SessionSkillSuggestionScope & { signalHashes: readonly string[] },
): Promise<void> {
  const released = new Set(normalizeSignalHashes(options.signalHashes));
  if (released.size === 0) {
    return;
  }
  await patchSessionEntry(
    options,
    (entry) => ({
      skillCaptureSignalHashes: entry.skillCaptureSignalHashes?.filter(
        (hash) => !released.has(hash),
      ),
    }),
    { preserveActivity: true },
  );
}

/** Records one suggestion without replacing an earlier unconsumed suggestion. */
export async function recordSessionSkillSuggestion(
  options: SessionSkillSuggestionScope & {
    skillName: string;
    signalHash: string;
    relatedSignalHashes?: readonly string[];
    detectedAt?: number;
  },
): Promise<boolean> {
  const skillName = options.skillName.trim();
  const signalHash = options.signalHash.trim();
  if (!skillName || !signalHash) {
    return false;
  }
  let recorded = false;
  const result = await patchSessionEntry(
    {
      agentId: options.agentId,
      env: options.env,
      sessionKey: options.sessionKey,
      storePath: options.storePath,
    },
    (entry) => {
      if (entry.pendingSkillSuggestion || entry.skillCaptureSignalHashes?.includes(signalHash)) {
        return null;
      }
      const signalHashes = normalizeSignalHashes([
        ...(options.relatedSignalHashes ?? []),
        signalHash,
      ]);
      recorded = true;
      return {
        pendingSkillSuggestion: {
          skillName,
          detectedAt: options.detectedAt ?? Date.now(),
        },
        skillCaptureSignalHashes: appendSignalHashes(entry, signalHashes),
      };
    },
    { preserveActivity: true },
  );
  return Boolean(result && recorded);
}

/** Atomically clears and returns the suggestion owned by this interactive turn. */
export async function consumeSessionSkillSuggestion(
  options: SessionSkillSuggestionScope,
): Promise<SessionSkillSuggestionConsumption | undefined> {
  let currentEntry: SessionEntry | undefined;
  let suggestion: PendingSkillSuggestion | undefined;
  const result = await patchSessionEntry(
    options,
    (entry) => {
      currentEntry = entry;
      if (!entry.pendingSkillSuggestion) {
        return null;
      }
      suggestion = { ...entry.pendingSkillSuggestion };
      return { pendingSkillSuggestion: undefined };
    },
    { preserveActivity: true },
  );
  const entry = result ?? currentEntry;
  return entry ? { entry, suggestion } : undefined;
}
