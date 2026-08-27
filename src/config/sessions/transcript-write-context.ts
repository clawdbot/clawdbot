// Transcript write contexts carry the admitted run fence and teardown tracking
// through nested session-manager callbacks.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { TranscriptAppendRefusal } from "./session-accessor.sqlite-contract.js";

type SessionTranscriptWriteTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
};

export type OwnedSessionTranscriptWriteContext = {
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteTarget;
  withTranscriptWrite: <T>(run: () => Promise<T> | T) => Promise<T>;
};

const ownedTranscriptWriteContext = new AsyncLocalStorage<OwnedSessionTranscriptWriteContext>();

// Compare concrete files when available; SQLite markers fall back to session
// identity because they are storage references rather than filesystem paths.
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
  sessionTarget?: SessionTranscriptWriteTarget;
}): boolean {
  const normalizeTarget = (target: SessionTranscriptWriteTarget | undefined) => {
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

/** Runs transcript writes with the admitted run's teardown and writer-fence context. */
export async function withOwnedSessionTranscriptWrites<T>(
  context: OwnedSessionTranscriptWriteContext,
  run: () => Promise<T>,
): Promise<T> {
  return await ownedTranscriptWriteContext.run(context, run);
}

/** Runs detached work without retaining an attempt-owned transcript context. */
export function runWithoutOwnedSessionTranscriptWrites<T>(run: () => T): T {
  return ownedTranscriptWriteContext.exit(run);
}

export function bindOwnedSessionTranscriptWrites<TArgs extends unknown[], TResult>(
  context: OwnedSessionTranscriptWriteContext,
  run: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args) => ownedTranscriptWriteContext.run(context, () => run(...args));
}

/** Returns the matching admitted-run fence for a durable write boundary. */
export function getOwnedSessionTranscriptWriterFence(
  params: {
    sessionFile?: string;
    sessionKey?: string;
    sessionTarget?: SessionTranscriptWriteTarget;
  } = {},
):
  | {
      expectedLifecycleRevision?: string;
      expectedWriterRunId: string;
    }
  | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || (Object.keys(params).length > 0 && !contextMatches({ context, ...params }))) {
    return undefined;
  }
  const target = context.sessionTarget;
  const expectedWriterRunId = target?.expectedWriterRunId?.trim();
  if (!expectedWriterRunId) {
    return undefined;
  }
  const expectedLifecycleRevision = target?.expectedLifecycleRevision;
  return {
    ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
    expectedWriterRunId,
  };
}

/** Applies the admitted-run fence inherited by a matching synchronous writer. */
export function withOwnedSessionTranscriptWriterFence<T extends SessionTranscriptWriteTarget>(
  scope: T,
): T {
  const fence = getOwnedSessionTranscriptWriterFence({
    sessionKey: scope.sessionKey,
    sessionTarget: scope,
  });
  return fence ? { ...scope, ...fence } : scope;
}

export class SessionTranscriptWriterClaimReboundError extends Error {
  constructor(cause?: TranscriptAppendRefusal) {
    super("session writer claim changed before transcript persistence", { cause });
    this.name = "SessionTranscriptWriterClaimReboundError";
  }
}

export async function runWithOwnedSessionTranscriptWrite<T>(
  params: {
    sessionFile?: string;
    sessionKey?: string;
    sessionTarget?: SessionTranscriptWriteTarget;
  },
  run: () => Promise<T> | T,
): Promise<T> {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context || !contextMatches({ context, ...params })) {
    return await run();
  }
  return await context.withTranscriptWrite(run);
}
