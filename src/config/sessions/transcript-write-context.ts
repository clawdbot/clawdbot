// Transcript write contexts let nested append paths reuse an already-owned session write lock.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteLockTarget;
  canAdvanceSessionEntryCache?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  publishSessionFileSnapshot?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  withSessionWriteLock: <T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ) => Promise<T>;
};

export type SessionTranscriptWriteLockTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
};

export type OwnedSessionTranscriptWriteOptions<T> = {
  publishOwnedWrite?: boolean;
  resolvePublishedEntries?: (result: T) => readonly OwnedSessionTranscriptPublishedEntry[];
  resolvePublishedEntriesAfterFailure?: () => readonly OwnedSessionTranscriptPublishedEntry[];
};

export type OwnedSessionTranscriptPublishedEntry =
  | { kind: "id"; id: string }
  | { kind: "header"; serialized: string }
  | { kind: "serialized"; serialized: string };

export type OwnedSessionTranscriptCacheSnapshot = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

const ownedTranscriptWriteContext = new AsyncLocalStorage<OwnedSessionTranscriptWriteContext>();

// Compare concrete files when available; SQLite markers fall back to session
// identity because they are storage references rather than lockable paths.
function normalizeConcretePathForCompare(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || !trimmed.endsWith(".jsonl")) {
    return undefined;
  }
  return path.resolve(trimmed);
}

function contextMatches(params: {
  context: OwnedSessionTranscriptWriteContext;
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteLockTarget;
}): boolean {
  const normalizeTarget = (target: SessionTranscriptWriteLockTarget | undefined) => {
    const agentId = target?.agentId?.trim();
    const sessionId = target?.sessionId?.trim();
    const sessionKey = target?.sessionKey?.trim();
    const storePath = target?.storePath?.trim();
    return sessionKey && storePath
      ? { agentId, sessionId, sessionKey, storePath: path.resolve(storePath) }
      : undefined;
  };
  const contextTarget = normalizeTarget(params.context.sessionTarget);
  const requestedTarget = normalizeTarget(params.sessionTarget);
  if (params.context.sessionTarget || params.sessionTarget) {
    return Boolean(
      contextTarget &&
      requestedTarget &&
      contextTarget.sessionKey === requestedTarget.sessionKey &&
      contextTarget.storePath === requestedTarget.storePath &&
      (!contextTarget.agentId ||
        !requestedTarget.agentId ||
        contextTarget.agentId === requestedTarget.agentId) &&
      (!contextTarget.sessionId ||
        !requestedTarget.sessionId ||
        contextTarget.sessionId === requestedTarget.sessionId),
    );
  }
  const contextSessionFile = normalizeConcretePathForCompare(params.context.sessionFile);
  const sessionFile = normalizeConcretePathForCompare(params.sessionFile);
  if (contextSessionFile && sessionFile) {
    return contextSessionFile === sessionFile;
  }

  const contextSessionKey = params.context.sessionKey?.trim();
  const sessionKey = params.sessionKey?.trim();
  return Boolean(contextSessionKey && sessionKey && contextSessionKey === sessionKey);
}

/** Runs transcript writes with an owned write-lock context. */
export async function withOwnedSessionTranscriptWrites<T>(
  context: OwnedSessionTranscriptWriteContext,
  run: () => Promise<T>,
): Promise<T> {
  return await ownedTranscriptWriteContext.run(context, run);
}

/** Runs detached work without retaining an attempt-owned transcript lock. */
export function runWithoutOwnedSessionTranscriptWrites<T>(run: () => T): T {
  return ownedTranscriptWriteContext.exit(run);
}

export function bindOwnedSessionTranscriptWrites<TArgs extends unknown[], TResult>(
  context: OwnedSessionTranscriptWriteContext,
  run: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  // Bind callbacks that will run later but must still see the parent write-lock context.
  return (...args) => ownedTranscriptWriteContext.run(context, () => run(...args));
}

export async function runWithOwnedSessionTranscriptWriteLock<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
    sessionTarget?: SessionTranscriptWriteLockTarget;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runWithOwnedSessionTranscriptWriteContext(params, run);
}

export async function acquireOwnedSessionTranscriptWriteLock(params: {
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteLockTarget;
}): Promise<{ release: () => Promise<void> } | undefined> {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    return undefined;
  }

  // Keep the owner callback pending until release so release-shaped callers
  // cannot outlive the logical writer lock or leak a tracked nested operation.
  let markAcquired!: () => void;
  let rejectAcquire!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    rejectAcquire = reject;
  });
  let releaseOperation!: () => void;
  const releaseRequested = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const operation = context.withSessionWriteLock(async () => {
    markAcquired();
    await releaseRequested;
  });
  void operation.catch(rejectAcquire);
  await acquired;

  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      releaseOperation();
      await operation;
    },
  };
}

async function runWithOwnedSessionTranscriptWriteContext<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
    sessionTarget?: SessionTranscriptWriteLockTarget;
  },
  run: () => Promise<T> | T,
  options?: OwnedSessionTranscriptWriteOptions<T>,
): Promise<T> {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    // No matching owner means the caller is responsible for acquiring its normal lock.
    return await run();
  }
  return await context.withSessionWriteLock(run, options);
}
