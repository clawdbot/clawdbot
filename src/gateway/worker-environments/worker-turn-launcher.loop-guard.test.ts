import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LOOP_GUARD_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
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
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

/** Shared success-path tunnel for the guard-off legacy-receipt cases. */
function createLoopGuardTurnTunnel(captured: { plan?: WorkerLaunchPlan }): WorkerTunnelHandle {
  return {
    environmentId: ENVIRONMENT_ID,
    ownerEpoch: OWNER_EPOCH,
    measureLaunchTurn,
    launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
      captured.plan = request.plan;
      request.onDispatchReady?.();
      const completed = openSessionManager();
      const leafId = completed.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Worker reply" }],
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
    runWorkspaceCommand: vi.fn(),
    quiesceWorkspace: vi.fn(async () => ({
      assertActive: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
    })),
    syncWorkspace: vi.fn(async () => {
      throw new Error("unexpected workspace sync");
    }),
    reconcileWorkspace: vi.fn(async (request) => {
      if (request.source.kind !== "local") {
        throw new Error("expected a local workspace source");
      }
      request.source.journal.commit(MANIFEST_REF);
      return {
        manifestRef: MANIFEST_REF,
        changed: false,
        verifyStable: async () => {},
        verifyLocalStable: async () => {},
      };
    }),
    stop: vi.fn(async () => {}),
  };
}

