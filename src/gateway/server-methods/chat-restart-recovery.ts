import { createHmac } from "node:crypto";
import type { HumanMention } from "../../../packages/gateway-protocol/src/index.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../../agents/agent-runtime-id.js";
import { listActiveEmbeddedRunSessionIds } from "../../agents/embedded-agent-runner/active-run-projections.js";
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
  patchSessionEntryCore,
  type SessionTranscriptTurnExpectedState,
  type SessionTranscriptTurnLifecyclePatch,
} from "../../config/sessions/session-accessor.js";
import { buildRestartRecoveryExpectedState } from "../../config/sessions/session-transcript-turn-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateProcessDeviceIdentity } from "../../infra/device-identity.js";
import { findRestartRecoveryUnsafeChatAdmissionHook } from "../../plugins/restart-recovery-hook-safety.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { isAgentHarnessSessionKey } from "../../sessions/agent-harness-session-key.js";
import { isAcpSessionKey, resolveSessionDispatchKind } from "../../sessions/session-key-utils.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.shared.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import type { GatewayRecoveryRuntime } from "../server-instance-runtime.types.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../session-lifecycle-state.js";
import { resolveChatSendActiveScopeKey } from "./chat-origin-routing.js";
import type { GatewayRequestContext } from "./types.js";

export { hasRestartRecoveryTerminalRun };

const RESTART_SAFE_CHAT_REQUEST_VERIFIER_DOMAIN = "openclaw.chat.restart-retry.v1";

type RestartSafeChatRequest = {
  fingerprint: string;
};

type RestartSafeChatAdmission = {
  priorTerminalSourceRunId?: string;
  requestFingerprint: string;
  retryExpectedState?: SessionTranscriptTurnExpectedState;
};

export type RestartSafeChatTerminalState = {
  error?: string;
  retryable: boolean;
  status: "failed" | "killed";
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
  mentions?: readonly HumanMention[];
  senderIsOwner: boolean;
}): string {
  const identity = loadOrCreateProcessDeviceIdentity();
  const digest = createHmac("sha256", identity.privateKeyPem)
    .update(
      JSON.stringify([
        RESTART_SAFE_CHAT_REQUEST_VERIFIER_DOMAIN,
        params.message,
        params.senderIsOwner,
        ...(params.mentions?.length
          ? [params.mentions.map(({ profileId, start, end }) => [profileId, start, end])]
          : []),
      ]),
    )
    .digest("hex");
  // The verifier survives a gateway restart without retaining an offline
  // digest of redacted prompt material in the session database.
  return `hmac-sha256:v1:${identity.deviceId}:${digest}`;
}

