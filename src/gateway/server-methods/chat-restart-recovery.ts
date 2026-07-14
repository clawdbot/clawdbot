import { createHmac } from "node:crypto";
import { listActiveEmbeddedRunSessionIds } from "../../agents/embedded-agent-runner/run-state.js";
import { shouldComputeCommandAuthorized } from "../../auto-reply/command-detection.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import {
  resolveChannelResetConfig,
  resolveSessionResetType,
  resolveSessionWorkStartError,
  type SessionEntry,
} from "../../config/sessions.js";
import { resolveSessionEntryResetFreshness } from "../../config/sessions/entry-freshness.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  hasRestartRecoveryTerminalRun,
} from "../../config/sessions/restart-recovery-state.js";
import {
  patchSessionEntry,
  type SessionTranscriptTurnExpectedState,
  type SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateProcessDeviceIdentity } from "../../infra/device-identity.js";
import { hasGlobalHooks } from "../../plugins/hook-runner-global.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { isAcpSessionKey } from "../../sessions/session-key-utils.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import type { GatewayRequestContext } from "./types.js";

export { hasRestartRecoveryTerminalRun };

const RESTART_SAFE_CHAT_UNSAFE_HOOKS = [
  "before_dispatch",
  "before_agent_reply",
  "before_agent_run",
  "before_message_write",
  "reply_dispatch",
] as const;
const RESTART_SAFE_CHAT_REQUEST_VERIFIER_DOMAIN = "openclaw.chat.restart-retry.v1";

type RestartSafeChatRequest = {
  fingerprint: string;
};

export type RestartSafeChatAdmission = {
  priorTerminalSourceRunId?: string;
  requestFingerprint: string;
  retryExpectedState?: SessionTranscriptTurnExpectedState;
};

type RetryableUnadoptedChatClaim = SessionEntry & {
  abortedLastRun?: false;
  restartRecoveryDeliveryContext?: undefined;
  restartRecoveryDeliveryRequestFingerprint: string;
  restartRecoveryDeliveryRunId: string;
  restartRecoveryDeliverySourceRunId: string;
  status: "failed" | "killed";
};

type DurableChatClaimResolution =
  | { kind: "continue"; entry?: SessionEntry }
  | { kind: "accepted" }
  | { kind: "pending"; message: string }
  | { kind: "rejected"; message: string; unavailable?: true };

function hasRestartUnsafeMessageSemantics(rawMessage: string, cfg: OpenClawConfig): boolean {
  if (
    shouldComputeCommandAuthorized(rawMessage, cfg) ||
    rawMessage.startsWith("/") ||
    rawMessage.startsWith("!")
  ) {
    return true;
  }
  const directives = parseInlineDirectives(rawMessage, {
    stripAudioTag: false,
    stripReplyTags: false,
  });
  return directives.hasAudioTag || directives.hasReplyTag;
}

function fingerprintRestartSafeChatRequest(params: {
  message: string;
  senderIsOwner: boolean;
}): string {
  const identity = loadOrCreateProcessDeviceIdentity();
  const digest = createHmac("sha256", identity.privateKeyPem)
    .update(
      JSON.stringify([
        RESTART_SAFE_CHAT_REQUEST_VERIFIER_DOMAIN,
        params.message,
        params.senderIsOwner,
      ]),
    )
    .digest("hex");
  // The verifier survives a gateway restart without retaining an offline
  // digest of redacted prompt material in the session database.
  return `hmac-sha256:v1:${identity.deviceId}:${digest}`;
}

export function createRestartSafeChatRequest(params: {
  eligible: boolean;
  message: string;
  senderIsOwner: boolean;
  cfg: OpenClawConfig;
}): RestartSafeChatRequest | undefined {
  if (!params.eligible || hasRestartUnsafeMessageSemantics(params.message, params.cfg)) {
    return undefined;
  }
  return {
    fingerprint: fingerprintRestartSafeChatRequest({
      message: params.message,
      senderIsOwner: params.senderIsOwner,
    }),
  };
}

export function isRetryableUnadoptedChatClaim(
  entry: SessionEntry | undefined,
  clientRunId: string,
): entry is RetryableUnadoptedChatClaim {
  return Boolean(
    entry &&
    entry.abortedLastRun !== true &&
    (entry.status === "failed" || entry.status === "killed") &&
    entry.restartRecoveryDeliveryContext === undefined &&
    entry.restartRecoveryDeliveryRunId === clientRunId &&
    entry.restartRecoveryDeliverySourceRunId === clientRunId &&
    entry.restartRecoveryDeliveryRequestFingerprint,
  );
}

