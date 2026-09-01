import { createDefaultDeps } from "../../../cli/deps.js";
import {
  appendTranscriptMessage,
  assignSessionOwner,
  captureSessionRecipientAuthority,
  deleteSessionEntryLifecycle,
  isSessionRecipientAuthorityCurrent,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { advanceSessionRecipientAuthorityInTransaction } from "../../../config/sessions/session-accessor.sqlite-recipient-authority.js";
import type { SessionRecipientAuthority } from "../../../config/sessions/session-recipient-authority-types.js";
import { removeSessionMember } from "../../../config/sessions/session-sharing-store.js";
import { deliverQueuedSessionDeliveryCore } from "../../../gateway/server-restart-sentinel-delivery.js";
import { resolveGenericCurrentConversationBinding } from "../../../infra/outbound/current-conversation-bindings.js";
import { drainPendingSessionDelivery } from "../../../infra/session-delivery-queue-recovery.js";
import {
  ackSessionDelivery,
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
} from "../../../infra/session-delivery-queue-storage.js";
import { peekSystemEventEntries, removeSystemEvents } from "../../../infra/system-events.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.message.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../../state/openclaw-agent-db.js";
import {
  resolveFinalSystemEventAdoption,
  settleManagedSystemEventsAfterTurnAdoption,
} from "../../reply/session-system-event-adoption.js";
import { prepareFormattedSystemEvents } from "../../reply/session-system-events.js";
import { delegateFlowRecords } from "../delegate-flow-store.js";
import { cancelPendingDelegates } from "../delegate-store.js";
import {
  acceptPostCompactionReturnCovenantCase,
  enqueueHeldReturnCovenantDelivery,
  returnCovenantAuthorityFromDelegate,
} from "./case-dispatch.js";
import {
  materializeReturnCovenantRecipient,
  returnCovenantCaseScope,
  returnCovenantConversation,
} from "./case-setup.js";
import {
  returnCovenantCurrentSessionId,
  returnCovenantObservedEffects,
  returnCovenantOwnerA,
  returnCovenantOwnerB,
  returnCovenantReceiptId,
  type ReturnCovenantCaseState,
  type ReturnCovenantFixtureContext,
  type ReturnCovenantLifecycleReceipt,
  type ReturnCovenantReleaseReceipt,
} from "./case-state.js";
import type { ReturnCovenantGatewayRestart } from "./gateway-generation.js";
import type { ReturnCovenantDriverAttestation, ReturnCovenantPhaseRequest } from "./protocol.js";
import {
  assertReturnCovenantPromptMarker,
  inspectReturnCovenantDurableMarkers,
} from "./result-marker.js";

function stateDirectory(context: ReturnCovenantFixtureContext): string {
  const stateDir = context.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("return-covenant fixture lost its isolated state directory");
  }
  return stateDir;
}

function currentAuthority(
  state: ReturnCovenantCaseState,
  context: ReturnCovenantFixtureContext,
): SessionRecipientAuthority {
  return captureSessionRecipientAuthority(returnCovenantCaseScope(state, context));
}

function restartReceipt(params: {
  attestation: ReturnCovenantDriverAttestation;
  context: ReturnCovenantFixtureContext;
  lineage: ReturnCovenantGatewayRestart;
}): NonNullable<ReturnCovenantLifecycleReceipt["restart"]> {
  const { attestation, context, lineage } = params;
  return {
    stoppedAfterAcceptance: true,
    restartedBeforeRelease: true,
    replayRecovered: true,
    receiptId: returnCovenantReceiptId("gateway-restart", lineage),
    originalGatewayPid: lineage.original.pid,
    originalGatewayStartFingerprint: lineage.original.startFingerprint,
    replacementGatewayPid: lineage.replacement.pid,
    replacementGatewayStartFingerprint: lineage.replacement.startFingerprint,
    gatewayCommandSha256: context.plan.driver.gatewayCommand.sha256,
    runtimeConfigSha256: context.plan.target.runtimeConfigSha256,
    processGroupId: attestation.isolation.processGroupId,
    replacementGatewayEndpoint: lineage.replacement.endpoint,
  };
}

