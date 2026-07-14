import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { mapThinkingLevelForProvider } from "../../agents/embedded-agent-runner/utils.js";
import type {
  LocalTurnPlacementClaim,
  SessionPlacementAdmissionProvider,
  SessionPlacementTurnParams,
} from "../../agents/session-placement-admission.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { parseWorkerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";
import {
  assertSupportedTurn,
  assistantText,
  buildWorkerAgentMeta,
  fitLaunchDescriptor,
  parseRuntimeResult,
  windowInitialMessages,
} from "./worker-turn-payload.js";

const WORKER_LAUNCH_SCRIPT = 'exec node "$HOME/.openclaw-worker/$1/openclaw.mjs" worker';

type WorkerTurnEnvironmentService = Pick<
  WorkerEnvironmentService,
  | "acknowledgeCredentialDelivery"
  | "acquireTurnCredential"
  | "destroy"
  | "get"
  | "startTunnel"
  | "stopTunnel"
>;

type ActiveWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;
type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

type WorkerTurnLauncherOptions = {
  admitNewPlacements?: boolean;
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  redispatchReclaimed?: (placement: ReclaimedWorkerPlacement) => Promise<ActiveWorkerPlacement>;
};

class WorkerTurnExecutionError extends Error {}

function required(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`Worker turn ${field} is required`);
  }
  return normalized;
}

