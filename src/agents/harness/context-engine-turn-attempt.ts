import {
  readClosedTranscriptTurn,
  resolveSessionTranscriptDatabasePath,
  type TranscriptTurnBoundary,
} from "../../config/sessions/session-accessor.js";
import { supportsContextEngineDurableTurnAdvancement } from "../../context-engine/host-compat.js";
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  acceptContextEngineTurnIntent,
  blockContextEngineTurnIntent,
  discardContextEngineTurnIntent,
  drainContextEngineTurnOutbox,
  enqueueContextEngineTurnCommit,
  enqueueContextEngineTurnIntent,
  isRetryableContextEngineTurnReadFailure,
  recoverContextEngineTurnOutbox,
} from "./context-engine-turn-outbox.js";

const ACCEPTED_TURN_MAX_EVENTS = 20_000;
const ACCEPTED_TURN_MAX_BYTES = 8 * 1024 * 1024;

export type ContextEngineTurnAttemptFacts = {
  boundary: TranscriptTurnBoundary;
  sessionIdUsed: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  promptError: boolean;
  aborted: boolean;
  yieldAborted: boolean;
  isHeartbeat?: boolean;
};

export async function drainPendingContextEngineTurnsBeforeRun(params: {
  admission: TranscriptTurnBoundary["admission"] | undefined;
  isHeartbeat?: boolean;
  lease: ContextEngineLogicalTurnLease;
  recorder?: UserTurnTranscriptRecorder;
  sessionTarget?: ContextEngineSessionTarget;
  warn?: (message: string) => void;
}): Promise<void> {
  if (
    (!params.admission && !params.recorder) ||
    params.lease.degraded ||
    !supportsContextEngineDurableTurnAdvancement(params.lease.engine)
  ) {
    return;
  }
  const warn = params.warn ?? console.warn;
  try {
    const target = params.admission ?? params.sessionTarget;
    if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
      params.lease.degradeBeforeStart(
        "durable transcript target is unavailable before context assembly",
      );
      return;
    }
    const databasePath = params.admission
      ? params.admission.storePath
      : resolveSessionTranscriptDatabasePath({
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        });
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId,
      path: databasePath,
    });
    recoverContextEngineTurnOutbox({
      database,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      sessionId: target.sessionId,
      warn,
    });
    const result = await drainContextEngineTurnOutbox({
      database,
      engine: params.lease.engine,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      sessionId: target.sessionId,
      warn,
    });
    if (result.pending) {
      params.lease.degradeBeforeStart(
        "pending durable turn advancement could not be completed before the next turn",
      );
      return;
    }
    const enqueueAdmission = (admission: TranscriptTurnBoundary["admission"]) => {
      if (
        admission.agentId !== target.agentId ||
        admission.sessionId !== target.sessionId ||
        admission.sessionKey !== target.sessionKey ||
        admission.storePath !== databasePath
      ) {
        throw new Error("context-engine transcript target changed before provider dispatch");
      }
      enqueueContextEngineTurnIntent({
        admission,
        database,
        engineId: params.lease.effectiveEngineId,
        isHeartbeat: params.isHeartbeat === true,
        ownerPluginId: params.lease.effectiveEnginePluginId,
      });
    };
    if (params.admission) {
      enqueueAdmission(params.admission);
      return;
    }
    if (!params.recorder?.setAdmissionHandler) {
      params.lease.degradeBeforeStart(
        "current-turn transcript admission cannot be recorded for durable advancement",
      );
      return;
    }
    params.recorder.setAdmissionHandler(enqueueAdmission);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`[context-engine] failed to retry pending turn advancement: ${message}`);
    params.lease.degradeBeforeStart(
      "pending durable turn advancement could not be checked before the next turn",
    );
  }
}

