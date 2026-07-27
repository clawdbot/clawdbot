import { readFileSync } from "node:fs";
import type {
  OwnedSessionTranscriptCacheSnapshot,
  OwnedSessionTranscriptPublishedEntry,
} from "../../../config/sessions/transcript-write-context.js";
import { resolveEmbeddedSessionFileKey } from "../session-file-key.js";
import {
  haveSamePublishedEntries,
  type PromptReleasedSessionEntry,
} from "./attempt.session-lock.entries.js";
import {
  classifySessionFenceChange,
  readByteIdenticalSessionFenceSnapshot,
  readSessionFileFenceSnapshot,
  readSessionFileFingerprint,
  readSessionFileFingerprintSync,
  sameSessionFileFingerprint,
  type SessionFileFenceSnapshot,
  type SessionFileFingerprint,
  type TrustedSessionFileSnapshot,
} from "./attempt.session-lock.fence.js";

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

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

function resolveSessionFileFenceKey(sessionFile: string): string {
  return resolveEmbeddedSessionFileKey(sessionFile);
}

export function resetSessionFileFenceStateForTest(): void {
  ownedSessionFileWrites.clear();
  trustedSessionFileStates.clear();
  ownedSessionFileWriteGeneration = 0;
}

function resolveOwnedSessionFileWriteHistory(sessionFileKey: string): OwnedSessionFileWriteHistory {
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

function getOwnedSessionFileWriteHistory(
  sessionFileKey: string,
): OwnedSessionFileWriteHistory | undefined {
  return ownedSessionFileWrites.get(sessionFileKey);
}

function pruneOwnedSessionFileWriteHistory(
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

function recordOwnedSessionFileWrite(
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

function recordTrustedSessionFileState(
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

function trustSessionFileState(
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

function isTrustedSessionFileState(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): boolean {
  const trusted = trustedSessionFileStates.get(sessionFileKey);
  return trusted !== undefined && sameSessionFileFingerprint(trusted.fingerprint, fingerprint);
}

export type SessionFileWriteAppendValidator<T> = (result: T, appendedText: string) => boolean;

type PromptReleasedSessionMergeResult = {
  sessionFileSnapshot?: OwnedSessionTranscriptCacheSnapshot;
  publishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
  requiresReload?: true;
};

export class EmbeddedAttemptSessionFileFence {
  private fingerprint: SessionFileFingerprint | undefined;
  private snapshot: SessionFileFenceSnapshot | undefined;
  private generation = 0;
  private active = false;
  private takeoverDetected = false;
  private readonly sessionFileFenceKey: string;
  private readonly controllerFenceId: symbol;

  constructor(
    private readonly params: {
      sessionFile: string;
      mergePromptReleasedSessionEntries?: (
        entries: readonly PromptReleasedSessionEntry[],
      ) =>
        | Promise<PromptReleasedSessionMergeResult | void>
        | PromptReleasedSessionMergeResult
        | void;
      reloadPromptReleasedSessionFile?: () => Promise<void> | void;
    },
  ) {
    this.sessionFileFenceKey = resolveSessionFileFenceKey(params.sessionFile);
    this.controllerFenceId = Symbol(this.sessionFileFenceKey);
  }

  hasTakeover(): boolean {
    return this.takeoverDetected;
  }

  markTakeover(): void {
    this.takeoverDetected = true;
  }

  createTakeoverError(): EmbeddedAttemptSessionTakeoverError {
    return new EmbeddedAttemptSessionTakeoverError(this.params.sessionFile);
  }

  canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
    if (this.takeoverDetected) {
      return false;
    }
    const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
    return (
      (this.active && sameSessionFileFingerprint(this.fingerprint, fingerprint)) ||
      isTrustedSessionFileState(this.sessionFileFenceKey, fingerprint)
    );
  }

  publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
    if (this.takeoverDetected) {
      return false;
    }
    const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
    const current = readSessionFileFingerprintSync(this.params.sessionFile);
    if (!sameSessionFileFingerprint(fingerprint, current)) {
      return false;
    }
    const generation = recordOwnedSessionFileWrite(this.sessionFileFenceKey, current);
    if (this.active) {
      this.fingerprint = current;
      this.snapshot = { fingerprint: current };
      this.setGeneration(generation);
    }
    return true;
  }

  publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean {
    if (this.takeoverDetected) {
      return false;
    }
    const fingerprint: SessionFileFingerprint = { exists: true, ...snapshot };
    const current = readSessionFileFingerprintSync(this.params.sessionFile);
    if (!sameSessionFileFingerprint(fingerprint, current)) {
      return false;
    }
    this.setGeneration(recordTrustedSessionFileState(this.sessionFileFenceKey, current));
    if (this.active) {
      this.fingerprint = current;
      this.snapshot = { fingerprint: current };
    }
    return true;
  }

  async readTrustedCurrentSessionFileSnapshot(): Promise<TrustedSessionFileSnapshot | undefined> {
    const fingerprint = await readSessionFileFingerprint(this.params.sessionFile);
    return fingerprint.exists && isTrustedSessionFileState(this.sessionFileFenceKey, fingerprint)
      ? fingerprint
      : undefined;
  }

  refreshAfterOwnedSessionWrite(): void {
    if (this.takeoverDetected) {
      return;
    }
    const beforeWrite = this.fingerprint;
    const fingerprint = readSessionFileFingerprintSync(this.params.sessionFile);
    if (!this.active) {
      // User-message persistence occurs before the prompt fence activates.
      // The retained session lock owns that write, so publish its exact state
      // for the next attempt before release establishes the active fence.
      this.setGeneration(recordTrustedSessionFileState(this.sessionFileFenceKey, fingerprint));
      return;
    }
    if (
      !sameSessionFileFingerprint(beforeWrite, fingerprint) &&
      isTrustedSessionFileState(this.sessionFileFenceKey, beforeWrite ?? { exists: false })
    ) {
      this.setGeneration(recordOwnedSessionFileWrite(this.sessionFileFenceKey, fingerprint));
    }
    this.fingerprint = fingerprint;
    this.snapshot = { fingerprint };
  }

  private setGeneration(generation: number): void {
    this.generation = generation;
    if (!this.active) {
      return;
    }
    const history = resolveOwnedSessionFileWriteHistory(this.sessionFileFenceKey);
    history.activeFenceGenerations.set(this.controllerFenceId, generation);
    pruneOwnedSessionFileWriteHistory(this.sessionFileFenceKey, history);
  }

  private activate(generation: number): void {
    this.active = true;
    this.setGeneration(generation);
  }

  deactivate(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    const history = getOwnedSessionFileWriteHistory(this.sessionFileFenceKey);
    if (!history) {
      return;
    }
    history.activeFenceGenerations.delete(this.controllerFenceId);
    pruneOwnedSessionFileWriteHistory(this.sessionFileFenceKey, history);
  }

  private async mergePromptReleasedSessionChange(
    previous: SessionFileFenceSnapshot | undefined,
    current: SessionFileFingerprint,
    options?: {
      expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
    },
  ): Promise<
    | {
        snapshot: SessionFileFenceSnapshot;
        publishedEntries?: OwnedSessionTranscriptPublishedEntry[];
        postMergePublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[];
        requiresReload?: true;
      }
    | undefined
  > {
    if (!this.params.mergePromptReleasedSessionEntries) {
      return undefined;
    }
    const change = await classifySessionFenceChange({
      sessionFile: this.params.sessionFile,
      previous,
      current,
      expectedPublishedEntries: options?.expectedPublishedEntries,
    });
    if (!change) {
      return undefined;
    }
    if (
      options?.expectedPublishedEntries &&
      !haveSamePublishedEntries(change.publishedEntries, options.expectedPublishedEntries)
    ) {
      return undefined;
    }
    let mergeResult: PromptReleasedSessionMergeResult | void;
    try {
      mergeResult = await this.params.mergePromptReleasedSessionEntries(change.entries);
    } catch (error) {
      this.takeoverDetected = true;
      throw error;
    }
    const refreshedSnapshot = await readSessionFileFenceSnapshot(this.params.sessionFile);
    const expectedFingerprint = mergeResult?.sessionFileSnapshot
      ? { exists: true as const, ...mergeResult.sessionFileSnapshot }
      : current;
    if (!sameSessionFileFingerprint(expectedFingerprint, refreshedSnapshot.fingerprint)) {
      this.takeoverDetected = true;
      throw this.createTakeoverError();
    }
    return {
      snapshot: refreshedSnapshot,
      publishedEntries: mergeResult?.requiresReload
        ? undefined
        : mergeResult?.publishedEntries
          ? [...change.publishedEntries, ...mergeResult.publishedEntries]
          : change.publishedEntries,
      ...(mergeResult?.publishedEntries
        ? { postMergePublishedEntries: mergeResult.publishedEntries }
        : {}),
      ...(mergeResult?.requiresReload ? { requiresReload: true as const } : {}),
    };
  }

  private async reloadPromptReleasedSessionFile(
    expectedFingerprint: SessionFileFingerprint,
  ): Promise<SessionFileFenceSnapshot | undefined> {
    if (!this.params.reloadPromptReleasedSessionFile) {
      return undefined;
    }
    try {
      await this.params.reloadPromptReleasedSessionFile();
    } catch (error) {
      this.takeoverDetected = true;
      throw error;
    }
    const snapshot = await readSessionFileFenceSnapshot(this.params.sessionFile);
    if (!sameSessionFileFingerprint(expectedFingerprint, snapshot.fingerprint)) {
      this.takeoverDetected = true;
      throw this.createTakeoverError();
    }
    return snapshot;
  }

  async assert(): Promise<void> {
    if (!this.active) {
      return;
    }
    const current = await readSessionFileFingerprint(this.params.sessionFile);
    if (sameSessionFileFingerprint(this.fingerprint, current)) {
      return;
    }

    const ownedWriteHistory =
      getOwnedSessionFileWriteHistory(this.sessionFileFenceKey)?.writes ?? [];
    const ownedWrite = ownedWriteHistory.at(-1);
    if (
      ownedWrite &&
      ownedWrite.generation > this.generation &&
      sameSessionFileFingerprint(ownedWrite.fingerprint, current)
    ) {
      const unseenOwnedWrites = ownedWriteHistory.filter(
        (write) => write.generation > this.generation,
      );
      if (unseenOwnedWrites.some((write) => write.requiresReload)) {
        const reloadedSnapshot = await this.reloadPromptReleasedSessionFile(current);
        if (!reloadedSnapshot) {
          this.takeoverDetected = true;
          throw this.createTakeoverError();
        }
        this.fingerprint = reloadedSnapshot.fingerprint;
        this.snapshot = reloadedSnapshot;
        this.setGeneration(ownedWrite.generation);
        return;
      }
      const canValidateExactEntries = unseenOwnedWrites.every(
        (write) => write.publishedEntries !== undefined,
      );
      const expectedPublishedEntries = canValidateExactEntries
        ? unseenOwnedWrites.flatMap((write) => write.publishedEntries ?? [])
        : undefined;
      const mergedChange = await this.mergePromptReleasedSessionChange(
        this.snapshot,
        current,
        expectedPublishedEntries ? { expectedPublishedEntries } : undefined,
      );
      if (this.params.mergePromptReleasedSessionEntries && !mergedChange) {
        this.takeoverDetected = true;
        throw this.createTakeoverError();
      }
      const mergedFingerprint = mergedChange?.snapshot.fingerprint ?? current;
      const mergedGeneration =
        mergedChange && !sameSessionFileFingerprint(current, mergedFingerprint)
          ? recordOwnedSessionFileWrite(
              this.sessionFileFenceKey,
              mergedFingerprint,
              mergedChange.postMergePublishedEntries,
              mergedChange.requiresReload,
            )
          : ownedWrite.generation;
      this.fingerprint = mergedFingerprint;
      this.snapshot = mergedChange?.snapshot ?? { fingerprint: current };
      this.setGeneration(mergedGeneration);
      return;
    }

    const byteIdenticalSnapshot = await readByteIdenticalSessionFenceSnapshot({
      sessionFile: this.params.sessionFile,
      previous: this.snapshot,
      current,
    });
    if (byteIdenticalSnapshot) {
      this.snapshot = byteIdenticalSnapshot;
      this.fingerprint = byteIdenticalSnapshot.fingerprint;
      this.setGeneration(
        recordTrustedSessionFileState(this.sessionFileFenceKey, byteIdenticalSnapshot.fingerprint),
      );
      return;
    }

    const changeKind = await classifySessionFenceChange({
      sessionFile: this.params.sessionFile,
      previous: this.snapshot,
      current,
    });
    if (changeKind?.kind === "transcript-only" && !this.params.mergePromptReleasedSessionEntries) {
      this.snapshot = await readSessionFileFenceSnapshot(this.params.sessionFile);
      this.fingerprint = this.snapshot.fingerprint;
      this.setGeneration(
        trustSessionFileState(this.sessionFileFenceKey, current) ?? this.generation,
      );
      return;
    }
    if (changeKind && this.params.mergePromptReleasedSessionEntries) {
      const mergedChange = await this.mergePromptReleasedSessionChange(this.snapshot, current);
      if (!mergedChange) {
        this.takeoverDetected = true;
        throw this.createTakeoverError();
      }
      this.snapshot = mergedChange.snapshot;
      this.fingerprint = mergedChange.snapshot.fingerprint;
      this.setGeneration(
        recordOwnedSessionFileWrite(
          this.sessionFileFenceKey,
          mergedChange.snapshot.fingerprint,
          mergedChange.publishedEntries,
          mergedChange.requiresReload,
        ),
      );
      return;
    }

    this.takeoverDetected = true;
    throw this.createTakeoverError();
  }

  async refresh(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (this.takeoverDetected) {
      return;
    }
    const snapshot = await readSessionFileFenceSnapshot(this.params.sessionFile);
    if (!sameSessionFileFingerprint(beforeWrite, snapshot.fingerprint) && this.active) {
      this.fingerprint = snapshot.fingerprint;
      this.snapshot = snapshot;
    }
  }

  async captureOwnedWriteStart(): Promise<SessionFileFenceSnapshot> {
    const fingerprint = await readSessionFileFingerprint(this.params.sessionFile);
    if (this.snapshot && sameSessionFileFingerprint(this.snapshot.fingerprint, fingerprint)) {
      return this.snapshot;
    }
    return { fingerprint };
  }

  async publishOwnedWrite(
    beforeWrite: SessionFileFenceSnapshot,
    expectedPublishedEntries?: readonly OwnedSessionTranscriptPublishedEntry[],
  ): Promise<void> {
    if (this.takeoverDetected) {
      return;
    }
    const current = await readSessionFileFingerprint(this.params.sessionFile);
    if (sameSessionFileFingerprint(beforeWrite.fingerprint, current)) {
      return;
    }
    const beforeWriteIsTrusted =
      (this.active && sameSessionFileFingerprint(this.fingerprint, beforeWrite.fingerprint)) ||
      isTrustedSessionFileState(this.sessionFileFenceKey, beforeWrite.fingerprint);
    if (!beforeWriteIsTrusted) {
      return;
    }
    const mergedChange = await this.mergePromptReleasedSessionChange(
      beforeWrite,
      current,
      expectedPublishedEntries ? { expectedPublishedEntries } : undefined,
    );
    if (this.params.mergePromptReleasedSessionEntries && !mergedChange) {
      this.takeoverDetected = true;
      throw this.createTakeoverError();
    }
    const publishedEntries = mergedChange
      ? mergedChange.publishedEntries
      : expectedPublishedEntries;
    const publishedFingerprint = mergedChange?.snapshot.fingerprint ?? current;
    const generation = recordOwnedSessionFileWrite(
      this.sessionFileFenceKey,
      publishedFingerprint,
      publishedEntries,
      mergedChange?.requiresReload,
    );
    if (this.active) {
      this.fingerprint = publishedFingerprint;
      this.snapshot =
        mergedChange?.snapshot ?? (await readSessionFileFenceSnapshot(this.params.sessionFile));
      this.setGeneration(generation);
    }
  }

  // Synchronous append paths cannot await withSessionWriteLock. Only publish
  // their post-write fingerprint when the pre-write state was already trusted.
  publishOwnedWriteSync<T>(write: {
    beforeWrite: SessionFileFingerprint;
    result: T;
    beforeText?: string;
    validateAppend?: SessionFileWriteAppendValidator<T>;
  }): void {
    if (this.takeoverDetected) {
      return;
    }
    const fingerprint = readSessionFileFingerprintSync(this.params.sessionFile);
    const beforeWriteIsTrusted =
      (this.active && sameSessionFileFingerprint(this.fingerprint, write.beforeWrite)) ||
      isTrustedSessionFileState(this.sessionFileFenceKey, write.beforeWrite);
    if (sameSessionFileFingerprint(write.beforeWrite, fingerprint) || !beforeWriteIsTrusted) {
      return;
    }
    if (write.validateAppend) {
      const afterText = readFileSync(this.params.sessionFile, "utf8");
      if (
        write.beforeText === undefined ||
        !afterText.startsWith(write.beforeText) ||
        !write.validateAppend(write.result, afterText.slice(write.beforeText.length))
      ) {
        return;
      }
    }
    const generation = recordOwnedSessionFileWrite(this.sessionFileFenceKey, fingerprint);
    if (this.active) {
      this.fingerprint = fingerprint;
      this.snapshot = { fingerprint };
      this.setGeneration(generation);
    }
  }

  async activateForRelease(): Promise<void> {
    const fingerprint = await readSessionFileFingerprint(this.params.sessionFile);
    const ownedWrite = getOwnedSessionFileWriteHistory(this.sessionFileFenceKey)?.writes.at(-1);
    const trustedGeneration = trustSessionFileState(this.sessionFileFenceKey, fingerprint);
    this.fingerprint = fingerprint;
    this.snapshot = await readSessionFileFenceSnapshot(this.params.sessionFile);
    const releasedFenceGeneration =
      ownedWrite && sameSessionFileFingerprint(ownedWrite.fingerprint, fingerprint)
        ? ownedWrite.generation
        : (trustedGeneration ?? this.generation);
    this.activate(releasedFenceGeneration);
  }
}
