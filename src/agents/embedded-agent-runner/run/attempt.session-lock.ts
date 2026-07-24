/** Coordinates embedded-attempt lifecycle around SQLite-owned transcript writes. */
import type {
  OwnedSessionTranscriptCacheSnapshot,
  OwnedSessionTranscriptWriteOptions,
} from "../../../config/sessions/transcript-write-context.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";
import type {
  PromptReleasedSessionEntry,
  PromptReleasedSessionMergeResult,
} from "../../sessions/session-manager.js";

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;
type LockOptions = Parameters<AcquireSessionWriteLock>[0];
type SessionFileWriteAppendValidator<T> = (result: T) => boolean;

export type EmbeddedAttemptSessionFileOwner = {
  sessionFileKey: string;
  release(): void;
};

/** Session lanes and SQLite writer queues already serialize this identity. */
export async function acquireEmbeddedAttemptSessionFileOwner(params: {
  sessionFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<EmbeddedAttemptSessionFileOwner> {
  if (params.signal?.aborted) {
    throw params.signal.reason;
  }
  return { sessionFileKey: params.sessionFile, release() {} };
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionKey: string) {
    super(`session changed while the prompt was running: ${sessionKey}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export type EmbeddedAttemptSessionLockController = {
  canAdvanceSessionEntryCache(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishOwnedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  publishValidatedSessionFileSnapshot(snapshot: OwnedSessionTranscriptCacheSnapshot): boolean;
  readTrustedCurrentSessionFileSnapshot(): Promise<undefined>;
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
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
  dispose(): Promise<void>;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  initialAcquireSignal?: AbortSignal;
  lockOptions: LockOptions;
  mergePromptReleasedSessionEntries?: (
    entries: readonly PromptReleasedSessionEntry[],
  ) => Promise<PromptReleasedSessionMergeResult | void> | PromptReleasedSessionMergeResult | void;
  reloadPromptReleasedSessionFile?: () => Promise<void> | void;
}): Promise<EmbeddedAttemptSessionLockController> {
  void params.acquireSessionWriteLock;
  void params.lockOptions;
  if (params.initialAcquireSignal?.aborted) {
    throw params.initialAcquireSignal.reason;
  }
  const noOpLock = { release: async () => {} } as SessionLock;
  return {
    canAdvanceSessionEntryCache: () => false,
    publishOwnedSessionFileSnapshot: () => false,
    publishValidatedSessionFileSnapshot: () => false,
    readTrustedCurrentSessionFileSnapshot: async () => undefined,
    releaseForPrompt: async () => {},
    releaseHeldLockForAbort: async () => {},
    refreshAfterOwnedSessionWrite: () => {},
    withOwnedSessionFileWrite: (run) => run(),
    reacquireAfterPrompt: async () => {},
    waitForSessionEvents: async () => {},
    withSessionWriteLock: async (run) => await run(),
    acquireForCleanup: async () => noOpLock,
    hasSessionTakeover: () => false,
    dispose: async () => {},
  };
}

type PromptReleaseStreamFn = ((...args: unknown[]) => Promise<unknown>) & {
  openclawSessionLockPromptReleaseInstalled?: true;
};

type SessionWithAgentPrompt = {
  agent?: { streamFn?: PromptReleaseStreamFn };
};

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
  reacquireAfterPrompt: () => Promise<void>;
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock?: <T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ) => Promise<T>;
  canAdvanceSessionEntryCache?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  publishSessionFileSnapshot?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn.openclawSessionLockPromptReleaseInstalled === true) {
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
            canAdvanceSessionEntryCache: params.canAdvanceSessionEntryCache,
            publishSessionFileSnapshot: params.publishSessionFileSnapshot,
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
  wrappedStreamFn.openclawSessionLockPromptReleaseInstalled = true;
  agent.streamFn = wrappedStreamFn;
}
