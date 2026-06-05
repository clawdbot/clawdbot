// Transcript write contexts let nested append paths reuse an already-owned session write lock.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock: <T>(
    run: () => Promise<T> | T,
    options?: { publishOwnedWrite?: boolean },
  ) => Promise<T>;
};

const ownedTranscriptWriteContext = new AsyncLocalStorage<OwnedSessionTranscriptWriteContext>();

// Compare resolved paths when available; fall back to session keys for lock reuse.
function normalizePathForCompare(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

function contextMatches(params: {
  context: OwnedSessionTranscriptWriteContext;
  sessionFile?: string;
  sessionKey?: string;
}): boolean {
  const contextSessionFile = normalizePathForCompare(params.context.sessionFile);
  const sessionFile = normalizePathForCompare(params.sessionFile);
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
  },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runWithOwnedSessionTranscriptWriteContext(params, run);
}

export async function runWithOwnedSessionTranscriptWritePublication<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  return await runWithOwnedSessionTranscriptWriteContext(params, run, {
    publishOwnedWrite: true,
  });
}

export function resolveOwnedSessionTranscriptWriteLockRunner(params: {
  sessionFile?: string;
  sessionKey?: string;
}): OwnedSessionTranscriptWriteContext["withSessionWriteLock"] | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    return undefined;
  }
  return context.withSessionWriteLock;
}

async function runWithOwnedSessionTranscriptWriteContext<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
  },
  run: () => Promise<T> | T,
  options?: { publishOwnedWrite?: boolean },
): Promise<T> {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    // No matching owner means the caller is responsible for acquiring its normal lock.
    return await run();
  }
  return await context.withSessionWriteLock(run, options);
}
