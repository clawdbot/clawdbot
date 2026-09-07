import { sha256Hex } from "../../infra/crypto-digest.js";
import type {
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionCloseReason,
  CliBackendLiveSessionHandle,
} from "../../plugins/cli-backend.types.js";
import { runCliCleanup } from "./cleanup.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import { createCliFailoverError } from "./exit-error.js";
import { buildCliLiveSessionFingerprint } from "./live-session-fingerprint.js";
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

type CliLiveSessionRecord = {
  handle: CliBackendLiveSessionHandle;
  owner: PreparedCliRunContext["preparedBackend"];
  approvalGrants: Set<string>;
  cleanup?: () => Promise<void>;
  cleanupPromise?: Promise<void>;
  capture?: {
    token: string;
    key: string;
    revoke: () => void;
  };
};

const liveSessions = new Map<string, CliLiveSessionRecord>();
const retiredSessionCleanup = new Map<string, Promise<void>>();
const retiringSessionHandles = new WeakSet<CliBackendLiveSessionHandle>();

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

function buildCliLiveSessionKey(context: PreparedCliRunContext): string {
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

/** Returns the opaque generation of this owner's registered execution session. */
export function getCliLiveSessionGeneration(owner: CliLiveSessionOwner): string | undefined {
  return liveSessions.get(buildCliLiveRegistryKey(owner))?.handle.generation;
}

/** Reads owner-private standing approvals only from this exact current live process. */
export function getCliLiveSessionApprovalGrants(
  context: PreparedCliRunContext,
): Set<string> | undefined {
  return liveSessions.get(buildCliLiveSessionKey(context))?.approvalGrants;
}

/** Closes the live execution session associated with a prepared run context, if one exists. */
export async function closeCliLiveSession(
  context: PreparedCliRunContext,
  reason: CliBackendLiveSessionCloseReason,
): Promise<void> {
  await runCliCleanup(context.params, "cli-live-session-close", async () => {
    await context.preparedBackend.closeLiveSession?.(reason);
  });
}

/** Explicit fresh/fork execution owns replacement of the current idle process. */
export async function restartCliLiveSession(
  context: PreparedCliRunContext,
  signal = context.params.abortSignal,
): Promise<void> {
  const assertActive = createCliRunCurrentAssertion(context.params, signal);
  assertActive();
  const key = buildCliLiveSessionKey(context);
  const record = liveSessions.get(key);
  const pendingCleanup = retiredSessionCleanup.get(key);
  await runCliCleanup(
    context.params,
    "cli-live-session-close",
    async () => {
      assertActive();
      await context.preparedBackend.closeLiveSession?.("restart");
      await pendingCleanup;
    },
    "required",
  );
  if (record) {
    await runCliCleanup(
      context.params,
      "cli-live-session-restart",
      () => {
        // One-shot cleanup schedules this callback; fence the actual close.
        assertActive();
        return closeRecord(record, "restart");
      },
      "required",
    );
  }
  assertActive();
}

async function closeRecord(
  record: CliLiveSessionRecord,
  reason: CliBackendLiveSessionCloseReason,
): Promise<void> {
  if (!record.cleanupPromise) {
    record.handle.close(reason);
  }
  await (record.cleanupPromise ?? record.handle.waitForExit());
}

function retainCleanup(context: PreparedCliRunContext, record: CliLiveSessionRecord): void {
  const owner = context.preparedBackend;
  record.owner = owner;
  owner.closeLiveSession = async (reason) => {
    // Natural removal retains this exact cleanup promise. A later turn may
    // borrow the live process, but the old turn cannot close that successor.
    if (record.owner === owner || record.cleanupPromise) {
      await closeRecord(record, reason);
    }
  };
}

function ensureCliLiveSessionCapacity(context: PreparedCliRunContext): void {
  if (liveSessions.size < MAX_LIVE_SESSIONS) {
    return;
  }
  for (const { handle } of liveSessions.values()) {
    if (handle.isIdle()) {
      handle.close("idle");
      return;
    }
  }
  throw createCliFailoverError("Too many CLI live sessions are active.", "rate_limit", {
    provider: context.params.provider,
    model: context.modelId,
    sessionId: context.params.sessionId,
    lane: context.params.lane,
  });
}

/** Returns whether this prepared local plugin transport may retain its execution process. */
export function acceptsCliLiveSession(context: PreparedCliRunContext): boolean {
  return (
    context.executionTarget.kind === "plugin" &&
    context.preparedBackend.backend.liveSession !== undefined &&
    context.preparedBackend.backend.output === "jsonl" &&
    context.preparedBackend.backend.input === "stdin"
  );
}

/** Creates host-owned lifecycle authority without exposing owner keys or bearer material. */
export function createCliLiveSessionCapability(params: {
  context: PreparedCliRunContext;
  argv: readonly string[];
  argv0?: string;
  env: Record<string, string>;
  captureKey?: string;
  beginCapture: (captureKey: string | undefined) => void;
  abortSignal: AbortSignal;
  requiredGeneration?: string;
  claimResources?: () => (() => Promise<void>) | undefined;
}): CliBackendLiveSessionCapability {
  const ownerKey = buildCliLiveSessionKey(params.context);
  const fingerprint = buildCliLiveSessionFingerprint({
    context: params.context,
    argv: params.argv,
    argv0: params.argv0,
    env: params.env,
  });
  const grant = params.context.preparedBackend.mcpClientGrantCapture;
  if (Boolean(grant) !== Boolean(params.captureKey)) {
    throw new Error("CLI live process and current turn disagree about MCP capture ownership.");
  }

  const requiredSessionError = (code: "cli_live_session_changed" | "cli_live_session_missing") =>
    createCliFailoverError(
      "Managed CLI live session is no longer reusable.",
      "session_expired",
      {
        provider: params.context.params.provider,
        model: params.context.modelId,
        sessionId: params.context.params.sessionId,
        lane: params.context.params.lane,
      },
      { code },
    );
  const assertActive = createCliRunCurrentAssertion(params.context.params, params.abortSignal);
  const requireRegisteredRecord = (handle: CliBackendLiveSessionHandle) => {
    assertActive();
    const record = liveSessions.get(ownerKey);
    if (handle.fingerprint !== fingerprint || record?.handle !== handle) {
      throw new Error("CLI live session no longer belongs to this admitted run.");
    }
    if (params.requiredGeneration && params.requiredGeneration !== handle.generation) {
      throw requiredSessionError("cli_live_session_changed");
    }
    return record;
  };

  return Object.freeze({
    fingerprint,
    current: () => {
      assertActive();
      const handle = liveSessions.get(ownerKey)?.handle;
      if (params.requiredGeneration && handle?.generation !== params.requiredGeneration) {
        throw requiredSessionError(
          handle ? "cli_live_session_changed" : "cli_live_session_missing",
        );
      }
      if (params.requiredGeneration && handle?.fingerprint !== fingerprint) {
        throw requiredSessionError("cli_live_session_changed");
      }
      return handle;
    },
    register: (handle) => {
      assertActive();
      if (retiredSessionCleanup.has(ownerKey)) {
        throw new Error("Previous CLI live session cleanup has not settled.");
      }
      if (params.requiredGeneration) {
        throw requiredSessionError("cli_live_session_changed");
      }
      if (
        handle.fingerprint !== fingerprint ||
        !handle.generation.trim() ||
        liveSessions.has(ownerKey) ||
        // Owner keys stay private; one process handle must never cross owners.
        retiringSessionHandles.has(handle) ||
        Array.from(liveSessions.values()).some((record) => record.handle === handle)
      ) {
        throw new Error("CLI live session registration does not match its admitted owner.");
      }
      ensureCliLiveSessionCapacity(params.context);
      const cleanup = params.claimResources?.();
      const record: CliLiveSessionRecord = {
        handle,
        owner: params.context.preparedBackend,
        approvalGrants: new Set(),
        ...(cleanup ? { cleanup } : {}),
        ...(grant && params.captureKey
          ? {
              capture: {
                token: grant.transportToken,
                key: params.captureKey,
                revoke: grant.revokeProcessToken,
              },
            }
          : {}),
      };
      liveSessions.set(ownerKey, record);
      retainCleanup(params.context, record);
      cliBackendLog.info(
        `cli live session start: provider=${params.context.backendResolved.id} model=${params.context.normalizedModel} activeSessions=${liveSessions.size}`,
      );
    },
    activate: (handle) => {
      const record = requireRegisteredRecord(handle);
      if (Boolean(record.capture) !== Boolean(grant)) {
        throw new Error("CLI live session MCP topology changed across admitted turns.");
      }
      if (record.capture && grant) {
        // Transfer the exact current admission before activating the original
        // child capture header; copied bearers never carry authority alone.
        grant.adoptProcessToken(record.capture.token);
        requireRegisteredRecord(handle);
        params.beginCapture(record.capture.key);
      }
      retainCleanup(params.context, record);
    },
    remove: (handle) => {
      const record = liveSessions.get(ownerKey);
      if (record?.handle !== handle) {
        return;
      }
      record.capture?.revoke();
      liveSessions.delete(ownerKey);
      record.approvalGrants.clear();
      retiringSessionHandles.add(handle);
      // Native runtime artifacts remain process-owned until its child exits.
      record.cleanupPromise = Promise.resolve()
        .then(() => handle.waitForExit())
        .then(() => record.cleanup?.())
        .then(() => {
          retiringSessionHandles.delete(handle);
          if (retiredSessionCleanup.get(ownerKey) === record.cleanupPromise) {
            retiredSessionCleanup.delete(ownerKey);
          }
        });
      // A fresh prepared context must still join the retired owner after a timeout.
      retiredSessionCleanup.set(ownerKey, record.cleanupPromise);
      void record.cleanupPromise.catch((error: unknown) => {
        cliBackendLog.warn(`cli live session cleanup failed: ${String(error)}`);
      });
    },
  });
}