function isAdoptedRestartRecoveryClaim(
  entry: SessionEntry | undefined,
  clientRunId: string,
): entry is SessionEntry & {
  restartRecoveryDeliveryRunId: string;
  restartRecoveryDeliverySourceRunId: string;
} {
  return Boolean(
    entry?.restartRecoveryDeliveryRunId &&
    entry.restartRecoveryDeliverySourceRunId === clientRunId &&
    !isRetryableUnadoptedChatClaim(entry, clientRunId),
  );
}

export async function resolveDurableChatClaim(params: {
  canonicalSessionKey: string;
  cfg: OpenClawConfig;
  clientRunId: string;
  entry?: SessionEntry;
  persistedSessionKey: string;
  reloadEntry: () => SessionEntry | undefined;
  storePath: string;
  warn: (message: string) => void;
}): Promise<DurableChatClaimResolution> {
  let entry = params.entry;
  if (
    isAdoptedRestartRecoveryClaim(entry, params.clientRunId) &&
    entry.status === "running" &&
    entry.abortedLastRun === true
  ) {
    const recoverySessionError = resolveSessionWorkStartError(params.canonicalSessionKey, entry);
    if (recoverySessionError) {
      return { kind: "rejected", message: recoverySessionError };
    }
    try {
      const { retryRestartAbortedMainSessionRecovery } =
        await import("../../agents/main-session-restart-recovery.js");
      await retryRestartAbortedMainSessionRecovery({
        canonicalSessionKey: params.canonicalSessionKey,
        cfg: params.cfg,
        expectedRecoveryRunId: entry.restartRecoveryDeliveryRunId,
        expectedRecoverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
        expectedSessionId: entry.sessionId,
        sessionKey: params.persistedSessionKey,
        storePath: params.storePath,
      });
    } catch (error) {
      params.warn(String(error));
    }
    entry = params.reloadEntry();
    if (
      isAdoptedRestartRecoveryClaim(entry, params.clientRunId) &&
      entry.status === "running" &&
      entry.abortedLastRun === true
    ) {
      return {
        kind: "pending",
        message: "accepted chat turn recovery is still pending; retry",
      };
    }
    if (
      !isAdoptedRestartRecoveryClaim(entry, params.clientRunId) &&
      !hasRestartRecoveryTerminalRun(entry, params.clientRunId)
    ) {
      return {
        kind: "rejected",
        message:
          "accepted chat turn recovery ownership changed; automatic retry stopped to avoid duplicate execution",
        unavailable: true,
      };
    }
  }
  return isAdoptedRestartRecoveryClaim(entry, params.clientRunId) ||
    hasRestartRecoveryTerminalRun(entry, params.clientRunId)
    ? { kind: "accepted" }
    : { kind: "continue", entry };
}

function isRestartSafeChatSession(params: {
  entry?: SessionEntry;
  requestedSessionId?: string;
  sessionKey: string;
}): boolean {
  const entry = params.entry;
  return Boolean(
    entry?.sessionId &&
    params.sessionKey !== "global" &&
    entry.status !== "running" &&
    entry.abortedLastRun !== true &&
    entry.archivedAt === undefined &&
    entry.initializationPending !== true &&
    entry.pendingFinalDelivery !== true &&
    entry.pendingFinalDeliveryText == null &&
    entry.pendingFinalDeliveryContext === undefined &&
    entry.agentHarnessId === undefined &&
    entry.pluginOwnerId === undefined &&
    entry.spawnedBy === undefined &&
    entry.subagentRole === undefined &&
    (entry.spawnDepth ?? 0) === 0 &&
    entry.acp === undefined &&
    entry.cronRunContinuation === undefined &&
    !isSubagentSessionKey(params.sessionKey) &&
    !isCronSessionKey(params.sessionKey) &&
    !isAcpSessionKey(params.sessionKey) &&
    !isAgentHarnessSessionKey(params.sessionKey) &&
    (params.requestedSessionId === undefined || params.requestedSessionId === entry.sessionId),
  );
}