describe("worker turn launcher loop-guard capability fence", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("rejects a guard-enabled turn on a worker bundle without loop-guard support", async () => {
    seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    oldEnvironment.bootstrapReceipt = {
      ...oldEnvironment.bootstrapReceipt!,
      protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => oldEnvironment),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const guardEnabledTurn = {
      ...turn("run-legacy-worker"),
      // Explicit tools.loopDetection with a guard key: engages the built-in
      // guard defaults, so this turn requires the loop-guard capability on
      // the worker bundle (opt-in: configless turns must NOT be fenced).
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
        tools: { loopDetection: { enabled: true, turnLimit: 200 } },
      },
    };

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-legacy-worker",
        },
        guardEnabledTurn,
        runLocal,
      ),
    ).rejects.toThrow("reprovision the worker before launch");

    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    // A capability-fenced bundle cannot serve this or any later turn: the
    // placement must be failed so dispatch reprovisions a current bundle
    // instead of re-selecting this unusable worker.
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: expect.stringContaining("loop-guard capability"),
    });
  });

  // Opt-in semantics: configless and `enabled: false` sessions never engage
  // the runLoop guards, so a bundle that predates the loop-guard launch
  // contract must keep serving them (pre-guard execution) — the capability
  // fence fires only for turns whose resolved guard state is actually enabled,
  // and no all-undefined loopGuardConfig object goes on the wire.
  it.each([
    ["configless", (runId: string) => turn(runId)],
    [
      "explicit enabled:false",
      (runId: string) => {
        const base = turn(runId);
        return {
          ...base,
          config: { ...base.config, tools: { loopDetection: { enabled: false } } },
        };
      },
    ],
  ])(
    "dispatches a %s turn on a legacy bundle without the loop-guard capability",
    async (_label, buildTurn) => {
      seedActivePlacement();
      const captured: { plan?: WorkerLaunchPlan } = {};
      const tunnel = createLoopGuardTurnTunnel(captured);
      const baseEnvironment = attachedEnvironment();
      const legacyEnvironment = {
        ...baseEnvironment,
        bootstrapReceipt: {
          ...baseEnvironment.bootstrapReceipt!,
          // Predates the loop-guard launch contract but still carries the
          // current execution-context carrier.
          protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
        },
      };
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() => legacyEnvironment),
        acquireTurnCredential: vi.fn(async () => credential()),
        acknowledgeCredentialDelivery: vi.fn(() => true),
        startTunnel: vi.fn(async () => tunnel),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

      await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-legacy-configless",
        },
        buildTurn("run-legacy-configless"),
        async () => ({ meta: { durationMs: 1 } }),
      );

      // No fence: the legacy bundle served the guard-off turn end to end.
      expect(captured.plan?.assignment).not.toHaveProperty("loopGuardConfig");
    },
  );

  it("serializes the resolved loop-guard config for a loop-guard capable bundle", async () => {
    seedActivePlacement();
    let capturedPlan: WorkerLaunchPlan | undefined;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      measureLaunchTurn,
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        capturedPlan = request.plan;
        request.onDispatchReady?.();
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Worker reply" }],
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
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      syncWorkspace: vi.fn(async () => {
        throw new Error("unexpected workspace sync");
      }),
      reconcileWorkspace: vi.fn(async (request) => {
        if (request.source.kind !== "local") {
          throw new Error("expected a local workspace source");
        }
        request.source.journal.commit(MANIFEST_REF);
        return {
          manifestRef: MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
        };
      }),
      stop: vi.fn(async () => {}),
    };
    const baseEnvironment = attachedEnvironment();
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => ({
        ...baseEnvironment,
        bootstrapReceipt: {
          ...baseEnvironment.bootstrapReceipt!,
          protocolFeatures: [
            WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
            WORKER_LOOP_GUARD_PROTOCOL_FEATURE,
          ],
        },
      })),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => tunnel),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-loop-guard-feature",
      },
      {
        ...turn("run-loop-guard-feature"),
        suppressNextUserMessagePersistence: true,
        // Explicit tools.loopDetection with a guard key: engages the built-in
        // guard defaults so the serialization path is exercised end to end
        // (guards are opt-in; without a guard key the resolver yields
        // all-undefined).
        config: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
          tools: { loopDetection: { enabled: true, turnLimit: 200 } },
        },
      },
      async () => ({ meta: { durationMs: 1 } }),
    );

    expect(capturedPlan?.assignment.loopGuardConfig).toEqual({
      maxTurns: 200,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("resolves the loop-guard config from the placement agent when the turn omits agentId", async () => {
    seedActivePlacement();
    let capturedPlan: WorkerLaunchPlan | undefined;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      measureLaunchTurn,
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        capturedPlan = request.plan;
        request.onDispatchReady?.();
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Worker reply" }],
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
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      syncWorkspace: vi.fn(async () => {
        throw new Error("unexpected workspace sync");
      }),
      reconcileWorkspace: vi.fn(async (request) => {
        if (request.source.kind !== "local") {
          throw new Error("expected a local workspace source");
        }
        request.source.journal.commit(MANIFEST_REF);
        return {
          manifestRef: MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
        };
      }),
      stop: vi.fn(async () => {}),
    };
    const baseEnvironment = attachedEnvironment();
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => ({
        ...baseEnvironment,
        bootstrapReceipt: {
          ...baseEnvironment.bootstrapReceipt!,
          protocolFeatures: [
            WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
            WORKER_LOOP_GUARD_PROTOCOL_FEATURE,
          ],
        },
      })),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => tunnel),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    // Annotated as SessionPlacementTurnParams so `agentId` is optional and can
    // be deleted: `turn.agentId` may be omitted, and the placement is the
    // authoritative agent identity.
    const omittedTurn: SessionPlacementTurnParams = {
      ...turn("run-loop-guard-omitted-agent"),
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
            },
          },
          entries: {
            main: {
              // Per-agent override that actually engages a guard: only the
              // placement knows the agent identity when the turn omits it, so
              // this asserts the placement-authoritative resolution still
              // drives the serialized wire values.
              tools: { loopDetection: { enabled: true, turnLimit: 150 } },
            },
          },
        },
      },
    };
    delete omittedTurn.agentId;

    await provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-loop-guard-omitted-agent",
      },
      omittedTurn,
      async () => ({ meta: { durationMs: 1 } }),
    );

    expect(capturedPlan?.assignment.loopGuardConfig).toEqual({
      maxTurns: 150,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });
});