export async function transitionReturnCovenantCase(params: {
  attestation: ReturnCovenantDriverAttestation;
  context: ReturnCovenantFixtureContext;
  request: Extract<ReturnCovenantPhaseRequest, { phase: "transition" }>;
  restart?: ReturnCovenantGatewayRestart;
  state: ReturnCovenantCaseState;
}): Promise<Record<string, unknown>> {
  const { attestation, context, request, restart: restartLineage, state } = params;
  let restart: ReturnCovenantLifecycleReceipt["restart"];
  let operations: ReturnCovenantLifecycleReceipt["operations"];
  const sessionKey = state.casePlan.logicalSessionKey;
  switch (state.casePlan.id) {
    case "allowed-ordinary-new":
    case "allowed-ordinary-reset":
      await resetSessionEntryLifecycle({
        agentId: "proof",
        storePath: context.profiles.canonicalDatabasePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        resetBoundary: {
          context: "clear",
          reason: state.casePlan.id === "allowed-ordinary-new" ? "new" : "reset",
        },
        buildNextEntry: ({ currentEntry }) => ({
          ...currentEntry,
          sessionId: state.postSessionId,
          updatedAt: context.clock.wallNow(),
          lifecycleRevision: returnCovenantReceiptId("lifecycle", state.caseHandle),
        }),
      });
      break;
    case "allowed-provider-fallback":
      await patchSessionEntryCore(returnCovenantCaseScope(state, context), () => ({
        modelProvider: "openai",
        model: "gpt-5.6-luna",
      }));
      break;
    case "allowed-compaction":
      await patchSessionEntryCore(returnCovenantCaseScope(state, context), (entry) => ({
        compactionCount: (entry.compactionCount ?? 0) + 1,
      }));
      await acceptPostCompactionReturnCovenantCase({ context, state });
      break;
    case "allowed-gateway-restart-replay": {
      if (!restartLineage) {
        throw new Error("gateway restart transition is missing its replacement lineage");
      }
      const queueStillHeld =
        state.deliveryId &&
        (await loadPendingSessionDelivery(state.deliveryId, stateDirectory(context)));
      if (!queueStillHeld || !delegateFlowRecords.get(state.delegate?.flowId ?? "")) {
        throw new Error("gateway restart did not preserve accepted delegate state");
      }
      restart = restartReceipt({ attestation, context, lineage: restartLineage });
      break;
    }
    case "allowed-session-id-rollover":
      await upsertSessionEntryCore(returnCovenantCaseScope(state, context), {
        sessionId: state.postSessionId,
        previousSessionId: state.preSessionId ?? undefined,
        updatedAt: context.clock.wallNow(),
        lifecycleRevision: returnCovenantReceiptId("rollover", state.caseHandle),
      });
      break;
    case "allowed-late-materialization":
      await materializeReturnCovenantRecipient({
        context,
        sessionId: state.postSessionId,
        state,
      });
      break;
    case "forbidden-delete-recreate": {
      const deleted = await deleteSessionEntryLifecycle({
        agentId: "proof",
        archiveTranscript: false,
        storePath: context.profiles.canonicalDatabasePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      if (!deleted.deleted) {
        throw new Error("return-covenant delete transition did not delete the recipient");
      }
      await materializeReturnCovenantRecipient({
        context,
        sessionId: state.postSessionId,
        state,
      });
      operations = {
        deletionObserved: true,
        deletionReceiptId: returnCovenantReceiptId("delete", state.caseHandle),
        recreationObserved: true,
        recreationReceiptId: returnCovenantReceiptId("recreate", state.caseHandle),
      };
      break;
    }
    case "forbidden-owner-reassignment":
      if (
        !assignSessionOwner(returnCovenantCaseScope(state, context), {
          owner: returnCovenantOwnerB,
          assignedBy: returnCovenantOwnerA,
          assignedAt: context.clock.wallNow(),
        })
      ) {
        throw new Error("return-covenant owner reassignment did not commit");
      }
      break;
    case "forbidden-member-access-removal":
      if (!removeSessionMember(returnCovenantCaseScope(state, context), "return-covenant-member")) {
        throw new Error("return-covenant member removal did not commit");
      }
      break;
    case "forbidden-restrictive-visibility":
      await patchSessionEntryCore(
        returnCovenantCaseScope(state, context),
        () => ({ visibility: "draft" }),
        {
          afterPersistInTransaction: (database) =>
            advanceSessionRecipientAuthorityInTransaction(database, sessionKey),
        },
      );
      break;
    case "forbidden-explicit-revocation":
      runOpenClawAgentWriteTransaction(
        (database) => advanceSessionRecipientAuthorityInTransaction(database, sessionKey),
        {
          agentId: "proof",
          env: context.env,
          path: context.profiles.canonicalDatabasePath,
        },
        { operationLabel: "return-covenant.explicit-revocation" },
      );
      break;
  }

  if (state.casePlan.returnMode === "post-compaction" && !state.deliveryId) {
    const delegate = state.delegate;
    if (!delegate) {
      throw new Error("post-compaction transition lost its accepted delegate");
    }
    await enqueueHeldReturnCovenantDelivery({ context, state });
    returnCovenantAuthorityFromDelegate(delegate, sessionKey);
  }
  const captured = {
    state: "bound" as const,
    epoch: request.capturedAuthorityGeneration,
  };
  const authorityUnchanged = isSessionRecipientAuthorityCurrent(
    returnCovenantCaseScope(state, context),
    captured,
  );
  if (authorityUnchanged !== (state.casePlan.kind === "allowed")) {
    throw new Error("recipient authority relation disagrees with the lifecycle transition");
  }
  const current = currentAuthority(state, context);
  const currentEntry = loadSessionEntry(returnCovenantCaseScope(state, context));
  if (!currentEntry?.sessionId) {
    throw new Error("lifecycle transition did not leave a materialized recipient");
  }
  const lifecycle: ReturnCovenantLifecycleReceipt = {
    edge: state.casePlan.lifecycleEdge,
    occurredAfterAcceptance: true,
    completedBeforeRelease: true,
    preSessionId: state.preSessionId,
    postSessionId: currentEntry.sessionId,
    successorIdentity: `${currentEntry.sessionId}:${current.epoch}`,
    receiptId: returnCovenantReceiptId("transition", {
      caseHandle: state.caseHandle,
      current: current.epoch,
      gateway: state.gatewayPhases.transition,
    }),
    acceptedDispatchReceiptId: request.acceptedDispatchReceiptId,
    generationAdvanced: !authorityUnchanged,
    effectiveAuthorityUnchanged: authorityUnchanged,
    ...(operations ? { operations } : {}),
    ...(restart ? { restart } : {}),
  };
  state.lifecycle = lifecycle;
  return {
    caseHandle: state.caseHandle,
    lifecycleOccurred: true,
    receiptId: lifecycle.receiptId,
    acceptedDispatchReceiptId: lifecycle.acceptedDispatchReceiptId,
    capturedAuthorityGeneration: request.capturedAuthorityGeneration,
    ...(operations ? { operations } : {}),
    ...(restart
      ? {
          restartReceiptId: restart.receiptId,
          restart,
        }
      : {}),
  };
}

export async function releaseReturnCovenantCase(params: {
  context: ReturnCovenantFixtureContext;
  request: Extract<ReturnCovenantPhaseRequest, { phase: "release" }>;
  state: ReturnCovenantCaseState;
}): Promise<ReturnCovenantReleaseReceipt> {
  const { context, request, state } = params;
  if (!state.deliveryId) {
    throw new Error("release lost its held delivery");
  }
  const release: ReturnCovenantReleaseReceipt = {
    caseHandle: state.caseHandle,
    released: true,
    receiptId: returnCovenantReceiptId("release", {
      caseHandle: state.caseHandle,
      gateway: state.gatewayPhases.release,
    }),
    transitionReceiptId: request.transitionReceiptId,
    acceptedDispatchReceiptId: request.acceptedDispatchReceiptId,
    heldResultId: request.heldResultId,
    resultMarker: request.resultMarker,
    capturedAuthorityGeneration: request.capturedAuthorityGeneration,
  };
  state.release = release;
  state.releasedAtWall = context.clock.wallNow();
  state.releasedAtMonotonic = context.clock.monotonicNow();
  const keepSilentEvent =
    state.casePlan.kind === "allowed" && state.casePlan.returnMode === "silent";
  if (!keepSilentEvent) {
    // Keep the durable hold while this phase performs the sole bypass drain.
    // Publishing it as due would let Gateway recovery redrive before adoption.
    await drainPendingSessionDelivery({
      id: state.deliveryId,
      logLabel: "Return-covenant held delivery",
      stateDir: stateDirectory(context),
      bypassBackoff: true,
      log: {
        info() {},
        warn() {},
        error() {},
      },
      deliver: (entry, deliveryContext = {}) =>
        deliverQueuedSessionDeliveryCore({
          deps: createDefaultDeps(),
          entry,
          ...(deliveryContext.stateDir ? { stateDir: deliveryContext.stateDir } : {}),
        }),
    });
  }
  return release;
}

export async function observeReturnCovenantCase(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<Record<string, unknown>> {
  const { context, state } = params;
  const prepared = await prepareFormattedSystemEvents({
    cfg: context.config,
    agentId: "proof",
    sessionKey: state.casePlan.logicalSessionKey,
    isMainSession: false,
    isNewSession: false,
  });
  let adoption = resolveFinalSystemEventAdoption({ prepared: [prepared] });
  while (adoption.kind === "settle-stale") {
    await adoption.settle();
    adoption = resolveFinalSystemEventAdoption({ prepared: [prepared] });
  }
  const deliveryIds = [...adoption.managedDeliveries.keys()];
  const promptText = adoption.blocks.map((block) => block.text).join("\n");
  const allowed = state.casePlan.kind === "allowed";
  assertReturnCovenantPromptMarker({
    allowed,
    marker: state.resultMarker,
    promptText,
  });
  if (allowed) {
    const message = buildPersistedUserTurnMessage({
      text: promptText,
      timestamp: context.clock.wallNow(),
      sessionDeliveryAckIds: deliveryIds,
    });
    await appendTranscriptMessage(
      {
        ...returnCovenantCaseScope(state, context),
        sessionId: returnCovenantCurrentSessionId(state),
      },
      { message },
    );
    await settleManagedSystemEventsAfterTurnAdoption({
      deliveries: adoption.managedDeliveries.values(),
      persistedMessage: message,
    });
  }
  if (state.deliveryId) {
    const pending = await loadPendingSessionDelivery(state.deliveryId, stateDirectory(context));
    if (pending) {
      await ackSessionDelivery(pending.id, stateDirectory(context));
    }
  }
  const channelDeliveries =
    allowed &&
    state.casePlan.returnMode === "normal" &&
    resolveGenericCurrentConversationBinding(returnCovenantConversation(state, context))
      ?.targetSessionKey === state.casePlan.logicalSessionKey
      ? 1
      : 0;

  // Reopen the physical owner before scanning so this receipt covers durable
  // transcript recovery rather than the writer's in-process projection.
  closeOpenClawAgentDatabasesForTest();
  const transcript = await loadTranscriptEvents({
    ...returnCovenantCaseScope(state, context),
    sessionId: returnCovenantCurrentSessionId(state),
  });
  const systemEvents = peekSystemEventEntries(state.casePlan.logicalSessionKey);
  const markerObservation = inspectReturnCovenantDurableMarkers({
    allowed,
    marker: state.resultMarker,
    systemEvents,
    transcript,
  });
  const current = currentAuthority(state, context);
  const captured = state.acceptance?.capturedAuthorityGeneration;
  const admission = allowed
    ? "adopted"
    : state.casePlan.id === "forbidden-delete-recreate"
      ? "stale"
      : state.casePlan.id === "forbidden-explicit-revocation"
        ? "revoked"
        : "unauthorized";
  const observedAtWall = context.clock.wallNow();
  const observedAtMonotonic = context.clock.monotonicNow();
  const elapsedMonotonic = observedAtMonotonic - (state.releasedAtMonotonic ?? 0);
  const elapsedWall = observedAtWall - (state.releasedAtWall ?? observedAtWall);
  return {
    schema: "openclaw.k6.return-covenant-observation.v1",
    rowId: context.plan.rowId,
    runId: context.plan.runId,
    caseId: state.casePlan.id,
    form: state.form,
    kind: state.casePlan.kind,
    candidateSha: context.plan.target.candidateSha,
    runtimeBuildSha: context.plan.target.runtimeBuildSha,
    docsHarnessSha: context.plan.target.docsHarnessSha,
    runtimeConfigSha256: context.plan.target.runtimeConfigSha256,
    runtimeArtifactManifestSha256: context.plan.target.runtimeArtifactManifestSha256,
    startedAt: state.startedAt,
    endedAt: new Date(observedAtWall).toISOString(),
    returnMode: state.casePlan.returnMode,
    logicalSessionKey: state.casePlan.logicalSessionKey,
    caseHandle: state.caseHandle,
    database: state.database,
    isolation: { home: true, state: true, config: true, syntheticData: true },
    dispatch: state.acceptance,
    lifecycle: state.lifecycle,
    authorityDiagnostic: {
      source: "product-owned",
      surface: "test-runtime/return-covenant/recipient-authority",
      capturedAuthorityGeneration: captured,
      currentAuthorityGeneration: current.epoch,
    },
    delivery: {
      acceptedDispatchReceiptId: state.acceptance?.receiptId,
      heldResultAuthorityGeneration: captured,
      caseHandle: state.caseHandle,
      transitionReceiptId: state.lifecycle?.receiptId,
      releaseReceiptId: state.release?.receiptId,
      resultReleased: true,
      admission,
      queue: {
        recordId: state.deliveryId,
        status: allowed ? "adopted" : `${admission}-acknowledged`,
        acknowledged: true,
        removed: true,
        retryScheduled: false,
      },
    },
    effects: {
      distinguishable: true,
      sources: {
        promptAdoptions: "product-observer/prompt-adoption",
        wakes: "product-observer/heartbeat-wake",
        channelDeliveries: "product-observer/channel-delivery",
      },
      expected: state.request.expectedEffects,
      observed: returnCovenantObservedEffects(
        state,
        markerObservation.promptAdoptions,
        channelDeliveries,
      ),
    },
    settlement: {
      bounded: true,
      complete: true,
      windowMs: state.request.settlementWindowMs,
      releasedAt: new Date(state.releasedAtWall!).toISOString(),
      scansCompletedAt: new Date(observedAtWall).toISOString(),
      elapsedMs: elapsedWall,
      monotonicElapsedMs: elapsedMonotonic,
    },
    scans: {
      resultMarker: state.resultMarker,
      successorTranscript: {
        source: "product-owned",
        marker: state.resultMarker,
        matches: markerObservation.successorTranscriptResidualMatches,
        receiptId: returnCovenantReceiptId("transcript-scan", {
          caseHandle: state.caseHandle,
          gateway: state.gatewayPhases.observe,
          promptAdoptions: markerObservation.promptAdoptions,
        }),
      },
      trustedSystemEvents: {
        source: "product-owned",
        marker: state.resultMarker,
        matches: markerObservation.trustedSystemEventResidualMatches,
        receiptId: returnCovenantReceiptId("system-event-scan", {
          caseHandle: state.caseHandle,
          gateway: state.gatewayPhases.observe,
          promptAdoptions: markerObservation.promptAdoptions,
        }),
      },
    },
    resultMarker: state.resultMarker,
  };
}

export async function cleanupReturnCovenantCase(params: {
  context: ReturnCovenantFixtureContext;
  state: ReturnCovenantCaseState;
}): Promise<void> {
  const { context, state } = params;
  removeSystemEvents(state.casePlan.logicalSessionKey, () => true);
  if (state.deliveryId) {
    const pending = await loadPendingSessionDelivery(state.deliveryId, stateDirectory(context));
    if (pending) {
      await ackSessionDelivery(pending.id, stateDirectory(context));
    }
  }
  cancelPendingDelegates(state.casePlan.logicalSessionKey);
  if (state.childSessionKey) {
    await deleteSessionEntryLifecycle({
      agentId: "proof",
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      storePath: context.profiles.canonicalDatabasePath,
      target: {
        canonicalKey: state.childSessionKey,
        storeKeys: [state.childSessionKey],
      },
    });
  }
  if (state.casePlan.id === "allowed-late-materialization") {
    await deleteSessionEntryLifecycle({
      agentId: "proof",
      archiveTranscript: false,
      storePath: context.profiles.canonicalDatabasePath,
      target: {
        canonicalKey: state.casePlan.logicalSessionKey,
        storeKeys: [state.casePlan.logicalSessionKey],
      },
    });
  } else {
    // Each form is an independent accepted dispatch. Rotate only after its
    // observation and cleanup so the sibling form cannot reuse proof authority.
    runOpenClawAgentWriteTransaction(
      (database) =>
        advanceSessionRecipientAuthorityInTransaction(database, state.casePlan.logicalSessionKey),
      {
        agentId: "proof",
        env: context.env,
        path: context.profiles.canonicalDatabasePath,
      },
      { operationLabel: "return-covenant.case-isolation" },
    );
  }
}

export async function retainedReturnCovenantResources(params: {
  context: ReturnCovenantFixtureContext;
}): Promise<{
  delegates: number;
  queueItems: number;
  temporarySessions: number;
}> {
  const { context } = params;
  const runSessionPrefix = `agent:proof:${context.plan.runId}:`;
  const delegates = delegateFlowRecords
    .listAll()
    .filter(
      (flow) =>
        flow.ownerKey.startsWith(runSessionPrefix) &&
        (flow.status === "queued" || flow.status === "running"),
    ).length;
  const queueItems = (await loadPendingSessionDeliveries(stateDirectory(context))).length;
  const temporarySessions = context.profiles.countTemporarySessions(runSessionPrefix);
  return { delegates, queueItems, temporarySessions };
}