export function createRestartSafeChatRequest(params: {
  goalRequestFingerprint?: string;
  eligible: boolean;
  message: string;
  mentions?: readonly HumanMention[];
  senderIsOwner: boolean;
  cfg: OpenClawConfig;
}): RestartSafeChatRequest | undefined {
  if (params.goalRequestFingerprint) {
    // Goal admission owns literal intent; slash-looking objectives are not commands.
    // Its receipt fingerprints attachments, routing, and every immutable run option.
    return { fingerprint: params.goalRequestFingerprint };
  }
  if (!params.eligible || hasRestartUnsafeMessageSemantics(params.message, params.cfg)) {
    return undefined;
  }
  return {
    fingerprint: fingerprintRestartSafeChatRequest({
      message: params.message,
      mentions: params.mentions,
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
  recoveryRuntime?: GatewayRecoveryRuntime;
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
    if (!params.recoveryRuntime) {
      return {
        kind: "pending",
        message: "accepted chat turn recovery is waiting for the Gateway runtime; retry",
      };
    }
    try {
      const { retryRestartAbortedMainSessionRecovery } =
        await import("../../agents/main-session-recovery/main-session-restart-recovery.js");
      await retryRestartAbortedMainSessionRecovery({
        canonicalSessionKey: params.canonicalSessionKey,
        cfg: params.cfg,
        expectedRecoveryRunId: entry.restartRecoveryDeliveryRunId,
        expectedRecoverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
        expectedSessionId: entry.sessionId,
        sessionKey: params.persistedSessionKey,
        storePath: params.storePath,
        gatewayRuntime: params.recoveryRuntime,
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
    entry.pendingFinalDelivery === undefined &&
    (entry.agentHarnessId === undefined || entry.agentHarnessId === OPENCLAW_AGENT_RUNTIME_ID) &&
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
  agentId: string;
  entry?: SessionEntry;
}): boolean {
  if (
    findRestartRecoveryUnsafeChatAdmissionHook(
      resolveSessionDispatchKind(params.sessionKey, params.entry),
    ) !== undefined ||
    listActiveEmbeddedRunSessionIds().includes(params.sessionId) ||
    replyRunRegistry.isActive(
      resolveChatSendActiveScopeKey({
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      }),
    )
  ) {
    return true;
  }
  for (const active of params.context.chatAbortControllers.values()) {
    if (
      (active.sessionKey === params.sessionKey || active.sessionId === params.sessionId) &&
      resolveChatRunOwnerAgentId({
        agentId: active.agentId,
        sessionKey: active.sessionKey,
        defaultAgentId: params.agentId,
      }) === params.agentId
    ) {
      return true;
    }
  }
  for (const queued of params.context.chatQueuedTurns?.values() ?? []) {
    if (
      (queued.sessionKey === params.sessionKey || queued.sessionId === params.sessionId) &&
      resolveChatRunOwnerAgentId({
        agentId: queued.agentId,
        sessionKey: queued.sessionKey,
        defaultAgentId: params.agentId,
      }) === params.agentId
    ) {
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
  initialSessionEntry?: SessionEntry;
  now: number;
  request?: RestartSafeChatRequest;
  requestedSessionId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): RestartSafeChatAdmission | undefined {
  const request = params.request;
  const entry = params.entry ?? params.initialSessionEntry;
  if (
    !request ||
    !entry ||
    !isRestartSafeChatSession({ ...params, entry }) ||
    (!params.initialSessionEntry &&
      resolveSessionEntryResetFreshness({
        agentId: params.agentId,
        now: params.now,
        resetOverride: resolveChannelResetConfig({
          sessionCfg: params.cfg.session,
          channel: sessionDeliveryChannel(params.entry),
        }),
        resetType: resolveSessionResetType({ sessionKey: params.sessionKey }),
        sessionCfg: params.cfg.session,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      }).state !== "fresh") ||
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
          retryExpectedState: buildRestartRecoveryExpectedState(entry),
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
      // The runner records `pending` only while a hook is executing. With no
      // checkpoint, recovery simply re-enters the normal agent hook pipeline.
      restartRecoveryBeforeAgentReplyState: undefined,
      restartRecoveryDeliveryReceiptState: undefined,
      restartRecoveryDeliveryToolCallId: undefined,
      ...deriveGatewaySessionLifecycleSnapshot({
        event: { runId: params.clientRunId, ts: params.startedAt, data: { phase: "start" } },
      }),
      lifecycleRunId: params.clientRunId,
      lastRunId: undefined,
      restartRecoveryDeliveryContext: undefined,
      restartRecoveryDeliveryRequestFingerprint: params.admission.requestFingerprint,
      restartRecoveryDeliveryRunId: params.clientRunId,
      restartRecoveryDeliverySourceRunId: params.clientRunId,
      restartRecoveryRequesterAccountId: undefined,
      restartRecoveryRequesterSenderId: undefined,
      restartRecoverySameChannelThreadRequired: undefined,
      restartRecoverySourceIngress: "control-ui",
      restartRecoverySourceReplyDeliveryMode: undefined,
      ...(params.admission.priorTerminalSourceRunId
        ? { restartRecoveryTerminalRunIds: [params.admission.priorTerminalSourceRunId] }
        : {}),
    },
  };
}

export async function terminalizeRestartSafeChatAdmission(
  params: RestartSafeChatTerminalState & {
    admittedSessionId: string;
    clientRunId: string;
    sessionKey: string;
    startedAt: number;
    storePath: string;
  },
): Promise<boolean> {
  const endedAt = Date.now();
  let terminalized = false;
  await patchSessionEntryCore(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (current) => {
      if (
        current.sessionId !== params.admittedSessionId ||
        current.restartRecoveryDeliveryRunId !== params.clientRunId
      ) {
        return null;
      }
      terminalized = true;
      // Commit the diagnostic with claim release; a later lifecycle write could
      // race the next admission before a newly mounted chat reads the failure.
      return {
        ...deriveGatewaySessionLifecycleSnapshot({
          event: {
            runId: params.clientRunId,
            ts: endedAt,
            data: {
              phase: params.status === "failed" ? "error" : "end",
              startedAt: params.startedAt,
              endedAt,
              aborted: params.status === "killed",
              error: params.error,
            },
          },
        }),
        abortedLastRun: params.retryable ? false : params.status === "killed",
        lifecycleRunId: undefined,
        lastRunId: params.clientRunId,
        ...(params.retryable
          ? {}
          : buildRestartRecoveryClaimCleanupPatch({
              entry: current,
              recordTerminalSource: true,
              terminalSourceRunId: current.restartRecoveryDeliverySourceRunId,
            })),
      };
    },
    { requireWriteSuccess: true, skipMaintenance: true },
  );
  return terminalized;
}
