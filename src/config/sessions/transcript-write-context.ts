// Transcript write contexts let nested append paths reuse an already-owned session write lock.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { parseSqliteSessionFileMarker } from "./sqlite-marker.js";

type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  canAdvanceSessionEntryCache?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  publishSessionFileSnapshot?: (snapshot: OwnedSessionTranscriptCacheSnapshot) => boolean;
  withSessionWriteLock: <T>(
    run: () => Promise<T> | T,
    options?: OwnedSessionTranscriptWriteOptions<T>,
  ) => Promise<T>;
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
  if (!trimmed || parseSqliteSessionFileMarker(trimmed)) {
    return undefined;
  }
  return path.resolve(trimmed);
}

function contextMatches(params: {
  context: OwnedSessionTranscriptWriteContext;
  sessionFile?: string;
  sessionKey?: string;
}): boolean {
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

export function canAdvanceOwnedSessionEntryCache(params: {
  sessionFile?: string;
  sessionKey?: string;
  snapshot: OwnedSessionTranscriptCacheSnapshot;
}): boolean {
  const context = ownedTranscriptWriteContext.getStore();
  return Boolean(
    context &&
    contextMatches({ context, ...params }) &&
    context.publishSessionFileSnapshot &&
    context.canAdvanceSessionEntryCache?.(params.snapshot),
  );
}

export function publishOwnedSessionFileSnapshot(params: {
  sessionFile?: string;
  sessionKey?: string;
  snapshot: OwnedSessionTranscriptCacheSnapshot;
}): boolean | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params }) || !context.publishSessionFileSnapshot) {
    return undefined;
  }
  return context.publishSessionFileSnapshot(params.snapshot);
}

async function runWithOwnedSessionTranscriptWriteContext<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
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
