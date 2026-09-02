import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  isEmbeddedAgentRunHandleActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunOwner,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createReplyOperation,
  isReplyRunEvidenceStale,
} from "../../auto-reply/reply/reply-run-registry.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getDiagnosticSessionActivitySnapshot } from "../../logging/diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import {
  logSessionStateChange,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../../logging/diagnostic.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { getWorkerTurnExecutionIdentityCapability } from "./placement-turn-claim-events.js";
import {
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  placements,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("cloud worker run ownership", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each([
    { cancellation: "user", firstToolDelayMs: 0 },
    { cancellation: "deadline", firstToolDelayMs: 0 },
    { cancellation: "deadline", firstToolDelayMs: 10 * 60_000 },
  ] as const)(
    "keeps a bounded remote tool alive until $cancellation cancellation after a $firstToolDelayMs ms tool-start delay",
    async ({ cancellation, firstToolDelayMs }) => {
      const turnStartedAtMs = Date.UTC(2026, 7, 29);
      vi.useFakeTimers({ toFake: ["Date"], now: turnStartedAtMs });
      seedActivePlacement();
      const launched = createDeferred();
      const finishLaunch = createDeferred();
      let workerSignal: AbortSignal | undefined;
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: () => attachedEnvironment(),
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: () => true,
        startTunnel: async () => ({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runWorkspaceCommand: vi.fn(),
          quiesceWorkspace: vi.fn(),
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          stop: vi.fn(),
          measureLaunchTurn,
          launchTurn: async (request) => {
            request.onDispatchReady?.();
            workerSignal = request.signal;
            launched.resolve();
            await Promise.race([
              finishLaunch.promise,
              new Promise<void>((resolve) => {
                request.signal?.addEventListener("abort", () => resolve(), { once: true });
              }),
            ]);
            throw new Error("worker turn cancelled");
          },
        }),
        stopTunnel: vi.fn(),
        destroy: vi.fn(async () => attachedEnvironment()),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const operation = createReplyOperation({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        resetTriggered: false,
      });
      operation.setPhase("running");
      const runId = "run-bounded-worker-tool";
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      const input = {
        ...turn(runId),
        timeoutMs: 30 * 60_000,
        replyOperation: operation,
        abortSignal: operation.abortSignal,
      };
      const attempt = provider
        .executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          input,
          vi.fn(),
        )
        .catch((error: unknown) => error);
      await launched.promise;
      const active = placements.get(SESSION_ID);
      if (!active) {
        throw new Error("expected active placement");
      }
      const turnClaim = projectWorkerSessionTurnClaim(active);
      if (!turnClaim) {
        throw new Error("expected admitted worker turn");
      }
      const turnCapability = getWorkerTurnExecutionIdentityCapability(placements, turnClaim);
      if (!turnCapability) {
        throw new Error("expected worker turn capability");
      }
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        turnClaim,
        credentialHash: "worker-test-credential-hash",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: ["worker-live-event-v1"],
        credentialExpiresAtMs: Date.now() + input.timeoutMs,
      };
      const receiver = createWorkerLiveEventReceiver({
        getConfig: () => ({ session: { store: sessionTarget.storePath } }),
        startupBindings: [
          { environmentId: ENVIRONMENT_ID, runEpoch: OWNER_EPOCH, sessionId: SESSION_ID },
        ],
        startupOwners: new Map([[ENVIRONMENT_ID, OWNER_EPOCH]]),
      });
      receiver.start();
      vi.useFakeTimers({
        toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
        now: turnStartedAtMs + firstToolDelayMs,
      });
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      logSessionStateChange({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        state: "processing",
      });
      startDiagnosticHeartbeat(
        { diagnostics: { enabled: true } },
        {
          recoverStuckSession: recoverStuckDiagnosticSession,
          sampleLiveness: () => null,
        },
      );
      try {
        expect(
          receiver.apply({
            identity,
            request: {
              runEpoch: OWNER_EPOCH,
              lastAckedSeq: 0,
              seq: 1,
              runId,
              event: {
                kind: "tool",
                payload: {
                  phase: "start",
                  name: "sessions_spawn",
                  toolCallId: "child-provision",
                  args: {},
                },
              },
            },
          }),
        ).toEqual({ ok: true, result: { ackedSeq: 1 } });
        await vi.advanceTimersByTimeAsync(20 * 60_000 + 1 - firstToolDelayMs);

        expect(operation.abortSignal.aborted).toBe(false);
        expect(isReplyRunEvidenceStale(operation)).toBe(false);
        expect(workerSignal?.aborted).toBe(false);
        expect(placements.validateTurnClaim(turnClaim)).toBe(true);
        expect(getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID })).toMatchObject({
          activeWorkKind: "tool_call",
          activeToolName: "sessions_spawn",
          hasActiveEmbeddedRun: true,
        });
        await expect(
          queueEmbeddedAgentMessageWithOutcomeAsync(SESSION_ID, "follow up"),
        ).resolves.toMatchObject({ queued: false, reason: "not_streaming" });
        if (cancellation === "user") {
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)?.abort()).toBe(true);
          expect(placements.validateTurnClaim(turnClaim)).toBe(true);
          await expect(turnCapability.run(async () => "late effect")).rejects.toThrow();
        } else {
          expect(
            receiver.apply({
              identity,
              request: {
                runEpoch: OWNER_EPOCH,
                lastAckedSeq: 1,
                seq: 2,
                runId,
                event: {
                  kind: "tool",
                  payload: {
                    phase: "update",
                    name: "sessions_spawn",
                    toolCallId: "child-provision",
                    partialResult: {},
                  },
                },
              },
            }),
          ).toEqual({ ok: true, result: { ackedSeq: 2 } });
          vi.setSystemTime(turnStartedAtMs + input.timeoutMs);
          expect(isReplyRunEvidenceStale(operation)).toBe(false);
          vi.setSystemTime(turnStartedAtMs + input.timeoutMs + 1);
          expect(isReplyRunEvidenceStale(operation)).toBe(true);
          await vi.advanceTimersByTimeAsync(60_000);
          expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
        }
        expect(workerSignal?.aborted).toBe(true);
        await attempt;
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(false);
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
        expect(
          getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID }).activeWorkKind,
        ).toBeUndefined();
        expect(environments.destroy).not.toHaveBeenCalled();
      } finally {
        stopDiagnosticHeartbeat();
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        finishLaunch.resolve();
        operation.abortByUser();
        await attempt;
        operation.complete();
        receiver.clear();
        vi.useRealTimers();
      }
    },
  );

  it.each(["replacement", "claim-loss", "shutdown"] as const)(
    "fences retained event recorders after %s, including a reused run ID",
    async (closure) => {
      const { captureWorkerTurnDiagnosticRecorder, createWorkerTurnRunOwner } =
        await import("./worker-turn-run-owner.js");
      seedActivePlacement();
      const runId = "reused-worker-run";
      const claimInput = {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId,
        owner: { kind: "worker" as const, environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
      };
      const firstClaim = placements.claimTurn({ ...claimInput, claimId: "first-claim" });
      const first = createWorkerTurnRunOwner({
        placements,
        claim: firstClaim,
        turn: turn(runId),
        sessionKey: SESSION_KEY,
      });
      const identity: WorkerConnectionIdentity = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        sessionId: SESSION_ID,
        runId,
        turnClaim: firstClaim,
        credentialHash: "test",
        bundleHash: "a".repeat(64),
        rpcSetVersion: 1,
        protocolFeatures: [],
        credentialExpiresAtMs: Date.now() + 60_000,
      };
      const record = captureWorkerTurnDiagnosticRecorder(identity);
      expect(record).toBeTypeOf("function");
      const event = {
        kind: "tool" as const,
        payload: {
          phase: "start" as const,
          name: "sessions_spawn",
          toolCallId: "stale-tool",
          args: {},
        },
      };
      let replacement: ReturnType<typeof createWorkerTurnRunOwner> | undefined;
      try {
        if (closure === "shutdown") {
          rotateAgentEventLifecycleGeneration();
          expect(resolveActiveEmbeddedRunOwner(SESSION_ID)).toBeUndefined();
          expect(first.signal.aborted).toBe(true);
        } else {
          placements.releaseTurn(firstClaim);
          if (closure === "replacement") {
            const nextClaim = placements.claimTurn({ ...claimInput, claimId: "replacement-claim" });
            replacement = createWorkerTurnRunOwner({
              placements,
              claim: nextClaim,
              turn: turn(runId),
              sessionKey: SESSION_KEY,
            });
            expect(captureWorkerTurnDiagnosticRecorder(identity)).toBeUndefined();
            const current = captureWorkerTurnDiagnosticRecorder({
              ...identity,
              turnClaim: nextClaim,
            });
            current?.({
              ...event,
              payload: { ...event.payload, toolCallId: "current-tool", name: "exec" },
            });
          }
        }
        record?.(event);
        const activity = getDiagnosticSessionActivitySnapshot({ sessionId: SESSION_ID });
        expect(activity.activeToolCallId).toBe(
          closure === "replacement" ? "current-tool" : undefined,
        );
        first.dispose();
        expect(isEmbeddedAgentRunHandleActive(SESSION_ID)).toBe(closure === "replacement");
      } finally {
        first.dispose();
        replacement?.dispose();
      }
    },
  );
});
