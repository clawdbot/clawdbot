import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkerLiveEventParamsSchema,
  type WorkerLiveEventParams,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  buildAgentRunTerminalReplySnapshot,
  type AgentRunTerminalReplySnapshot,
} from "../../agents/agent-run-terminal-reply.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent-runner/run.js";
import { resolveModelFallbackError } from "../../agents/failover-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import type { SpawnResult } from "../../process/exec.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { NodeWorkerWorkspaceTransferError } from "../../worker/node-workspace-transfer-protocol.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentService } from "./service.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { WorkerTurnExecutionError } from "./worker-turn-failure.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionFile,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";
import { WorkerWorkspaceReconciliationError } from "./workspace-result-finalize.js";

describe("worker finishing admission", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("revalidates a credential replaced during synchronous live publication before terminal ACK", async () => {
    const { apply, liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-live-reentrant-credential",
      "session-live-reentrant-credential",
      { liveEvents },
    );
    apply.mockImplementationOnce(() => {
      support.testState.store.renewCredential({
        environmentId: identity.environmentId,
        expectedOwnerEpoch: identity.ownerEpoch,
        sessionId: identity.sessionId,
        rpcSetVersion: identity.rpcSetVersion,
        expiresAtMs: identity.credentialExpiresAtMs,
        credentialHash: hashWorkerCredential("replacement-credential", identity.turnClaim!),
      });
      return { ok: true, result: { ackedSeq: 1 } };
    });
    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity)),
    ).resolves.toEqual({ ok: false, closeReason: "credential-replaced" });
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
  });
});

