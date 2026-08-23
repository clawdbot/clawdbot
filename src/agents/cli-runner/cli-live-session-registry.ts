import { sha256Hex } from "../../infra/crypto-digest.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type {
  CliBackendLiveSessionCloseReason,
  CliBackendLiveSessionHandle,
} from "../../plugins/cli-backend.types.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

const MAX_LIVE_SESSIONS = 16;

type CliLiveSessionOwner = {
  backendId: string;
  agentAccountId?: string;
  agentId?: string;
  authProfileId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type CliLiveSessionCreate = {
  generation: string;
  closeReason?: CliBackendLiveSessionCloseReason;
};

const liveSessions = new Map<string, CliBackendLiveSessionHandle>();
const liveSessionCreates = new Map<string, CliLiveSessionCreate>();
const liveSessionTurns = new KeyedAsyncQueue();
const liveSessionCleanup = new WeakMap<CliBackendLiveSessionHandle, () => Promise<void>>();
const liveSessionCleanupPromises = new WeakMap<CliBackendLiveSessionHandle, Promise<void>>();
const liveSessionApprovalGrants = new WeakMap<CliBackendLiveSessionHandle, Set<string>>();

function buildCliLiveRegistryKey(owner: CliLiveSessionOwner): string {
  return `${owner.backendId}:${buildCliLiveOwnerKey(owner)}`;
}

/** Hashes the account/agent/auth/session tuple shared by queue and registry ownership. */
export function buildCliLiveOwnerKey(input: Omit<CliLiveSessionOwner, "backendId">): string {
  return sha256Hex(
    JSON.stringify({
      agentAccountId: input.agentAccountId,
      agentId: input.agentId,
      authProfileId: input.authProfileId,
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    }),
  );
}

export function buildCliLiveSessionKey(context: PreparedCliRunContext): string {
  return buildCliLiveRegistryKey({
    backendId: context.backendResolved.id,
    agentAccountId: context.params.agentAccountId,
    agentId: context.params.agentId,
    authProfileId: context.effectiveAuthProfileId,
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
  });
}

/** Returns whether this owner still has an in-process plugin-owned session. */
export function hasCliLiveSession(owner: CliLiveSessionOwner): boolean {
  return getCliLiveSessionGeneration(owner) !== undefined;
}

/** Returns the opaque generation of this owner's current or pending execution session. */
export function getCliLiveSessionGeneration(owner: CliLiveSessionOwner): string | undefined {
  const key = buildCliLiveRegistryKey(owner);
  return liveSessions.get(key)?.generation ?? liveSessionCreates.get(key)?.generation;
}

export function getCliLiveSession(key: string): CliBackendLiveSessionHandle | undefined {
  return liveSessions.get(key);
}

export function registerCliLiveSession(
  session: CliBackendLiveSessionHandle,
  pending: CliLiveSessionCreate,
  cleanup?: () => Promise<void>,
): void {
  if (liveSessionCreates.get(session.key) !== pending || pending.closeReason) {
    session.close(pending.closeReason ?? "restart");
    return;
  }
  liveSessions.set(session.key, session);
  liveSessionApprovalGrants.set(session, new Set());
  if (cleanup) {
    liveSessionCleanup.set(session, cleanup);
  }
  cliBackendLog.info(
    `cli live session start: provider=${session.providerId} model=${session.modelId} activeSessions=${liveSessions.size}`,
  );
}

export function removeCliLiveSession(session: CliBackendLiveSessionHandle): void {
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
    liveSessionApprovalGrants.delete(session);
    const cleanup = liveSessionCleanup.get(session);
    if (cleanup && !liveSessionCleanupPromises.has(session)) {
      liveSessionCleanup.delete(session);
      // Native runtime artifacts remain process-owned until the child has
      // actually exited, even when close removes its lookup immediately.
      const completed = session.waitForExit().then(cleanup);
      void completed.catch((error: unknown) => {
        cliBackendLog.warn(`cli live session cleanup failed: ${String(error)}`);
      });
      liveSessionCleanupPromises.set(session, completed);
    }
  }
}

/** Reads owner-private standing approvals only from this exact current live process. */
export function getCliLiveSessionApprovalGrants(
  context: PreparedCliRunContext,
): Set<string> | undefined {
  const session = liveSessions.get(buildCliLiveSessionKey(context));
  return session ? liveSessionApprovalGrants.get(session) : undefined;
}

export function beginCliLiveSessionCreate(key: string, generation: string): CliLiveSessionCreate {
  const create = { generation };
  liveSessionCreates.set(key, create);
  return create;
}

export function finishCliLiveSessionCreate(key: string, create: CliLiveSessionCreate): void {
  if (liveSessionCreates.get(key) === create) {
    liveSessionCreates.delete(key);
  }
}

export function enqueueCliLiveTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  return liveSessionTurns.enqueue(key, task);
}

/** Closes the live execution session associated with a prepared run context, if one exists. */
export async function closeCliLiveSession(
  context: PreparedCliRunContext,
  reason: CliBackendLiveSessionCloseReason,
): Promise<void> {
  const key = buildCliLiveSessionKey(context);
  const session = liveSessions.get(key);
  const pending = liveSessionCreates.get(key);
  if (session) {
    session.close(reason);
  }
  if (pending) {
    pending.closeReason = reason;
    liveSessionCreates.delete(key);
  }
  if (session) {
    await session.waitForExit();
    await session.cleanupResources();
    await liveSessionCleanupPromises.get(session);
  }
}

function closeOldestIdleSession(): boolean {
  for (const session of liveSessions.values()) {
    if (session.isIdle()) {
      session.close("idle");
      return true;
    }
  }
  return false;
}

export function ensureCliLiveSessionCapacity(key: string, context: PreparedCliRunContext): void {
  if (
    liveSessions.has(key) ||
    liveSessionCreates.has(key) ||
    liveSessions.size + liveSessionCreates.size < MAX_LIVE_SESSIONS
  ) {
    return;
  }
  if (closeOldestIdleSession()) {
    return;
  }
  throw new FailoverError("Too many CLI live sessions are active.", {
    reason: "rate_limit",
    provider: context.params.provider,
    model: context.modelId,
    status: resolveFailoverStatus("rate_limit"),
  });
}

/** Returns whether this prepared local plugin transport may retain its execution process. */
export function acceptsCliLiveSession(context: PreparedCliRunContext): boolean {
  return (
    context.params.sessionEntry?.execHost !== "node" &&
    Boolean(context.preparedBackend.execute) &&
    context.backendResolved.liveSessionRequirement === undefined &&
    context.preparedBackend.backend.liveSession !== undefined &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

/** Closes all plugin-owned sessions and clears creation promises for tests. */
function resetCliLiveSessionsForTest(): void {
  for (const session of liveSessions.values()) {
    session.close("restart");
  }
  liveSessions.clear();
  for (const pending of liveSessionCreates.values()) {
    pending.closeReason = "restart";
  }
  liveSessionCreates.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliLiveRegistryReset")] =
    resetCliLiveSessionsForTest;
}
