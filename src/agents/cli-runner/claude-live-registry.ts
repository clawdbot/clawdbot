import { sha256Hex } from "../../infra/crypto-digest.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { LIVE_SESSION_LIMITS } from "./claude-live-session-policy.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ClaudeLiveSessionOwner = {
  backendId: string;
  agentAccountId?: string;
  agentId?: string;
  authProfileId?: string;
  sessionId?: string;
  sessionKey?: string;
};

type ClaudeLiveCloseReason = "idle" | "restart" | "abort" | "mcp-capture-rotation";

/** Structural process handle kept by the registry without importing its implementation. */
type ClaudeLiveProcessHandle = {
  key: string;
  generation: string;
  providerId: string;
  modelId: string;
  isIdle(): boolean;
  close(reason: ClaudeLiveCloseReason, error?: unknown): void;
  waitForExit(): Promise<void>;
  cleanupResources(): Promise<void>;
};

type ClaudeLiveSessionCreate = {
  generation: string;
  closeReason?: ClaudeLiveCloseReason;
};

const liveSessions = new Map<string, ClaudeLiveProcessHandle>();
const liveSessionCreates = new Map<string, ClaudeLiveSessionCreate>();
const liveSessionTurns = new KeyedAsyncQueue();

function buildClaudeLiveOwnerKey(owner: ClaudeLiveSessionOwner): string {
  return `${owner.backendId}:${buildClaudeOwnerKey(owner)}`;
}

/** Hashes the account/agent/auth/session tuple shared by queue and registry ownership. */
export function buildClaudeOwnerKey(input: Omit<ClaudeLiveSessionOwner, "backendId">): string {
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

export function buildClaudeLiveKey(context: PreparedCliRunContext): string {
  return buildClaudeLiveOwnerKey({
    backendId: context.backendResolved.id,
    agentAccountId: context.params.agentAccountId,
    agentId: context.params.agentId,
    authProfileId: context.effectiveAuthProfileId,
    sessionId: context.params.sessionId,
    sessionKey: context.params.sessionKey,
  });
}

/** Returns whether this owner still has an in-process Claude stdio session. */
export function hasClaudeSession(owner: ClaudeLiveSessionOwner): boolean {
  return getClaudeGeneration(owner) !== undefined;
}

/** Returns the opaque generation of this owner's current or pending Claude stdio session. */
export function getClaudeGeneration(owner: ClaudeLiveSessionOwner): string | undefined {
  const key = buildClaudeLiveOwnerKey(owner);
  return liveSessions.get(key)?.generation ?? liveSessionCreates.get(key)?.generation;
}

export function getClaudeSession(key: string): ClaudeLiveProcessHandle | undefined {
  return liveSessions.get(key);
}

export function registerClaudeSession(
  session: ClaudeLiveProcessHandle,
  pending: ClaudeLiveSessionCreate,
): void {
  if (liveSessionCreates.get(session.key) !== pending || pending.closeReason) {
    session.close(pending.closeReason ?? "restart");
    return;
  }
  liveSessions.set(session.key, session);
  cliBackendLog.info(
    `claude live session start: provider=${session.providerId} model=${session.modelId} activeSessions=${liveSessions.size}`,
  );
}

export function removeClaudeSession(session: ClaudeLiveProcessHandle): void {
  if (liveSessions.get(session.key) === session) {
    liveSessions.delete(session.key);
  }
}

export function beginClaudeSessionCreate(key: string, generation: string): ClaudeLiveSessionCreate {
  const create = { generation };
  liveSessionCreates.set(key, create);
  return create;
}

export function finishClaudeSessionCreate(key: string, create: ClaudeLiveSessionCreate): void {
  if (liveSessionCreates.get(key) === create) {
    liveSessionCreates.delete(key);
  }
}

export function enqueueClaudeTurn<T>(key: string, task: () => Promise<T>): Promise<T> {
  return liveSessionTurns.enqueue(key, task);
}

/** Closes the live Claude session associated with a prepared run context, if one exists. */
export async function closeClaudeSession(
  context: PreparedCliRunContext,
  reason: ClaudeLiveCloseReason,
): Promise<void> {
  const key = buildClaudeLiveKey(context);
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

export function ensureClaudeSessionCapacity(key: string, context: PreparedCliRunContext): void {
  if (
    liveSessions.has(key) ||
    liveSessionCreates.has(key) ||
    liveSessions.size + liveSessionCreates.size < LIVE_SESSION_LIMITS.maxSessions
  ) {
    return;
  }
  if (closeOldestIdleSession()) {
    return;
  }
  throw new FailoverError("Too many Claude CLI live sessions are active.", {
    reason: "rate_limit",
    provider: context.params.provider,
    model: context.modelId,
    status: resolveFailoverStatus("rate_limit"),
  });
}

/** Closes all live Claude CLI sessions and clears creation promises for tests. */
function resetClaudeLiveSessionsForTest(): void {
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
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.claudeLiveRegistryReset")] =
    resetClaudeLiveSessionsForTest;
}