function hasRestartUnsafeChatWork(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers"> &
    Partial<Pick<GatewayRequestContext, "chatQueuedTurns">>;
  sessionId: string;
  sessionKey: string;
}): boolean {
  if (
    RESTART_SAFE_CHAT_UNSAFE_HOOKS.some((hookName) => hasGlobalHooks(hookName)) ||
    listActiveEmbeddedRunSessionIds().includes(params.sessionId) ||
    replyRunRegistry.isActive(params.sessionKey)
  ) {
    return true;
  }
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.sessionKey || active.sessionId === params.sessionId) {
      return true;
    }
  }
  for (const queued of params.context.chatQueuedTurns?.values() ?? []) {
    if (queued.sessionKey === params.sessionKey || queued.sessionId === params.sessionId) {
      return true;
    }
  }
  return false;
}

export function resolveRestartSafeChatAdmission(params: {
  agentId: string;
  cfg: OpenClawConfig;
  clientRunId: string;
  context: Pick<GatewayRequestContext, "chatAbortControllers" | "chatQueuedTurns">;
  entry?: SessionEntry;
  now: number;
  request?: RestartSafeChatRequest;
  requestedSessionId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): RestartSafeChatAdmission | undefined {
  const request = params.request;
  const entry = params.entry;
  if (
    !request ||
    !entry ||
    !isRestartSafeChatSession(params) ||
    resolveSessionEntryResetFreshness({
      agentId: params.agentId,
      now: params.now,
      resetOverride: resolveChannelResetConfig({
        sessionCfg: params.cfg.session,
        channel: params.entry?.lastChannel ?? params.entry?.channel,
      }),
      resetType: resolveSessionResetType({ sessionKey: params.sessionKey }),
      sessionCfg: params.cfg.session,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    }).state !== "fresh" ||
    hasRestartUnsafeChatWork(params)
  ) {
    return undefined;
  }
  const retryableClaim = isRetryableUnadoptedChatClaim(entry, params.clientRunId);
  if (retryableClaim && entry.restartRecoveryDeliveryRequestFingerprint !== request.fingerprint) {
    throw new Error("chat retry does not match its durable admission");
  }
  return {
    requestFingerprint: request.fingerprint,
    ...(retryableClaim
      ? {
          retryExpectedState: {
            abortedLastRun: entry.abortedLastRun,
            restartRecoveryDeliveryRequestFingerprint:
              entry.restartRecoveryDeliveryRequestFingerprint,
            restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
            restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
            status: entry.status,
            updatedAt: entry.updatedAt,
          },
        }
      : entry.restartRecoveryDeliverySourceRunId
        ? { priorTerminalSourceRunId: entry.restartRecoveryDeliverySourceRunId }
        : {}),
  };
}

export function buildRestartSafeChatTranscriptState(params: {
  admission: RestartSafeChatAdmission;
  clientRunId: string;
  startedAt: number;
}): {
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  sessionLifecyclePatch: SessionTranscriptTurnLifecyclePatch;
} {
  return {
    ...(params.admission.retryExpectedState
      ? { expectedSessionState: params.admission.retryExpectedState }
      : {}),
    sessionLifecyclePatch: {
      status: "running",
      startedAt: params.startedAt,
      endedAt: undefined,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: params.admission.requestFingerprint,
      restartRecoveryDeliveryRunId: params.clientRunId,
      restartRecoveryDeliverySourceRunId: params.clientRunId,
      ...(params.admission.priorTerminalSourceRunId
        ? { restartRecoveryTerminalRunIds: [params.admission.priorTerminalSourceRunId] }
        : {}),
      runtimeMs: undefined,
      abortedLastRun: false,
      updatedAt: params.startedAt,
    },
  };
}

export async function terminalizeRestartSafeChatAdmission(params: {
  admittedSessionId: string;
  clientRunId: string;
  retryable: boolean;
  sessionKey: string;
  startedAt: number;
  status: "failed" | "killed";
  storePath: string;
}): Promise<boolean> {
  const endedAt = Date.now();
  let terminalized = false;
  await patchSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (current) => {
      if (
        current.sessionId !== params.admittedSessionId ||
        current.restartRecoveryDeliveryRunId !== params.clientRunId
      ) {
        return null;
      }
      terminalized = true;
      return {
        abortedLastRun: params.retryable ? false : params.status === "killed",
        endedAt,
        ...(params.retryable
          ? {}
          : buildRestartRecoveryClaimCleanupPatch({
              entry: current,
              recordTerminalSource: true,
              terminalSourceRunId: current.restartRecoveryDeliverySourceRunId,
            })),
        runtimeMs: Math.max(0, endedAt - params.startedAt),
        status: params.status,
        updatedAt: endedAt,
      };
    },
    { requireWriteSuccess: true, skipMaintenance: true },
  );
  return terminalized;
}