async function waitForTurnOperation<T>(params: {
  operation: Promise<T>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<T> {
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  const abortError = () =>
    signal.reason instanceof Error
      ? signal.reason
      : new Error("Cloud worker operation aborted", { cause: signal.reason });
  if (signal.aborted) {
    throw abortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    params.operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function resolvePlacementIdentity(
  claim: LocalTurnPlacementClaim,
  placement: WorkerSessionPlacementRecord | undefined,
) {
  return {
    sessionId: claim.sessionId,
    agentId: placement?.agentId ?? required(claim.agentId, "agent id"),
    sessionKey: placement?.sessionKey ?? required(claim.sessionKey, "session key"),
  };
}

function requireActivePlacement(placement: WorkerSessionPlacementRecord): ActiveWorkerPlacement {
  if (
    placement.state !== "active" ||
    !placement.remoteWorkspaceDir ||
    !placement.workerBundleHash
  ) {
    throw new Error(`Worker turn rejected in placement ${placement.state}`);
  }
  return placement;
}

function releaseClaimIfOwned(
  placements: WorkerSessionPlacementStore,
  turnClaim: WorkerSessionTurnClaim,
): void {
  if (placements.validateTurnClaim(turnClaim)) {
    placements.releaseTurn(turnClaim);
  }
}

async function executeLocalTurn<T>(params: {
  claim: LocalTurnPlacementClaim;
  placements: WorkerSessionPlacementStore;
  runLocal: () => Promise<T>;
}): Promise<T> {
  const current = params.placements.get(params.claim.sessionId);
  const turnClaim = params.placements.claimTurn({
    ...resolvePlacementIdentity(params.claim, current),
    claimId: randomUUID(),
    runId: params.claim.runId,
    owner: { kind: "local" },
  });
  try {
    return await params.runLocal();
  } finally {
    releaseClaimIfOwned(params.placements, turnClaim);
  }
}

function recoveryError(error: unknown): string {
  const message = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(message || "cloud worker turn failed", 1_024);
}

async function failHandedOffTurn(params: {
  environments: WorkerTurnEnvironmentService;
  placements: WorkerSessionPlacementStore;
  placement: ActiveWorkerPlacement;
  error: unknown;
}): Promise<void> {
  const primaryFailure = recoveryError(params.error);
  const failures = [primaryFailure];
  let draining: WorkerSessionPlacementRecord;
  try {
    draining = params.placements.startDrain({
      sessionId: params.placement.sessionId,
      environmentId: params.placement.environmentId,
      ownerEpoch: params.placement.activeOwnerEpoch,
      expectedGeneration: params.placement.generation,
    });
  } catch {
    // Exact drain ownership failed. Do not tear down an environment that may
    // now belong to a newer placement generation.
    return;
  }
  if (draining.state !== "draining") {
    return;
  }
  try {
    await params.environments.stopTunnel(
      params.placement.environmentId,
      params.placement.activeOwnerEpoch,
    );
  } catch (error) {
    failures.push(`tunnel stop: ${recoveryError(error)}`);
  }
  try {
    await params.environments.destroy(params.placement.environmentId);
  } catch (error) {
    failures.push(`environment destroy: ${recoveryError(error)}`);
  }
  try {
    // Both teardown calls returned through the environment queue. Fence stale
    // worker RPC durably now; failed teardown remains eligible for retry.
    const reconciling = params.placements.startReconcile({
      sessionId: draining.sessionId,
      environmentId: draining.environmentId,
      ownerEpoch: draining.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    if (reconciling.state !== "reconciling") {
      return;
    }
    params.placements.fail({
      sessionId: reconciling.sessionId,
      expectedGeneration: reconciling.generation,
      recoveryError: truncateUtf16Safe(failures.join("; "), 1_024),
    });
  } catch {
    // Leave the durable draining or reconciling row for startup reconciliation.
  }
}

async function executeWorkerTurn(params: {
  environments: WorkerTurnEnvironmentService;
  onHandoff: () => void;
  placement: ActiveWorkerPlacement;
  placements: WorkerSessionPlacementStore;
  turn: SessionPlacementTurnParams;
}) {
  const { placement, turn } = params;
  const modelRef = assertSupportedTurn(turn);
  const environment = params.environments.get(placement.environmentId);
  if (
    !environment ||
    environment.state !== "attached" ||
    environment.ownerEpoch !== placement.activeOwnerEpoch ||
    environment.bootstrapReceipt?.bundleHash !== placement.workerBundleHash ||
    environment.attachedSessionIds.length !== 1 ||
    environment.attachedSessionIds[0] !== placement.sessionId
  ) {
    throw new Error("Active worker placement does not match its attached environment");
  }

  const startedAt = Date.now();
  turn.onExecutionStarted?.({ lifecycleGeneration: turn.lifecycleGeneration });
  turn.onExecutionPhase?.({ phase: "runner_entered", backend: "cloud-worker" });
  const manager = SessionManager.open(turn.sessionFile);
  const userMessageAlreadyPersisted =
    turn.suppressNextUserMessagePersistence === true ||
    turn.userTurnTranscriptRecorder?.hasPersisted() === true;
  const contextMessages = convertToLlm(manager.buildSessionContext().messages);
  const leaf = manager.getLeafEntry();
  const initialMessages = windowInitialMessages(
    userMessageAlreadyPersisted && leaf?.type === "message" && leaf.message.role === "user"
      ? contextMessages.slice(0, -1)
      : contextMessages,
  );
  let baseLeafId = manager.getLeafId();
  if (!userMessageAlreadyPersisted) {
    const persisted = turn.userTurnTranscriptRecorder
      ? await turn.userTurnTranscriptRecorder.persistApproved({ cwd: turn.workspaceDir })
      : undefined;
    if (persisted) {
      baseLeafId = persisted.messageId;
      turn.userTurnTranscriptRecorder?.markRuntimePersisted(persisted.message);
      turn.onUserMessagePersisted?.(persisted.message);
    } else if (turn.userTurnTranscriptRecorder?.hasPersisted()) {
      baseLeafId = SessionManager.open(turn.sessionFile).getLeafId();
    } else if (!turn.userTurnTranscriptRecorder) {
      const message = {
        role: "user" as const,
        content: [{ type: "text" as const, text: turn.transcriptPrompt ?? turn.prompt }],
        timestamp: Date.now(),
      };
      baseLeafId = manager.appendMessage(message);
      turn.onUserMessagePersisted?.(message);
    } else {
      throw new Error("Cloud worker turn could not persist its canonical user message");
    }
  }
  turn.onExecutionPhase?.({
    phase: "model_resolution",
    backend: "cloud-worker",
    provider: modelRef.provider,
    model: modelRef.model,
  });

  const credential = await params.environments.acquireTurnCredential({
    environmentId: placement.environmentId,
    ownerEpoch: placement.activeOwnerEpoch,
    sessionId: placement.sessionId,
  });
  const tunnel = await waitForTurnOperation({
    operation: params.environments.startTunnel({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    }),
    ...(turn.abortSignal ? { signal: turn.abortSignal } : {}),
    timeoutMs: turn.timeoutMs,
  });
  const reasoning = mapThinkingLevelForProvider(turn.thinkLevel);
  const descriptor = fitLaunchDescriptor(
    (windowedMessages) =>
      parseWorkerLaunchDescriptor({
        version: 1,
        socketPath: tunnel.remoteSocketPath,
        admission: {
          environmentId: placement.environmentId,
          credential: credential.credential,
          sessionId: placement.sessionId,
          ownerEpoch: placement.activeOwnerEpoch,
          rpcSetVersion: credential.rpcSetVersion,
          handshake: environment.bootstrapReceipt,
        },
        assignment: {
          runId: turn.runId,
          turnId: randomUUID(),
          prompt: turn.prompt,
          suppressPromptTranscript: true,
          workspaceDir: placement.remoteWorkspaceDir,
          modelRef,
          inferenceOptions: reasoning ? { reasoning } : {},
          ...(turn.extraSystemPrompt === undefined ? {} : { systemPrompt: turn.extraSystemPrompt }),
          initialMessages: windowedMessages,
          transcript: {
            baseLeafId,
            nextSeq: (placement.lastTranscriptAckCursor ?? 0) + 1,
          },
          liveEvents: {
            ackedSeq: placement.lastLiveEventAckCursor ?? 0,
            nextSeq: (placement.lastLiveEventAckCursor ?? 0) + 1,
          },
        },
      }),
    initialMessages,
  );
  turn.userTurnTranscriptRecorder?.markSentToProvider?.();
  turn.onExecutionPhase?.({ phase: "attempt_dispatch", backend: "cloud-worker" });
  const handoffAbort = new AbortController();
  params.onHandoff();
  const processPromise = tunnel.runWorkspaceCommand({
    argv: ["sh", "-c", WORKER_LAUNCH_SCRIPT, "openclaw-worker", placement.workerBundleHash],
    input: JSON.stringify(descriptor),
    timeoutMs: turn.timeoutMs,
    signal: turn.abortSignal
      ? AbortSignal.any([turn.abortSignal, handoffAbort.signal])
      : handoffAbort.signal,
  });
  turn.onExecutionPhase?.({ phase: "process_spawned", backend: "cloud-worker" });
  let credentialDelivered: boolean;
  try {
    credentialDelivered = params.environments.acknowledgeCredentialDelivery(credential);
  } catch (error) {
    handoffAbort.abort();
    await processPromise.catch(() => undefined);
    throw new Error("Cloud worker credential handoff failed", { cause: error });
  }
  if (!credentialDelivered) {
    handoffAbort.abort();
    await processPromise.catch(() => undefined);
    throw new Error("Cloud worker credential owner changed during process handoff");
  }
  const processResult = await processPromise;
  if (processResult.code !== 0 || processResult.signal !== null || processResult.killed) {
    // Boxes are destroyed on failure, so the redacted stderr tail is the only forensics.
    const detail = redactSensitiveText(processResult.stderr, { mode: "tools" })
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 400);
    throw new Error(
      detail
        ? `Cloud worker process failed before completing the turn: ${detail}`
        : "Cloud worker process failed before completing the turn",
    );
  }
  const runtimeResult = parseRuntimeResult(processResult.stdout);
  if (runtimeResult.status === "fenced") {
    throw new Error(`Cloud worker turn was fenced: ${runtimeResult.reason}`);
  }
  if (runtimeResult.status === "failed") {
    throw new WorkerTurnExecutionError("Cloud worker turn failed");
  }

  const completed = SessionManager.open(turn.sessionFile);
  const currentPlacement = params.placements.get(placement.sessionId);
  if (
    runtimeResult.transcriptLeafId !== completed.getLeafId() ||
    runtimeResult.transcriptNextSeq !== (currentPlacement?.lastTranscriptAckCursor ?? 0) + 1
  ) {
    throw new Error("Cloud worker result does not match its committed transcript acknowledgement");
  }
  const terminal = runtimeResult.transcriptLeafId
    ? completed.getEntry(runtimeResult.transcriptLeafId)
    : undefined;
  if (!terminal || terminal.type !== "message" || terminal.message.role !== "assistant") {
    throw new Error("Cloud worker completed without a terminal assistant transcript message");
  }
  const text = assistantText(terminal.message);
  const baseIndex = completed.getBranch().findIndex((entry) => entry.id === baseLeafId);
  const workerMessages = completed
    .getBranch()
    .slice(baseIndex + 1)
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  return {
    ...(text ? { payloads: [{ text }] } : {}),
    meta: {
      durationMs: Date.now() - startedAt,
      agentMeta: {
        sessionId: placement.sessionId,
        sessionFile: turn.sessionFile,
        ...buildWorkerAgentMeta({ messages: workerMessages, modelRef }),
      },
      stopReason: terminal.message.stopReason,
    },
  };
}

export function createWorkerSessionTurnPlacementProvider(
  options: WorkerTurnLauncherOptions,
): SessionPlacementAdmissionProvider {
  return {
    async executeLocalTurn<T>(claim: LocalTurnPlacementClaim, runLocal: () => Promise<T>) {
      if (!options.placements.get(claim.sessionId) && options.admitNewPlacements === false) {
        return await runLocal();
      }
      return await executeLocalTurn({ claim, placements: options.placements, runLocal });
    },
    async executeTurn(claim, turn, runLocal) {
      const current = options.placements.get(claim.sessionId);
      if (
        !current &&
        (options.admitNewPlacements === false ||
          (turn.modelRun === true && !claim.sessionKey?.trim()))
      ) {
        return await runLocal();
      }
      if (!current || current.state === "local") {
        return await executeLocalTurn({ claim, placements: options.placements, runLocal });
      }
      let routablePlacement = current;
      if (routablePlacement.state === "reclaimed") {
        if (!options.redispatchReclaimed) {
          throw new Error("Reclaimed worker placement requires redispatch");
        }
        routablePlacement = await options.redispatchReclaimed(routablePlacement);
      }
      const identity = resolvePlacementIdentity(claim, routablePlacement);
      const placement = requireActivePlacement(routablePlacement);
      const turnClaim = options.placements.claimTurn({
        ...identity,
        claimId: randomUUID(),
        runId: claim.runId,
        owner: {
          kind: "worker",
          environmentId: placement.environmentId,
          ownerEpoch: placement.activeOwnerEpoch,
        },
      });
      let handedOff = false;
      try {
        const result = await executeWorkerTurn({
          environments: options.environments,
          onHandoff: () => {
            handedOff = true;
          },
          placement,
          placements: options.placements,
          turn,
        });
        if (!options.placements.validateTurnClaim(turnClaim)) {
          throw new Error("Cloud worker turn ownership changed before result reconciliation");
        }
        options.placements.releaseTurn(turnClaim);
        return result;
      } catch (error) {
        if (error instanceof WorkerTurnExecutionError) {
          if (options.placements.validateTurnClaim(turnClaim)) {
            options.placements.releaseTurn(turnClaim);
            throw error;
          }
        }
        if (handedOff) {
          await failHandedOffTurn({
            environments: options.environments,
            placements: options.placements,
            placement,
            error,
          });
        } else {
          releaseClaimIfOwned(options.placements, turnClaim);
        }
        throw error;
      }
    },
  };
}