export function discardContextEngineTurnAttemptIntent(params: {
  facts: ContextEngineTurnAttemptFacts;
  lease: ContextEngineLogicalTurnLease;
  warn?: (message: string) => void;
}): void {
  const warn = params.warn ?? console.warn;
  try {
    const admission = params.facts.boundary.admission;
    discardContextEngineTurnIntent({
      admission,
      database: openOpenClawAgentDatabase({
        agentId: admission.agentId,
        path: admission.storePath,
      }),
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
    });
  } catch (error) {
    warn(
      `[context-engine] failed to discard unaccepted turn intent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertAcceptedTranscriptTarget(facts: ContextEngineTurnAttemptFacts): void {
  const { admission, terminal } = facts.boundary;
  if (
    facts.sessionIdUsed !== admission.sessionId ||
    terminal.agentId !== admission.agentId ||
    terminal.sessionId !== admission.sessionId ||
    terminal.sessionKey !== admission.sessionKey ||
    terminal.storePath !== admission.storePath ||
    (facts.sessionKey !== undefined && facts.sessionKey !== admission.sessionKey) ||
    (facts.sessionTarget?.agentId !== undefined &&
      facts.sessionTarget.agentId !== admission.agentId) ||
    (facts.sessionTarget?.sessionId !== undefined &&
      facts.sessionTarget.sessionId !== admission.sessionId) ||
    (facts.sessionTarget?.sessionKey !== undefined &&
      facts.sessionTarget.sessionKey !== admission.sessionKey)
  ) {
    throw new Error("accepted context-engine transcript target changed after admission");
  }
}

export async function finalizeAcceptedContextEngineTurn(params: {
  facts: ContextEngineTurnAttemptFacts;
  lease: ContextEngineLogicalTurnLease;
  warn?: (message: string) => void;
}): Promise<void> {
  const declaresDurableAdvancement =
    params.lease.engine.info.transcriptSemantics?.turnAdvancementIdempotency !== undefined;
  const implementsDurableAdvancement = supportsContextEngineDurableTurnAdvancement(
    params.lease.engine,
  );
  // Legacy leaves persistence to SessionManager and owns neither side of this contract.
  // Partial durable declarations remain invariant failures in the guarded path below.
  if (!declaresDurableAdvancement && !implementsDurableAdvancement) {
    return;
  }
  const warn = params.warn ?? console.warn;
  if (params.facts.promptError || params.facts.aborted || params.facts.yieldAborted) {
    discardContextEngineTurnAttemptIntent({ facts: params.facts, lease: params.lease, warn });
    return;
  }
  try {
    assertAcceptedTranscriptTarget(params.facts);
    if (params.lease.degraded || !declaresDurableAdvancement || !implementsDurableAdvancement) {
      throw new Error("accepted context engine does not support durable turn advancement");
    }
    const admission = params.facts.boundary.admission;
    const database = openOpenClawAgentDatabase({
      agentId: admission.agentId,
      path: admission.storePath,
    });
    acceptContextEngineTurnIntent({
      boundary: params.facts.boundary,
      database,
      engineId: params.lease.effectiveEngineId,
      isHeartbeat: params.facts.isHeartbeat === true,
      ownerPluginId: params.lease.effectiveEnginePluginId,
    });
    const closedTurn = readClosedTranscriptTurn({
      boundary: params.facts.boundary,
      maxEvents: ACCEPTED_TURN_MAX_EVENTS,
      maxBytes: ACCEPTED_TURN_MAX_BYTES,
    });
    if (closedTurn.kind !== "ok") {
      if (!isRetryableContextEngineTurnReadFailure(closedTurn.kind)) {
        blockContextEngineTurnIntent({
          boundary: params.facts.boundary,
          database,
          engineId: params.lease.effectiveEngineId,
          failure: closedTurn.kind,
          isHeartbeat: params.facts.isHeartbeat === true,
          ownerPluginId: params.lease.effectiveEnginePluginId,
        });
      }
      throw new Error(`accepted context-engine transcript range is ${closedTurn.kind}`);
    }
    enqueueContextEngineTurnCommit({
      database,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      payload: {
        boundary: params.facts.boundary,
        isHeartbeat: params.facts.isHeartbeat === true,
        messages: closedTurn.messages,
      },
    });
    await drainContextEngineTurnOutbox({
      database,
      engine: params.lease.engine,
      engineId: params.lease.effectiveEngineId,
      ownerPluginId: params.lease.effectiveEnginePluginId,
      warn,
    });
  } catch (error) {
    warn(
      `[context-engine] skipped accepted turn advancement: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
