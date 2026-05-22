import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";

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

type SessionEventProcessor = {
  _processAgentEvent?: (event: unknown) => Promise<void>;
  _extensionRunner?: {
    hasHandlers?: (eventType: string) => boolean;
  };
  __openclawSessionEventWriteLockInstalled?: boolean;
};

type SessionEventQueueOwner = {
  _agentEventQueue?: PromiseLike<unknown>;
};

type SessionEventQueueBridge = SessionEventQueueOwner & {
  _handleAgentEvent?: AwaitableSessionEventHandler;
  _disconnectFromAgent?: () => void;
  _reconnectToAgent?: () => void;
};

type AwaitableSessionEventHandler = ((event: unknown, signal?: unknown) => unknown) & {
  __openclawSessionEventQueueAwaitInstalled?: boolean;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type SessionWithExternalHooks = SessionEventProcessor & {
  compact?: LockableFunction;
  agent?: {
    beforeToolCall?: LockableFunction;
    afterToolCall?: LockableFunction;
    onPayload?: LockableFunction;
    onResponse?: LockableFunction;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type LockableFunction = ((...args: unknown[]) => unknown) & {
  __openclawSessionWriteLockInstalled?: boolean;
};

function sessionHasExtensionHandlers(session: SessionEventProcessor, eventType: string): boolean {
  const extensionRunner = session["_extensionRunner"];
  const hasHandlers = extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(extensionRunner, eventType);
  } catch {
    return true;
  }
}

function eventMayReachTranscriptWriters(session: SessionEventProcessor, event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  if (type === "message_update" || type === "message_end" || type === "agent_end") {
    return true;
  }
  if (typeof type !== "string") {
    return false;
  }
  return sessionHasExtensionHandlers(session, type);
}

function installLockableFunction(params: {
  owner: Record<string, unknown>;
  key: string;
  shouldLock: () => boolean;
  waitBeforeLock?: () => Promise<void>;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const current = params.owner[params.key] as LockableFunction | undefined;
  if (typeof current !== "function" || current["__openclawSessionWriteLockInstalled"] === true) {
    return;
  }
  const wrapped: LockableFunction = async function lockedExternalHook(
    this: unknown,
    ...args: unknown[]
  ) {
    if (!params.shouldLock()) {
      return await current.apply(this, args);
    }
    await params.waitBeforeLock?.();
    return await params.withSessionWriteLock(async () => await current.apply(this, args));
  };
  wrapped["__openclawSessionWriteLockInstalled"] = true;
  params.owner[params.key] = wrapped;
}

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
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
  return path.resolve(sessionFile);
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
  return !!trusted && sameSessionFileFingerprint(trusted.fingerprint, fingerprint);
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

async function waitForSessionEventQueue(session: unknown): Promise<void> {
  const owner = session as SessionEventQueueOwner;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queue = owner?.["_agentEventQueue"];
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    await Promise.resolve(queue).catch(() => {});
    if (owner?.["_agentEventQueue"] === queue) {
      return;
    }
  }
  const queue = owner?.["_agentEventQueue"];
  if (queue && typeof queue.then === "function") {
    await Promise.resolve(queue).catch(() => {});
  }
}

function installAwaitableSessionEventQueue(session: unknown): void {
  const owner = session as SessionEventQueueBridge;
  const original = owner["_handleAgentEvent"];
  if (
    typeof original !== "function" ||
    original["__openclawSessionEventQueueAwaitInstalled"] === true
  ) {
    return;
  }

  const canReconnect =
    typeof owner["_disconnectFromAgent"] === "function" &&
    typeof owner["_reconnectToAgent"] === "function";
  if (canReconnect) {
    owner["_disconnectFromAgent"]?.();
  }

  const wrapped: AwaitableSessionEventHandler = function awaitableSessionEventQueue(
    ...args: [event: unknown, signal?: unknown]
  ) {
    const result = original(...args);
    const queue = owner["_agentEventQueue"];
    if (queue && typeof queue.then === "function") {
      return Promise.resolve(queue);
    }
    return result;
  };
  wrapped["__openclawSessionEventQueueAwaitInstalled"] = true;
  owner["_handleAgentEvent"] = wrapped;

  if (canReconnect) {
    owner["_reconnectToAgent"]?.();
  }
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export function installSessionEventWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  installAwaitableSessionEventQueue(params.session);
  const session = params.session as SessionEventProcessor;
  const original = session["_processAgentEvent"];
  if (
    typeof original !== "function" ||
    session["__openclawSessionEventWriteLockInstalled"] === true
  ) {
    return;
  }
  session["__openclawSessionEventWriteLockInstalled"] = true;
  session["_processAgentEvent"] = async function lockedProcessAgentEvent(
    this: unknown,
    event: unknown,
  ) {
    if (!eventMayReachTranscriptWriters(session, event)) {
      return await original.call(this, event);
    }
    return await params.withSessionWriteLock(async () => await original.call(this, event));
  };
}

export function installSessionExternalHookWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionWithExternalHooks;
  const agent = session.agent;
  if (agent) {
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "beforeToolCall",
      shouldLock: () => true,
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "afterToolCall",
      shouldLock: () => sessionHasExtensionHandlers(session, "tool_result"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onPayload",
      shouldLock: () => sessionHasExtensionHandlers(session, "before_provider_request"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onResponse",
      shouldLock: () => sessionHasExtensionHandlers(session, "after_provider_response"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
  }
  installLockableFunction({
    owner: session as Record<string, unknown>,
    key: "compact",
    shouldLock: () => true,
    waitBeforeLock: () => waitForSessionEventQueue(session),
    withSessionWriteLock: params.withSessionWriteLock,
  });
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  refreshAfterOwnedSessionWrite(): void;
  reacquireAfterPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(
    run: () => Promise<T> | T,
    options?: SessionWriteLockRunOptions,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
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
  const sessionFileFenceKey = resolveSessionFileFenceKey(params.lockOptions.sessionFile);

  async function acquireWriteLock(): Promise<{ lock: SessionLock; owned: boolean }> {
    if (heldLock) {
      return { lock: heldLock, owned: false };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockTimeoutError(err)) {
        takeoverDetected = true;
      }
      throw err;
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

  const noopLock: SessionLock = { release: async () => {} };

  return {
    async releaseForPrompt(): Promise<void> {
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
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
      await lock.release();
    },
    refreshAfterOwnedSessionWrite(): void {
      if (fenceActive && !takeoverDetected) {
        fenceFingerprint = readSessionFileFingerprintSync(params.lockOptions.sessionFile);
        fenceSnapshot = { fingerprint: fenceFingerprint };
      }
    },
    async reacquireAfterPrompt(): Promise<void> {
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
      const { lock, owned } = await acquireWriteLock();
      try {
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
        if (owned) {
          const activeLockState: ActiveWriteLockState = { active: true };
          try {
            return await activeWriteLock.run(activeLockState, runWithLock);
          } finally {
            activeLockState.active = false;
          }
        }
        return await runWithLock();
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
      try {
        heldLock ??= await acquireLock();
      } catch (err) {
        if (isSessionWriteLockTimeoutError(err)) {
          takeoverDetected = true;
          return noopLock;
        }
        throw err;
      }
      const cleanupLock = heldLock;
      heldLock = undefined;
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
      await params.reacquireAfterPrompt();
    }
  };
  wrappedStreamFn["__openclawSessionLockPromptReleaseInstalled"] = true;
  agent.streamFn = wrappedStreamFn;
}
