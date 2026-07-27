import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
} from "../../agents/run-termination.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { registerChatAbortController } from "../chat-abort.js";
import { loadSessionEntry } from "../session-utils.js";
import type { AgentDedupeLifecycle } from "./agent-dedupe-lifecycle.js";
import {
  isAcceptedAgentDedupePayload,
  isPreRegistrationAbortedAgentDedupeEntryForSession,
  readGatewayDedupeEntry,
  setAbortedAgentDedupeEntries,
} from "./agent-dedupe.js";
import {
  assertExpectedExistingSession,
  consumeExpectedSessionWorkAdmission,
  type ExpectedExistingSessionConstraint,
} from "./agent-expected-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function createAgentAdmissionController(params: {
  cfg: OpenClawConfig;
  runId: string;
  lifecycleGeneration: string;
  agentDedupeKeys: string[];
  preAcceptedReservedSessionKey?: string;
  expectedSession?: ExpectedExistingSessionConstraint;
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  dedupeLifecycle: AgentDedupeLifecycle;
  getRequestedSessionKey: () => string | undefined;
  getResolvedSessionKey: () => string | undefined;
  getResolvedSessionId: () => string | undefined;
  getResolvedSessionAgentId: () => string | undefined;
  getAgentId: () => string | undefined;
  getCfgForAgent: () => OpenClawConfig | undefined;
  getSessionPersisted: () => boolean;
  getSupersededSessionId: () => string | undefined;
  setAdmittedSessionId: (sessionId: string) => void;
}) {
  let admission: SessionWorkAdmissionLease | undefined;
  let admittedRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
  let postAdmissionAbort: ReturnType<typeof readGatewayDedupeEntry>;
  let postAdmissionTimeout:
    | {
        runId: string;
        status: "timeout";
        summary: "aborted";
        stopReason: "timeout";
        timeoutPhase: "queue";
        providerStarted: false;
      }
    | undefined;
  let postAdmissionSuperseded = false;
  let lifecycleRotated = false;

  const admissionAgentId = () => {
    const resolvedSessionKey = params.getResolvedSessionKey();
    return (
      params.getResolvedSessionAgentId() ??
      (resolvedSessionKey === "global"
        ? (params.getAgentId() ?? resolveDefaultAgentId(params.getCfgForAgent() ?? params.cfg))
        : undefined)
    );
  };

  const assertAllowed = (commitOutcome = true) => {
    const resolvedSessionKey = params.getResolvedSessionKey();
    const requestedSessionKey = params.getRequestedSessionKey();
    const latest = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    if (
      isPreRegistrationAbortedAgentDedupeEntryForSession({
        entry: latest,
        runId: params.runId,
        sessionKey: resolvedSessionKey,
        alternateSessionKeys: [params.preAcceptedReservedSessionKey, requestedSessionKey],
      })
    ) {
      if (commitOutcome) {
        postAdmissionAbort = latest;
      }
      return;
    }
    if (params.dedupeLifecycle.isReserved()) {
      if (!latest) {
        if (commitOutcome) {
          postAdmissionTimeout = queueTimeout(params.runId);
          setAbortedAgentDedupeEntries({
            dedupe: params.context.dedupe,
            keys: params.agentDedupeKeys,
            agentId: admissionAgentId(),
            sessionKey: resolvedSessionKey,
            runId: params.runId,
            stopReason: "timeout",
            agentReplayCapability: params.dedupeLifecycle.replayCapability,
          });
        }
        return;
      }
      if (!latest.ok || !isAcceptedAgentDedupePayload(latest.payload)) {
        if (commitOutcome) {
          postAdmissionAbort = latest;
        }
        return;
      }
      if (latest.payload.reservationId !== params.dedupeLifecycle.reservationId) {
        if (commitOutcome) {
          postAdmissionSuperseded = true;
        }
        return;
      }
      if (!isFutureDateTimestampMs(latest.payload.expiresAtMs, { nowMs: Date.now() })) {
        if (commitOutcome) {
          postAdmissionTimeout = queueTimeout(params.runId);
          setAbortedAgentDedupeEntries({
            dedupe: params.context.dedupe,
            keys: params.agentDedupeKeys,
            agentId: admissionAgentId(),
            sessionKey: resolvedSessionKey,
            runId: params.runId,
            stopReason: "timeout",
            agentReplayCapability: params.dedupeLifecycle.replayCapability,
          });
        }
        return;
      }
    }
    if (params.lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
      if (commitOutcome) {
        lifecycleRotated = params.dedupeLifecycle.abortForLifecycleRotation({
          sessionKey: resolvedSessionKey,
          agentId: admissionAgentId(),
        });
      }
      return;
    }
    if (!resolvedSessionKey) {
      return;
    }
    const admissionAgent = admissionAgentId();
    let latestEntry = loadSessionEntry(resolvedSessionKey, {
      agentId: admissionAgent,
      clone: false,
    }).entry;
    if (!latestEntry && requestedSessionKey && requestedSessionKey !== resolvedSessionKey) {
      latestEntry = loadSessionEntry(requestedSessionKey, {
        agentId: admissionAgent,
        clone: false,
      }).entry;
    }
    assertExpectedExistingSession({
      constraint: params.expectedSession,
      entry: latestEntry,
      message: `Session "${resolvedSessionKey}" changed while starting expected work. Retry.`,
    });
    if (params.getSessionPersisted() && !latestEntry) {
      throw new Error(`Session "${resolvedSessionKey}" was deleted while starting work. Retry.`);
    }
    const archivedError = resolveSessionWorkStartError(resolvedSessionKey, latestEntry);
    if (archivedError) {
      throw new Error(archivedError);
    }
    if (
      commitOutcome &&
      latestEntry?.sessionId &&
      latestEntry.sessionId !== params.getSupersededSessionId()
    ) {
      params.setAdmittedSessionId(latestEntry.sessionId);
    }
  };

  const interrupt = () => {
    if (admittedRunAbort?.entry) {
      admittedRunAbort.entry.abortStopReason = AGENT_RUN_RESTART_ABORT_STOP_REASON;
    }
    if (admittedRunAbort) {
      admittedRunAbort.controller.abort(createAgentRunRestartAbortError());
      return;
    }
    const reservedEntry = readGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
    });
    if (
      reservedEntry?.ok &&
      isAcceptedAgentDedupePayload(reservedEntry.payload) &&
      reservedEntry.payload.reservationId === params.dedupeLifecycle.reservationId
    ) {
      setAbortedAgentDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        agentId: admissionAgentId(),
        sessionKey: params.getResolvedSessionKey(),
        runId: params.runId,
        stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
        agentReplayCapability: params.dedupeLifecycle.replayCapability,
      });
    }
  };

  const acquire = async (scope: string) => {
    if (admission) {
      return;
    }
    admission =
      consumeExpectedSessionWorkAdmission({
        constraint: params.expectedSession,
        scope,
        identities: [params.getResolvedSessionKey(), params.getResolvedSessionId()],
        onInterrupt: interrupt,
      }) ??
      (await beginSessionWorkAdmission({
        scope,
        identities: [params.getResolvedSessionKey(), params.getResolvedSessionId()],
        assertAllowed: () => assertAllowed(false),
        revalidateAllowed: assertAllowed,
        onInterrupt: interrupt,
      }));
  };

  const respondToOutcome = () => {
    if (postAdmissionAbort) {
      admission?.release();
      params.dedupeLifecycle.markAccepted(true);
      params.respond(postAdmissionAbort.ok, postAdmissionAbort.payload, postAdmissionAbort.error, {
        cached: true,
        runId: params.runId,
      });
      return true;
    }
    if (postAdmissionTimeout || postAdmissionSuperseded) {
      admission?.release();
      params.dedupeLifecycle.markAccepted(true);
      params.respond(
        true,
        postAdmissionTimeout ?? { runId: params.runId, status: "in_flight" as const },
        undefined,
        { cached: true, runId: params.runId },
      );
      return true;
    }
    if (lifecycleRotated) {
      admission?.release();
      return true;
    }
    return false;
  };

  return {
    admissionAgentId,
    assertAllowed,
    acquire,
    respondToOutcome,
    hasOutcome: () =>
      Boolean(
        postAdmissionAbort || postAdmissionTimeout || postAdmissionSuperseded || lifecycleRotated,
      ),
    getAdmission: () => admission,
    getAdmittedRunAbort: () => admittedRunAbort,
    setAdmittedRunAbort: (value: ReturnType<typeof registerChatAbortController>) => {
      admittedRunAbort = value;
    },
    release: () => admission?.release(),
  };
}

function queueTimeout(runId: string) {
  return {
    runId,
    status: "timeout" as const,
    summary: "aborted" as const,
    stopReason: "timeout" as const,
    timeoutPhase: "queue" as const,
    providerStarted: false as const,
  };
}
