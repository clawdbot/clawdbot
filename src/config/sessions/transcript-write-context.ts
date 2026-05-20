import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
};

const ownedTranscriptWriteContext = new AsyncLocalStorage<OwnedSessionTranscriptWriteContext>();

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

export async function withOwnedSessionTranscriptWrites<T>(
  context: OwnedSessionTranscriptWriteContext,
  run: () => Promise<T>,
): Promise<T> {
  return await ownedTranscriptWriteContext.run(context, run);
}

export async function runWithOwnedSessionTranscriptWriteLock<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    return await run();
  }
  return await context.withSessionWriteLock(run);
}