describe("worker turn launcher terminal results", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each<{
    stopReason: "stop" | "error";
    reconciliationFails: boolean;
    cleanupFailure?: string;
    providerFailure?: true;
  }>([
    { stopReason: "stop", reconciliationFails: false },
    { stopReason: "error", reconciliationFails: false },
    { stopReason: "stop", reconciliationFails: true },
    { stopReason: "error", reconciliationFails: true },
    { stopReason: "error", reconciliationFails: false, providerFailure: true },
    ...[
      "Browser cleanup timed out",
      "Browser cleanup failed: rate limit exceeded",
      "Browser disposal failed",
    ].map((cleanupFailure) => ({
      stopReason: "stop" as const,
      reconciliationFails: false,
      cleanupFailure,
    })),
  ])(
    "retains the ACKed finishing outcome after assistant $stopReason (reconciliation fails: $reconciliationFails; cleanup: $cleanupFailure; provider fallback: $providerFailure)",
    async ({ stopReason, reconciliationFails, cleanupFailure, providerFailure }) => {
      const outerFallback = cleanupFailure !== undefined || providerFailure === true;
      seedActivePlacement();
      const grant = credential();
      const environment = attachedEnvironment();
      const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      const gate = createWorkerSessionPlacementGate(placements);
      const getConfig = () => ({ session: { store: sessionTarget.storePath } });
      const liveEvents = createWorkerLiveEventReceiver({
        getConfig,
        startupBindings: [
          { environmentId: ENVIRONMENT_ID, runEpoch: OWNER_EPOCH, sessionId: SESSION_ID },
        ],
        startupOwners: new Map([[ENVIRONMENT_ID, OWNER_EPOCH]]),
      });
      const service = createWorkerEnvironmentService({
        store: {
          ...createWorkerEnvironmentStore({ database }),
          get: () => environment,
          getCredential: () => ({
            environmentId: ENVIRONMENT_ID,
            credentialHash: grant.deliveryId,
            bundleHash: grant.bundleHash,
            sessionId: SESSION_ID,
            rpcSetVersion: grant.rpcSetVersion,
            ownerEpoch: OWNER_EPOCH,
            expiresAtMs: grant.expiresAtMs,
            deliveredAtMs: Date.now(),
          }),
        },
        getConfig,
        resolveProvider: () => undefined,
        prepareInstallation: vi.fn(),
        bootstrapWorker: vi.fn(),
        executeInference: vi.fn(),
        inferenceStore: createWorkerInferenceStore({ database }),
        placementStore: gate,
        liveEvents,
      });
      const failure =
        cleanupFailure ??
        (providerFailure
          ? "provider rate limit exceeded"
          : "turn failed | provider failed | computer cleanup failed | native close failed");
      const effectFile = path.join(root, "worker-effects.txt");
      const launchedModels: string[] = [];
      const reconciliationError = new NodeWorkerWorkspaceTransferError("workspace transfer failed");
      const runId = "run-finishing-cleanup";
      // Real dispatch supplies the session-bound outer context before worker admission.
      const dispatchClaim = claimAgentRunContext(
        runId,
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
        { ownsContext: true, trackOwner: true },
      );
      if (!dispatchClaim) {
        throw new Error("expected dispatch run context");
      }
      const workerTurn = turn(runId);
      let identity: WorkerConnectionIdentity;
      const tunnel = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        measureLaunchTurn,
        launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
          request.onDispatchReady?.();
          launchedModels.push(request.plan.assignment.modelRef.model);
          if (!providerFailure) {
            await fs.appendFile(effectFile, "effect\n");
          }
          if (launchedModels.length > 1) {
            // The second launch is the assertion boundary; do not replay its live-event stream.
            throw new WorkerTurnExecutionError("Unexpected second worker execution");
          }
          const leafId = openSessionManager().appendMessage(
            makeAgentAssistantMessage({
              content: providerFailure ? [] : [{ type: "text", text: "Remote answer" }],
              stopReason,
              ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
              timestamp: 21,
            }),
          );
          gate.updateAckCursors({ claim: request.turnClaim, transcriptSeq: 2 });
          identity = {
            environmentId: ENVIRONMENT_ID,
            credentialHash: grant.deliveryId,
            bundleHash: grant.bundleHash,
            sessionId: SESSION_ID,
            runId,
            turnClaim: request.turnClaim,
            ownerEpoch: OWNER_EPOCH,
            rpcSetVersion: grant.rpcSetVersion,
            protocolFeatures: environment.bootstrapReceipt!.protocolFeatures,
            credentialExpiresAtMs: grant.expiresAtMs,
          };
          const finishing = {
            runEpoch: OWNER_EPOCH,
            lastAckedSeq: 0,
            seq: 2,
            runId,
            event: {
              kind: "lifecycle" as const,
              payload: {
                phase: "finishing" as const,
                endedAt: 2,
                stopReason: "error" as const,
                error: failure,
                ...(cleanupFailure ? { replayInvalid: true as const } : {}),
              },
            },
          } satisfies WorkerLiveEventParams;
          expect(Value.Check(WorkerLiveEventParamsSchema, finishing)).toBe(true);
          await expect(service.pushLiveEvent(identity, finishing)).resolves.toEqual({
            ok: true,
            result: { ackedSeq: 0 },
          });
          expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
          await expect(
            service.pushLiveEvent(identity, {
              ...finishing,
              event: {
                ...finishing.event,
                payload: {
                  ...finishing.event.payload,
                  error: "duplicate must not replace original",
                  replayInvalid: undefined,
                },
              },
            }),
          ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
          await expect(
            service.pushLiveEvent(identity, {
              ...finishing,
              seq: 1,
              event: { kind: "lifecycle", payload: { phase: "start", startedAt: 1 } },
            }),
          ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
          expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
          return {
            stdout: JSON.stringify({
              status: "failed",
              reason: "turn-failed",
              transcriptLeafId: leafId,
              transcriptNextSeq: 3,
            }),
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          };
        }),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(async (request) => {
          if (reconciliationFails) {
            throw reconciliationError;
          }
          request.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
          };
        }),
        stop: vi.fn(async () => {}),
      } satisfies WorkerTunnelHandle;
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async (claim) => {
          grant.turnClaim = claim;
          grant.deliveryId = hashWorkerCredential(grant.credential, claim);
          return grant;
        }),
        acknowledgeCredentialDelivery: vi.fn(() => true),
        startTunnel: vi.fn(async () => tunnel),
        destroy: vi.fn(async () => environment),
      };
      const reconcileActivePlacement = vi.fn(async () => {
        const [pending] = placements.listPendingWorkspaceResults();
        if (!pending) {
          throw new Error("expected pending workspace result");
        }
        expect(pending).toMatchObject({ sessionId: SESSION_ID, runId });
        placements.failWorkspaceResultAndReleaseTurn(pending, reconciliationError);
      });
      const provider = createWorkerSessionTurnPlacementProvider({
        environments,
        placements,
        reconcileActivePlacement,
      });
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
        const execute = vi.fn(() =>
          provider.executeTurn(
            { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
            workerTurn,
            runLocal,
          ),
        );
        const config = {
          ...workerTurn.config,
          agents: {
            defaults: {
              models: {
                "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
                "openai/gpt-test-next": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        };
        let mediaTasks = getGeneratedMediaTaskIdsForSessionKey(SESSION_KEY);
        const candidateFailures: unknown[] = [];
        const runCandidate = vi.fn((candidateProvider: string, model: string) => {
          mediaTasks = getGeneratedMediaTaskIdsForSessionKey(SESSION_KEY);
          return runEmbeddedAgent({
            ...workerTurn,
            config,
            provider: candidateProvider,
            model,
            suppressNextUserMessagePersistence: launchedModels.length > 0,
          }).catch((error: unknown) => {
            candidateFailures.push(error);
            throw error;
          });
        });
        const runOuterEntry = () =>
          runEmbeddedAgentEntry({
            selection: {
              cfg: config,
              provider: "openai",
              model: "gpt-test",
              manifestPlugins: [],
              fallbacksOverride: ["openai/gpt-test-next"],
            },
            identity: { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
            harness: {
              workspaceDir: root,
              sessionKey: SESSION_KEY,
              preparation: { kind: "direct" },
              resolveRuntimeOverride: () => "openclaw",
            },
            // Use the command/RPC producer, not a test veto derived from the answer.
            behavior: {
              kind: "command-rpc",
              hasCommittedSideEffect: () =>
                hasNewGeneratedMediaTaskForSessionKey(SESSION_KEY, mediaTasks),
            },
            sessionOverride: { kind: "preserve" },
            runCandidate,
          });
        const observed = await (
          outerFallback
            ? runOuterEntry()
            : reconciliationFails
              ? runWithModelFallback({
                  cfg: undefined,
                  provider: "fixture-provider",
                  model: "fixture-model",
                  manifestPlugins: [],
                  fallbacksOverride: ["fixture-next/fixture-model"],
                  run: execute,
                })
              : execute()
        ).catch((error: unknown) => error);
        if (outerFallback) {
          expect(candidateFailures[0]).toBeInstanceOf(WorkerTurnExecutionError);
          expect(candidateFailures[0]).toMatchObject({ message: failure });
          expect(tunnel.reconcileWorkspace).toHaveBeenCalledOnce();
          expect(openSessionManager().getLeafEntry()).toMatchObject({
            type: "message",
            message: {
              role: "assistant",
              stopReason,
              content: providerFailure ? [] : [{ type: "text", text: "Remote answer" }],
            },
          });
          expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
          expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
          expect(environments.destroy).not.toHaveBeenCalled();
          if (providerFailure) {
            expect(launchedModels).toEqual(["gpt-test", "gpt-test-next"]);
            expect(runCandidate).toHaveBeenCalledTimes(2);
            expect(observed).toMatchObject({ message: "Unexpected second worker execution" });
            await expect(fs.stat(effectFile)).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          expect
            .soft(launchedModels, "cleanup must not replay the committed worker effect")
            .toEqual(["gpt-test"]);
          expect.soft(await fs.readFile(effectFile, "utf8")).toBe("effect\n");
          expect.soft(runCandidate).toHaveBeenCalledOnce();
          expect.soft(observed).toBe(candidateFailures[0]);
          return;
        }
        expect(observed).toMatchObject({ message: expect.stringContaining(failure) });
        if (reconciliationFails) {
          expect(observed).toMatchObject({ cause: expect.any(WorkerWorkspaceReconciliationError) });
          expect(observed).toMatchObject({ cause: { cause: reconciliationError } });
          expect(resolveModelFallbackError(observed)).toEqual({
            kind: "coordination",
            error: observed,
          });
          expect(reconcileActivePlacement).toHaveBeenCalledExactlyOnceWith(ENVIRONMENT_ID);
        } else {
          expect(observed).toMatchObject({ message: failure });
          expect(reconcileActivePlacement).not.toHaveBeenCalled();
        }
        expect(execute).toHaveBeenCalledOnce();
        expect(tunnel.launchTurn).toHaveBeenCalledOnce();
        expect(runLocal).not.toHaveBeenCalled();
        expect(placements.get(SESSION_ID)).toMatchObject({
          state: reconciliationFails ? "failed" : "active",
          turnClaim: null,
        });
        expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
        expect(environments.destroy).not.toHaveBeenCalled();
        await expect(
          service.pushLiveEvent(identity!, {
            runEpoch: OWNER_EPOCH,
            lastAckedSeq: 2,
            seq: 2,
            runId,
            event: {
              kind: "lifecycle",
              payload: { phase: "finishing", endedAt: 3, error: "late" },
            },
          }),
        ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
      } finally {
        uninstall();
        await service.stop();
        workerTurn.preparedRunAdmission.close();
        releaseAgentRunContext(runId, dispatchClaim);
      }
    },
  );

  it("requests immediate recovery when reconciliation fails after worker finishing", async () => {
    seedActivePlacement();
    const destroy = vi.fn(async () => attachedEnvironment());
    const tunnelFailure = new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: gateway TLS fingerprint mismatch",
    );
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      runWorkspaceCommand: vi.fn(),
      measureLaunchTurn,
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Remote work completed" }],
            timestamp: 21,
          }),
        );
        createWorkerSessionPlacementGate(placements).updateAckCursors({
          claim: request.turnClaim,
          transcriptSeq: 2,
          liveSeq: 1,
        });
        return {
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: leafId,
            transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
          }),
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        };
      }),
      syncWorkspace: vi.fn(async () => {
        throw new Error("unexpected workspace sync");
      }),
      reconcileWorkspace: vi.fn(async () => {
        throw tunnelFailure;
      }),
      stop: vi.fn(async () => {}),
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => tunnel),
      destroy,
    };
    const reconcileActivePlacement = vi.fn(async () => {
      const [pending] = placements.listPendingWorkspaceResults();
      if (!pending) {
        throw new Error("expected pending workspace result");
      }
      placements.failWorkspaceResultAndReleaseTurn(pending, tunnelFailure);
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      reconcileActivePlacement,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-reconcile-tunnel-loss",
        },
        turn("run-reconcile-tunnel-loss"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toMatchObject({
      name: "WorkerWorkspaceReconciliationError",
      message:
        "Cloud worker finished, but its workspace result could not be reconciled: workspace-transfer-failed: gateway TLS fingerprint mismatch",
    });

    expect(reconcileActivePlacement).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
    expect(placements.listPendingWorkspaceResults()).toHaveLength(0);
    expect(destroy).not.toHaveBeenCalled();
  });

  it.each<{
    name: string;
    content: Parameters<typeof makeAgentAssistantMessage>[0]["content"];
    visibleText?: string;
    rawText?: string;
    terminalReply: AgentRunTerminalReplySnapshot;
    costs?: { first: number; last: number; total: number };
  }>([
    {
      name: "visible final answer",
      costs: { first: 0.125, last: 0.25, total: 0.375 },
      content: [
        { type: "thinking", thinking: "Private reasoning" },
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Usage reply",
          textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
        },
      ],
      visibleText: "Usage reply",
      rawText: "Usage reply",
      terminalReply: { disposition: "visible", text: "Usage reply" },
    },
    {
      name: "sanitized final answer",
      content: [{ type: "text", text: "<think>Private reasoning</think>Usage reply" }],
      visibleText: "Usage reply",
      rawText: "<think>Private reasoning</think>Usage reply",
      terminalReply: { disposition: "visible", text: "Usage reply" },
    },
    {
      name: "explicit silence",
      content: [{ type: "text", text: "NO_REPLY" }],
      visibleText: "NO_REPLY",
      rawText: "NO_REPLY",
      terminalReply: { disposition: "silent" },
    },
    {
      name: "reasoning-only completion",
      content: [{ type: "thinking", thinking: "Private reasoning" }],
      terminalReply: { disposition: "empty" },
    },
    {
      name: "tool-only completion",
      content: [{ type: "toolCall", id: "call-final", name: "read", arguments: {} }],
      terminalReply: { disposition: "empty" },
    },
    {
      name: "empty final answer",
      content: [],
      terminalReply: { disposition: "empty" },
    },
  ])(
    "reports canonical usage and $name",
    async ({
      content,
      visibleText,
      rawText,
      terminalReply,
      costs = { first: 0, last: 0, total: 0 },
    }) => {
      seedActivePlacement();
      const environments: WorkerTurnEnvironmentService = {
        get: vi.fn(() => attachedEnvironment()),
        acquireTurnCredential: vi.fn(async () => credential()),
        acknowledgeCredentialDelivery: vi.fn(() => true),
        startTunnel: vi.fn(async () => ({
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          quiesceWorkspace: vi.fn(async () => ({
            assertActive: vi.fn(async () => {}),
            resume: vi.fn(async () => {}),
          })),
          runWorkspaceCommand: vi.fn(),
          measureLaunchTurn,
          launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
            request.onDispatchReady?.();
            const completed = openSessionManager();
            completed.appendMessage(
              makeAgentAssistantMessage({
                content: [{ type: "toolCall", id: "call-usage", name: "read", arguments: {} }],
                provider: "openai",
                model: "gpt-first-call",
                stopReason: "toolUse",
                timestamp: 21,
                usage: {
                  input: 100,
                  output: 10,
                  cacheRead: 20,
                  cacheWrite: 5,
                  totalTokens: 135,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costs.first },
                },
              }),
            );
            completed.appendMessage({
              role: "toolResult",
              toolCallId: "call-usage",
              toolName: "read",
              content: [{ type: "text", text: "usage result" }],
              isError: false,
              timestamp: 22,
            });
            const leafId = completed.appendMessage(
              makeAgentAssistantMessage({
                content,
                provider: "anthropic",
                model: "claude-reported",
                timestamp: 23,
                usage: {
                  input: 200,
                  output: 30,
                  cacheRead: 40,
                  cacheWrite: 0,
                  contextUsage: {
                    state: "available",
                    promptTokens: 240,
                    totalTokens: 270,
                  },
                  totalTokens: 270,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costs.last },
                },
              }),
            );
            createWorkerSessionPlacementGate(placements).updateAckCursors({
              claim: request.turnClaim,
              transcriptSeq: 2,
              liveSeq: 1,
            });
            return {
              stdout: JSON.stringify({
                status: "completed",
                transcriptLeafId: leafId,
                transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
              }),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          }),
          syncWorkspace: vi.fn(async () => {
            throw new Error("unexpected workspace sync");
          }),
          reconcileWorkspace: vi.fn(async (request) => {
            request.journal.commit(MANIFEST_REF);
            return {
              manifestRef: MANIFEST_REF,
              changed: false,
              verifyStable: async () => {},
              verifyLocalStable: async () => {},
            };
          }),
          stop: vi.fn(async () => {}),
        })),
        stopTunnel: vi.fn(async () => {}),
        destroy: vi.fn(async () => attachedEnvironment()),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

      const result = await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-worker-usage",
        },
        turn("run-worker-usage"),
        async () => ({ meta: { durationMs: 1 } }),
      );

      expect(result.meta.finalAssistantVisibleText).toBe(visibleText);
      expect(result.meta.finalAssistantRawText).toBe(rawText);
      expect(
        buildAgentRunTerminalReplySnapshot({
          visibleText: result.meta.finalAssistantVisibleText,
          rawText: result.meta.finalAssistantRawText,
        }),
      ).toEqual(terminalReply);
      expect(result.meta.agentMeta).toEqual({
        sessionId: SESSION_ID,
        sessionFile,
        provider: "anthropic",
        model: "claude-reported",
        costUsd: costs.total,
        usage: {
          input: 300,
          output: 40,
          cacheRead: 60,
          cacheWrite: 5,
          total: 405,
          cost: { total: costs.total },
        },
        lastCallUsage: {
          input: 200,
          output: 30,
          cacheRead: 40,
          cacheWrite: 0,
          contextUsage: {
            state: "available",
            promptTokens: 240,
            totalTokens: 270,
          },
          total: 270,
          cost: { total: costs.last },
        },
        promptTokens: 240,
      });
    },
  );
});
