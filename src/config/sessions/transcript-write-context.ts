// Transcript write contexts carry the admitted run fence and teardown tracking
// through nested session-manager callbacks.
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { TranscriptAppendRefusal } from "./session-accessor.sqlite-contract.js";

export type SessionTranscriptWriterFence = Readonly<{
  expectedLifecycleRevision: string | undefined;
  expectedWriterRunId: string;
}>;

/** A first-insert lease, bound to the original admission rather than its run id. */
export type InitialSessionTranscriptWriter = Readonly<{
  writerRunId: string;
  committedFence: SessionTranscriptWriterFence | undefined;
  assertActive: () => void;
  recordCommitted: (fence: SessionTranscriptWriterFence) => void;
}>;

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
  initialWriter?: InitialSessionTranscriptWriter;
  /** Revalidate the captured owner, including an absent writer, inside each commit. */
  assertCommitAllowed?: () => void;
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

/**
 * Ownership test for a writer fence, which is the one gate a caller can reach holding
 * nothing but a session key. A delivery mirror knows the session it writes into but not
 * that session's store path, so it cannot form a target; `contextMatches` would refuse
 * it for not being target-shaped and leave it unable to tell "the running session" from
 * "some other session". Compare keys in that case, and defer to the target comparison
 * whenever the caller can express one.
 */
function ownsRequestedSession(params: {
  context: OwnedSessionTranscriptWriteContext;
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteTarget;
}): boolean {
  if (params.sessionTarget || params.sessionFile) {
    return contextMatches(params);
  }
  const contextSessionKey = (
    params.context.sessionTarget?.sessionKey ?? params.context.sessionKey
  )?.trim();
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

/**
 * Returns the matching admitted-run fence for a durable write boundary.
 *
 * Every write boundary must name the session it writes into, or it inherits a claim
 * about whichever session happens to be running. Omitting the scope asks for the
 * ambient claim itself and is only for diagnostics that observe the running writer.
 */
export function getOwnedSessionTranscriptWriterFence(
  params: {
    sessionFile?: string;
    sessionKey?: string;
    sessionTarget?: SessionTranscriptWriteTarget;
  } = {},
): SessionTranscriptWriterFence | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (
    !context ||
    (Object.keys(params).length > 0 && !ownsRequestedSession({ context, ...params }))
  ) {
    return undefined;
  }
  const initial = context.initialWriter;
  if (initial) {
    return (
      initial.committedFence ?? {
        expectedLifecycleRevision: undefined,
        expectedWriterRunId: initial.writerRunId,
      }
    );
  }
  const target = context.sessionTarget;
  const expectedWriterRunId = target?.expectedWriterRunId?.trim();
  return expectedWriterRunId
    ? { expectedLifecycleRevision: target?.expectedLifecycleRevision, expectedWriterRunId }
    : undefined;
}

/** Inherit only the exact host-minted first-insert owner across attempt preparation. */
export function getOwnedSessionTranscriptInitialWriter(params: {
  sessionFile?: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptWriteTarget;
}): InitialSessionTranscriptWriter | undefined {
  const context = ownedTranscriptWriteContext.getStore();
  if (!context?.initialWriter) {
    return undefined;
  }
  if (
    !contextMatches({ context, ...params }) ||
    context.sessionTarget?.sessionId !== params.sessionTarget?.sessionId ||
    context.sessionTarget?.agentId !== params.sessionTarget?.agentId
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  return context.initialWriter;
}

function assertTranscriptWriteContext(
  context: OwnedSessionTranscriptWriteContext | undefined,
  scope: SessionTranscriptWriteTarget,
): void {
  if (!context?.assertCommitAllowed && !context?.initialWriter) {
    return;
  }
  if (
    !contextMatches({ context, sessionTarget: scope }) ||
    context.sessionTarget?.sessionId !== scope.sessionId ||
    context.sessionTarget?.agentId !== scope.agentId
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  context.assertCommitAllowed?.();
  context.initialWriter?.assertActive();
}

/** A guarded context cannot silently become an unfenced write to another target. */
export function assertOwnedTranscriptWriteCommit(scope: SessionTranscriptWriteTarget): void {
  assertTranscriptWriteContext(ownedTranscriptWriteContext.getStore(), scope);
}

/** Retained post-commit work must revalidate its original owner, not its invocation context. */
export function captureOwnedTranscriptWriteAssertion(
  scope: SessionTranscriptWriteTarget,
): () => void {
  const context = ownedTranscriptWriteContext.getStore();
  const target = { ...scope };
  return () => assertTranscriptWriteContext(context, target);
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
