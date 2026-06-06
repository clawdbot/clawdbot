/**
 * Coordinates embedded-attempt session ownership, takeover, and prompt locks.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { isSessionWriteLockAcquireError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import { resolveEmbeddedSessionFileKey } from "../session-file-key.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type ActiveWriteLockState = {
  active: boolean;
};

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionWriteLockRunOptions = {
  publishOwnedWrite?: boolean;
};

type SessionFileWriteAppendValidator<T> = (result: T, appendedText: string) => boolean;

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

const TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS = new Set(["delivery-mirror", "gateway-injected"]);
const MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES = 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES = 8 * 1024 * 1024;
const MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES =
  MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES + MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES;
const MAX_SAFE_FILE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

type SessionFileFenceSnapshot = {
  fingerprint: SessionFileFingerprint;
  text?: string;
};

function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameSessionFileIdentity(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  return Boolean(left?.exists && right.exists && left.dev === right.dev && left.ino === right.ino);
}

function splitSessionFileLines(text: string): string[] {
  return normalizeStringEntries(text.split(/\r?\n/));
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTranscriptOnlyOpenClawAssistantLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isJsonRecord(parsed)) {
      return false;
    }
    const message = parsed.message;
    if (!isJsonRecord(message)) {
      return false;
    }
    return (
      message.role === "assistant" &&
      message.provider === "openclaw" &&
      typeof message.model === "string" &&
      TRANSCRIPT_ONLY_OPENCLAW_ASSISTANT_MODELS.has(message.model)
    );
  } catch {
    return false;
  }
}

function normalizeTranscriptEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function omitRecordKeys(
  record: Record<string, unknown>,
  keys: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function lineMatchesLinearTranscriptMigration(params: {
  previousLine: string;
  currentLine: string;
  expectedParentId: string | null;
}): { ok: true; nextPreviousId?: string } | { ok: false } {
  let previousParsed: unknown;
  let currentParsed: unknown;
  try {
    previousParsed = JSON.parse(params.previousLine);
    currentParsed = JSON.parse(params.currentLine);
  } catch {
    return params.previousLine === params.currentLine ? { ok: true } : { ok: false };
  }
  if (!isJsonRecord(previousParsed)) {
    return params.previousLine === params.currentLine ? { ok: true } : { ok: false };
  }
  if (!isJsonRecord(currentParsed)) {
    return { ok: false };
  }
  if (previousParsed.type === "session") {
    return isDeepStrictEqual(
      omitRecordKeys(previousParsed, new Set(["version"])),
      omitRecordKeys(currentParsed, new Set(["version"])),
    )
      ? { ok: true }
      : { ok: false };
  }

  const previousId = normalizeTranscriptEntryId(previousParsed.id);
  const currentId = normalizeTranscriptEntryId(currentParsed.id);
  if (previousId ? currentId !== previousId : !currentId) {
    return { ok: false };
  }
  if (Object.hasOwn(previousParsed, "parentId")) {
    if (!isDeepStrictEqual(previousParsed.parentId, currentParsed.parentId)) {
      return { ok: false };
    }
  } else if (!isDeepStrictEqual(currentParsed.parentId, params.expectedParentId)) {
    return { ok: false };
  }

  return isDeepStrictEqual(
    omitRecordKeys(previousParsed, new Set(["id", "parentId"])),
    omitRecordKeys(currentParsed, new Set(["id", "parentId"])),
  )
    ? { ok: true, nextPreviousId: currentId }
    : { ok: false };
}

async function readAppendedSessionFileText(params: {
  sessionFile: string;
  previous: Extract<SessionFileFingerprint, { exists: true }>;
  current: Extract<SessionFileFingerprint, { exists: true }>;
}): Promise<string | undefined> {
  if (params.current.size <= params.previous.size || params.previous.size > MAX_SAFE_FILE_OFFSET) {
    return undefined;
  }
  const appendedBytes = params.current.size - params.previous.size;
  if (
    appendedBytes > BigInt(MAX_BENIGN_SESSION_FENCE_ADVANCE_BYTES) ||
    appendedBytes > MAX_SAFE_FILE_OFFSET
  ) {
    return undefined;
  }
  const length = Number(appendedBytes);
  const buffer = Buffer.alloc(length);
  const file = await fs.open(params.sessionFile, "r");
  try {
    const { bytesRead } = await file.read(buffer, 0, length, Number(params.previous.size));
    if (bytesRead !== length) {
      return undefined;
    }
  } finally {
    await file.close();
  }
  return buffer.toString("utf8");
}

async function readSessionFileFenceSnapshot(
  sessionFile: string,
): Promise<SessionFileFenceSnapshot> {
  const fingerprint = await readSessionFileFingerprint(sessionFile);
  if (
    !fingerprint.exists ||
    fingerprint.size > BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_BYTES) ||
    fingerprint.size > MAX_SAFE_FILE_OFFSET
  ) {
    return { fingerprint };
  }
  try {
    return {
      fingerprint,
      text: await fs.readFile(sessionFile, "utf8"),
    };
  } catch {
    return { fingerprint };
  }
}

async function sessionFenceAdvanceIsBenign(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
}): Promise<boolean> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current)
  ) {
    return false;
  }
  const text = await readAppendedSessionFileText({
    sessionFile: params.sessionFile,
    previous: params.previous.fingerprint,
    current: params.current,
  });
  if (!text?.endsWith("\n")) {
    return false;
  }
  const lines = normalizeStringEntries(text.split("\n"));
  return lines.length > 0 && lines.every(isTranscriptOnlyOpenClawAssistantLine);
}

async function sessionFenceRewriteIsBenign(params: {
  sessionFile: string;
  previous: SessionFileFenceSnapshot | undefined;
  current: SessionFileFingerprint;
}): Promise<boolean> {
  if (
    !params.previous?.fingerprint.exists ||
    !params.current.exists ||
    !params.previous.text ||
    !sameSessionFileIdentity(params.previous.fingerprint, params.current) ||
    params.current.size > BigInt(MAX_BENIGN_SESSION_FENCE_REWRITE_RESULT_BYTES) ||
    params.current.size > MAX_SAFE_FILE_OFFSET
  ) {
    return false;
  }
  let currentText: string;
  try {
    currentText = await fs.readFile(params.sessionFile, "utf8");
  } catch {
    return false;
  }
  if (!currentText.endsWith("\n")) {
    return false;
  }
  const previousLines = splitSessionFileLines(params.previous.text);
  const currentLines = splitSessionFileLines(currentText);
  if (currentLines.length <= previousLines.length) {
    return false;
  }
  let expectedParentId: string | null = null;
  for (let index = 0; index < previousLines.length; index += 1) {
    const lineMatch = lineMatchesLinearTranscriptMigration({
      previousLine: previousLines[index] ?? "",
      currentLine: currentLines[index] ?? "",
      expectedParentId,
    });
    if (!lineMatch.ok) {
      return false;
    }
    expectedParentId = lineMatch.nextPreviousId ?? expectedParentId;
  }
  const appendedLines = currentLines.slice(previousLines.length);
  return appendedLines.every(isTranscriptOnlyOpenClawAssistantLine);
}

type OwnedSessionFileWrite = {
  generation: number;
  fingerprint: SessionFileFingerprint;
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
const ownedSessionFileWrites = new Map<string, OwnedSessionFileWrite>();
const trustedSessionFileStates = new Map<string, TrustedSessionFileState>();
let ownedSessionFileWriteGeneration = 0;

function resolveSessionFileFenceKey(sessionFile: string): string {
  return resolveEmbeddedSessionFileKey(sessionFile);
}

type SessionFileOwnerWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
};

type SessionFileOwnerEntry = {
  ownerId: symbol;
  waiters: Set<SessionFileOwnerWaiter>;
};

type SessionFileOwnerState = {
  owners: Map<string, SessionFileOwnerEntry>;
};

const EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY = Symbol.for(
  "openclaw.embeddedAttemptSessionFileOwnerState",
);

const sessionFileOwnerState = resolveGlobalSingleton(
  EMBEDDED_ATTEMPT_SESSION_FILE_OWNER_STATE_KEY,
  (): SessionFileOwnerState => ({
    owners: new Map<string, SessionFileOwnerEntry>(),
  }),
);

export type EmbeddedAttemptSessionFileOwner = {
  sessionFileKey: string;
  release(): void;
};

export class EmbeddedAttemptSessionFileOwnerTimeoutError extends Error {
  constructor(sessionFile: string, timeoutMs: number) {
    super(`timed out waiting for embedded session file owner after ${timeoutMs}ms: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionFileOwnerTimeoutError";
  }
}

function abortReason(signal: AbortSignal): unknown {
  return "reason" in signal ? (signal as { reason?: unknown }).reason : undefined;
}

function abortOwnerWaitReason(signal: AbortSignal): unknown {
  return abortReason(signal) ?? new Error("operation aborted", { cause: signal });
}

function waitForSessionFileOwnerRelease(params: {
  sessionFile: string;
  entry: SessionFileOwnerEntry;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) {
    return Promise.reject(
      toLintErrorObject(abortOwnerWaitReason(params.signal), "Non-Error rejection"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: SessionFileOwnerWaiter = {
      resolve,
      reject,
      signal: params.signal,
    };
    const cleanup = () => {
      params.entry.waiters.delete(waiter);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      if (waiter.signal && waiter.abortListener) {
        waiter.signal.removeEventListener("abort", waiter.abortListener);
      }
    };
    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error) => {
      cleanup();
      reject(toLintErrorObject(error, "Non-Error rejection"));
    };
    if (params.timeoutMs !== undefined && Number.isFinite(params.timeoutMs)) {
      waiter.timer = setTimeout(
        () => {
          waiter.reject(
            new EmbeddedAttemptSessionFileOwnerTimeoutError(
              params.sessionFile,
              params.timeoutMs ?? 0,
            ),
          );
        },
        Math.max(1, Math.floor(params.timeoutMs)),
      );
      waiter.timer.unref?.();
    }
    if (params.signal) {
      waiter.abortListener = () => {
        waiter.reject(abortOwnerWaitReason(params.signal!));
      };
      params.signal.addEventListener("abort", waiter.abortListener, { once: true });
    }
    params.entry.waiters.add(waiter);
  });
}

export async function acquireEmbeddedAttemptSessionFileOwner(params: {
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddedAttemptSessionFileOwner> {
  const sessionFileKey = resolveEmbeddedSessionFileKey(params.sessionFile);
  const ownerId = Symbol(sessionFileKey);
  while (true) {
    if (params.signal?.aborted) {
      throw abortOwnerWaitReason(params.signal);
    }
    const entry = sessionFileOwnerState.owners.get(sessionFileKey);
    if (!entry) {
      sessionFileOwnerState.owners.set(sessionFileKey, {
        ownerId,
        waiters: new Set(),
      });
      return {
        sessionFileKey,
        release() {
          const current = sessionFileOwnerState.owners.get(sessionFileKey);
          if (!current || current.ownerId !== ownerId) {
            return;
          }
          sessionFileOwnerState.owners.delete(sessionFileKey);
          for (const waiter of current.waiters) {
            waiter.resolve();
          }
        },
      };
    }
    await waitForSessionFileOwnerRelease({
      sessionFile: params.sessionFile,
      entry,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
  }
}

export function resetEmbeddedAttemptSessionFileOwnersForTest(): void {
  for (const entry of sessionFileOwnerState.owners.values()) {
    for (const waiter of entry.waiters) {
      waiter.reject(
        new Error("embedded attempt session file owners reset", {
          cause: "resetEmbeddedAttemptSessionFileOwnersForTest",
        }),
      );
    }
  }
  sessionFileOwnerState.owners.clear();
}

function recordOwnedSessionFileWrite(
  sessionFileKey: string,
  fingerprint: SessionFileFingerprint,
): number {
  ownedSessionFileWriteGeneration += 1;
  const state = {
    generation: ownedSessionFileWriteGeneration,
    fingerprint,
  };
  ownedSessionFileWrites.set(sessionFileKey, state);
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

async function readSessionFileFingerprint(sessionFile: string): Promise<SessionFileFingerprint> {
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

function readSessionFileFingerprintSync(sessionFile: string): SessionFileFingerprint {
  try {
    const stat = statSync(sessionFile, { bigint: true });
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function waitForSessionEventQueue(_session: unknown): Promise<void> {}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  releaseHeldLockForAbort(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  withOwnedSessionFileWrite<T>(
    run: () => T,
    validateAppend?: SessionFileWriteAppendValidator<T>,
  ): T;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  lockOptions: LockOptions;
}): Promise<EmbeddedAttemptSessionLockController> {
  const acquireLock = async (): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
    });

  let heldLock: SessionLock | undefined = await acquireLock();
  const activeWriteLock = new AsyncLocalStorage<ActiveWriteLockState>();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceSnapshot: SessionFileFenceSnapshot | undefined;
  let fenceGeneration = 0;
  let fenceActive = false;
  let takeoverDetected = false;
  let retainedLockUseCount = 0;
  const retainedLockIdleWaiters = new Set<() => void>();
  let heldLockDraining = false;
  let heldLockDrainOwner: symbol | undefined;
  const heldLockDrainWaiters = new Set<() => void>();
  const sessionFileFenceKey = resolveSessionFileFenceKey(params.lockOptions.sessionFile);

  function beginRetainedLockUse(): () => void {
    retainedLockUseCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      retainedLockUseCount -= 1;
      if (retainedLockUseCount === 0 && retainedLockIdleWaiters.size > 0) {
        const waiters = Array.from(retainedLockIdleWaiters);
        retainedLockIdleWaiters.clear();
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  async function waitForRetainedLockIdle(): Promise<boolean> {
    if (retainedLockUseCount === 0) {
      return true;
    }
    if (activeWriteLock.getStore()?.active === true) {
      return false;
    }
    await new Promise<void>((resolve) => {
      retainedLockIdleWaiters.add(resolve);
    });
    return true;
  }

  async function acquireWriteLock(): Promise<{
    lock: SessionLock;
    owned: boolean;
    releaseRetainedUse?: () => void;
  }> {
    await waitForHeldLockDrain();
    if (heldLock) {
      return { lock: heldLock, owned: false, releaseRetainedUse: beginRetainedLockUse() };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        takeoverDetected = true;
      }
      throw err;
    }
  }

  async function waitForHeldLockDrain(): Promise<void> {
    for (;;) {
      if (!heldLockDraining) {
        return;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  async function beginHeldLockDrain(): Promise<symbol> {
    for (;;) {
      if (!heldLockDraining) {
        const owner = Symbol("held-lock-drain");
        heldLockDraining = true;
        heldLockDrainOwner = owner;
        return owner;
      }
      await new Promise<void>((resolve) => {
        heldLockDrainWaiters.add(resolve);
      });
    }
  }

  function finishHeldLockDrain(owner: symbol): void {
    if (!heldLockDraining || heldLockDrainOwner !== owner) {
      return;
    }
    heldLockDraining = false;
    heldLockDrainOwner = undefined;
    if (heldLockDrainWaiters.size === 0) {
      return;
    }
    const waiters = Array.from(heldLockDrainWaiters);
    heldLockDrainWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  async function assertSessionFileFence(): Promise<void> {
    if (!fenceActive) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(fenceFingerprint, current)) {
      return;
    }

    const ownedWrite = ownedSessionFileWrites.get(sessionFileFenceKey);
    if (
      ownedWrite &&
      ownedWrite.generation > fenceGeneration &&
      sameSessionFileFingerprint(ownedWrite.fingerprint, current)
    ) {
      fenceFingerprint = current;
      fenceSnapshot = { fingerprint: current };
      fenceGeneration = ownedWrite.generation;
      return;
    }

    if (
      (await sessionFenceAdvanceIsBenign({
        sessionFile: params.lockOptions.sessionFile,
        previous: fenceSnapshot,
        current,
      })) ||
      (await sessionFenceRewriteIsBenign({
        sessionFile: params.lockOptions.sessionFile,
        previous: fenceSnapshot,
        current,
      }))
    ) {
      fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
      fenceFingerprint = fenceSnapshot.fingerprint;
      fenceGeneration = trustSessionFileState(sessionFileFenceKey, current) ?? fenceGeneration;
      return;
    }

    takeoverDetected = true;
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function publishOwnedSessionFileWriteIfChanged(
    beforeWrite: SessionFileFingerprint,
  ): Promise<{
    fingerprint: SessionFileFingerprint;
    generation: number;
  } | null> {
    const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(beforeWrite, fingerprint)) {
      return null;
    }
    if (!isTrustedSessionFileState(sessionFileFenceKey, beforeWrite)) {
      return null;
    }
    const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint);
    return { fingerprint, generation };
  }

  async function refreshSessionFileFence(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const snapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
    if (!sameSessionFileFingerprint(beforeWrite, snapshot.fingerprint) && fenceActive) {
      fenceFingerprint = snapshot.fingerprint;
      fenceSnapshot = snapshot;
    }
  }

  async function publishOwnedSessionFileFence(beforeWrite: SessionFileFingerprint): Promise<void> {
    if (takeoverDetected) {
      return;
    }
    const ownedWrite = await publishOwnedSessionFileWriteIfChanged(beforeWrite);
    if (ownedWrite && fenceActive) {
      fenceFingerprint = ownedWrite.fingerprint;
      fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
      fenceGeneration = ownedWrite.generation;
    }
  }

  // Synchronous append paths cannot await withSessionWriteLock. Only publish
  // their post-write fingerprint when the pre-write state was already trusted.
  function publishOwnedSessionFileFenceSync<T>(write: {
    beforeWrite: SessionFileFingerprint;
    result: T;
    beforeText?: string;
    validateAppend?: SessionFileWriteAppendValidator<T>;
  }): void {
    if (takeoverDetected) {
      return;
    }
    const fingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
    const beforeWriteIsTrusted =
      (fenceActive && sameSessionFileFingerprint(fenceFingerprint, write.beforeWrite)) ||
      isTrustedSessionFileState(sessionFileFenceKey, write.beforeWrite);
    if (sameSessionFileFingerprint(write.beforeWrite, fingerprint) || !beforeWriteIsTrusted) {
      return;
    }
    if (write.validateAppend) {
      const afterText = readFileSync(params.lockOptions.sessionFile, "utf8");
      if (
        write.beforeText === undefined ||
        !afterText.startsWith(write.beforeText) ||
        !write.validateAppend(write.result, afterText.slice(write.beforeText.length))
      ) {
        return;
      }
    }
    const generation = recordOwnedSessionFileWrite(sessionFileFenceKey, fingerprint);
    if (fenceActive) {
      fenceFingerprint = fingerprint;
      fenceSnapshot = { fingerprint };
      fenceGeneration = generation;
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  async function releaseHeldLockWithFence(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      // Clearing `heldLock` transfers release ownership to this block. Fence reads can
      // throw after that transfer; release the underlying file lock anyway so later
      // turns do not wait for the maxHoldMs watchdog.
      try {
        const fingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
        const ownedWrite = ownedSessionFileWrites.get(sessionFileFenceKey);
        const trustedGeneration = trustSessionFileState(sessionFileFenceKey, fingerprint);
        fenceFingerprint = fingerprint;
        fenceSnapshot = await readSessionFileFenceSnapshot(params.lockOptions.sessionFile);
        fenceGeneration =
          ownedWrite && sameSessionFileFingerprint(ownedWrite.fingerprint, fingerprint)
            ? ownedWrite.generation
            : (trustedGeneration ?? fenceGeneration);
        fenceActive = true;
      } finally {
        await lock.release();
      }
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function takeHeldLockAfterRetainedIdle(): Promise<SessionLock | undefined> {
    if (!heldLock) {
      return undefined;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        return undefined;
      }
      if (!heldLock) {
        return undefined;
      }
      const lock = heldLock;
      heldLock = undefined;
      return lock;
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function disposeHeldLockAfterRetainedIdle(): Promise<void> {
    if (!heldLock) {
      await waitForHeldLockDrain();
      return;
    }
    const drainOwner = await beginHeldLockDrain();
    try {
      if (!(await waitForRetainedLockIdle())) {
        return;
      }
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      await lock.release();
    } finally {
      finishHeldLockDrain(drainOwner);
    }
  }

  async function acquireCleanupLock(): Promise<SessionLock | undefined> {
    const retainedLock = await takeHeldLockAfterRetainedIdle();
    if (retainedLock) {
      return retainedLock;
    }
    await waitForHeldLockDrain();
    try {
      return await acquireLock();
    } catch (err) {
      if (isSessionWriteLockAcquireError(err)) {
        takeoverDetected = true;
        return undefined;
      }
      throw err;
    }
  }

  async function runWithRetainedLock<T>(
    run: () => Promise<T>,
    releaseRetainedUse: () => void,
  ): Promise<T> {
    try {
      const activeLockState: ActiveWriteLockState = { active: true };
      try {
        return await activeWriteLock.run(activeLockState, run);
      } finally {
        activeLockState.active = false;
      }
    } finally {
      releaseRetainedUse();
    }
  }

  return {
    async releaseForPrompt(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    async releaseHeldLockForAbort(): Promise<void> {
      await releaseHeldLockWithFence();
    },
    refreshAfterOwnedSessionWrite(): void {
      if (fenceActive && !takeoverDetected) {
        fenceFingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
        fenceSnapshot = { fingerprint: fenceFingerprint };
      }
    },
    withOwnedSessionFileWrite<T>(
      run: () => T,
      validateAppend?: SessionFileWriteAppendValidator<T>,
    ): T {
      const beforeWrite = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
      const beforeText = validateAppend
        ? readFileSync(params.lockOptions.sessionFile, "utf8")
        : undefined;
      const result = run();
      publishOwnedSessionFileFenceSync({
        beforeWrite,
        result,
        ...(beforeText !== undefined ? { beforeText } : {}),
        ...(validateAppend ? { validateAppend } : {}),
      });
      return result;
    },
    async reacquireAfterPrompt(): Promise<void> {
      await waitForHeldLockDrain();
      if (takeoverDetected || heldLock) {
        return;
      }
      const lock = await acquireLock();
      try {
        heldLock = lock;
        await assertSessionFileFence();
      } catch (err) {
        heldLock = undefined;
        await lock.release();
        throw err;
      }
    },
    waitForSessionEvents: waitForSessionEventQueue,
    async withSessionWriteLock<T>(
      run: () => Promise<T> | T,
      options?: SessionWriteLockRunOptions,
    ): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()?.active === true) {
        if (options?.publishOwnedWrite !== true) {
          return await run();
        }
        const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
        try {
          return await run();
        } finally {
          await publishOwnedSessionFileFence(beforeWrite);
        }
      }
      const { lock, owned, releaseRetainedUse } = await acquireWriteLock();
      try {
        const runLockedOperation = async () => {
          await assertSessionFileFence();
          const beforeWrite = await readSessionFileFingerprint(params.lockOptions.sessionFile);
          const runWithLock = async () => {
            try {
              return await run();
            } finally {
              if (options?.publishOwnedWrite === true) {
                await publishOwnedSessionFileFence(beforeWrite);
              } else {
                await refreshSessionFileFence(beforeWrite);
              }
            }
          };
          return await runWithLock();
        };
        if (owned) {
          const activeLockState: ActiveWriteLockState = { active: true };
          try {
            return await activeWriteLock.run(activeLockState, runLockedOperation);
          } finally {
            activeLockState.active = false;
          }
        }
        return await runWithRetainedLock(runLockedOperation, releaseRetainedUse ?? (() => {}));
      } finally {
        if (owned) {
          await lock.release();
        }
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      if (takeoverDetected) {
        return noopLock;
      }
      const cleanupLock = await acquireCleanupLock();
      if (!cleanupLock) {
        return noopLock;
      }
      try {
        await assertSessionFileFence();
      } catch (err) {
        await cleanupLock.release();
        if (err instanceof EmbeddedAttemptSessionTakeoverError) {
          return noopLock;
        }
        throw err;
      }
      return cleanupLock;
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
    async dispose(): Promise<void> {
      await disposeHeldLockAfterRetainedIdle();
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock?: <T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ) => Promise<T>;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn["__openclawSessionLockPromptReleaseInstalled"] === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    try {
      if (params.sessionFile && params.withSessionWriteLock) {
        return await withOwnedSessionTranscriptWrites(
          {
            sessionFile: params.sessionFile,
            sessionKey: params.sessionKey,
            withSessionWriteLock: params.withSessionWriteLock,
          },
          async () => await originalStreamFn(...args),
        );
      }
      return await originalStreamFn(...args);
    } finally {
      await params.waitForSessionEvents(params.session);
      await params.reacquireAfterPrompt();
    }
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
