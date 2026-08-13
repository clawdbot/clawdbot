import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_LAUNCH_V2_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createEmbeddedRunLaneController } from "../../agents/embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  type AgentEventPayload,
  getAgentEventLifecycleGeneration,
  onAgentEvent as subscribeAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  readAgentRunIndexVersion,
  registerAgentRunContext,
  retainQueuedAgentRunContext,
  sweepStaleRunContexts,
} from "../../infra/agent-run-registry.js";
import { getCommandLaneSnapshot, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import {
  createAgentRuntimeApprovalAuthorityValidator,
  verifyAgentRuntimeIdentityToken,
} from "../agent-runtime-identity-token.js";
import type { MintedWorkerCredential } from "./credential.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { createWorkerSessionTurnPlacementProvider as createRawWorkerSessionTurnPlacementProvider } from "./worker-turn-launcher.js";
import { resolveWorkerTurnTranscriptTarget } from "./worker-turn-transcript-target.js";

type WorkerTurnLauncherOptions = Parameters<typeof createRawWorkerSessionTurnPlacementProvider>[0];
type WorkerTurnEnvironmentService = WorkerTurnLauncherOptions["environments"];

const SESSION_ID = "session-worker-turn";
const SESSION_KEY = "agent:main:worker-turn";
const ENVIRONMENT_ID = "environment-worker-turn";
const OWNER_EPOCH = 3;
const BUNDLE_HASH = "a".repeat(64);
const MANIFEST_REF = `sha256:${"b".repeat(64)}`;
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
type WorkerTurnEnvironmentRecord = NonNullable<ReturnType<WorkerTurnEnvironmentService["get"]>>;

function hasLoneSurrogate(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint >= 0xd800 && codePoint <= 0xdfff;
  });
}

describe("worker turn launcher", () => {
  let cleanupAdmissionSink: (() => void) | undefined;
  it("rejects a transcript target without a session incarnation", () => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        sessionId: "current-session",
        sessionTarget: {
          agentId: "main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("missing its transcript identity");
  });

  it("rejects a transcript target from another session incarnation", () => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        sessionId: "current-session",
        sessionTarget: {
          agentId: "main",
          sessionId: "stale-session",
          sessionKey: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("transcript identity does not match the active turn");
  });

  it.each([
    ["agent", { agentId: "other", sessionKey: "agent:main:main" }],
    ["session key", { agentId: "main", sessionKey: "agent:main:other" }],
    ["target key agent", { agentId: "main", sessionKey: "agent:other:main" }],
  ])("rejects a transcript target with a different %s", (_label, identity) => {
    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: "current-session",
        sessionKey: "agent:main:main",
        sessionTarget: {
          ...identity,
          sessionId: "current-session",
          storePath: "/tmp/sessions.json",
        },
      }),
    ).toThrow("transcript identity does not match the active turn");
  });

  let root: string;
  let testState: OpenClawTestState;
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;
  let sessionFile: string;
  let sessionTarget: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      label: "worker-turn",
      layout: "state-only",
    });
    root = testState.root;
    database = openOpenClawStateDatabase({ env: testState.env });
    placements = createWorkerSessionPlacementStore({ database });
    sessionTarget = {
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      storePath: path.join(root, "sessions.json"),
    };
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
    });
    SessionManager.open(sessionTarget);
    sessionFile = SESSION_KEY;
  });

  afterEach(async () => {
    cleanupAdmissionSink?.();
    cleanupAdmissionSink = undefined;
    closeOpenClawStateDatabaseForTest();
    resetAgentEventsForTest();
    await testState.cleanup();
  });

  function createWorkerSessionTurnPlacementProvider(
    options: Omit<WorkerTurnLauncherOptions, "resolveWorkspacePath"> &
      Partial<Pick<WorkerTurnLauncherOptions, "resolveWorkspacePath">>,
  ) {
    return createRawWorkerSessionTurnPlacementProvider({
      resolveWorkspacePath: async () => root,
      ...options,
    });
  }

  function openSessionManager() {
    return SessionManager.open(sessionTarget);
  }

  it("rejects a transcript target after its session key is rebound", async () => {
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: "replacement-session",
      updatedAt: Date.now() + 1,
    });

    expect(() =>
      resolveWorkerTurnTranscriptTarget({
        agentId: "main",
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        sessionTarget,
      }),
    ).toThrow("transcript identity is no longer current");
  });

  function seedActivePlacement(): void {
    let placement = placements.startDispatch({
      sessionId: SESSION_ID,
      sessionKey: sessionTarget.sessionKey,
      agentId: sessionTarget.agentId,
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: ENVIRONMENT_ID },
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: BUNDLE_HASH },
    });
    placement = placements.transition({
      sessionId: SESSION_ID,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        remoteWorkspaceDir: "/worker/workspace",
        workspaceBaseManifestRef: MANIFEST_REF,
      },
    });
    placements.transition({
      sessionId: SESSION_ID,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: OWNER_EPOCH },
    });
  }

  function seedReclaimedPlacement() {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement to reclaim");
    }
    const draining = placements.startDrain({
      sessionId: SESSION_ID,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = placements.startReconcile({
      sessionId: SESSION_ID,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const reclaimed = placements.transition({
      sessionId: SESSION_ID,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    if (reclaimed.state !== "reclaimed") {
      throw new Error("expected reclaimed placement");
    }
    return reclaimed;
  }

  function attachedEnvironment(): WorkerTurnEnvironmentRecord {
    return {
      environmentId: ENVIRONMENT_ID,
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision-worker-turn",
      sharedHost: false,
      bootstrapReceipt: {
        bundleHash: BUNDLE_HASH,
        openclawVersion: "2026.7.2",
        protocolFeatures: [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE],
      },
      ownerEpoch: OWNER_EPOCH,
      teardownTerminalState: null,
      attachedSessionIds: [SESSION_ID],
      lastError: null,
      createdAtMs: 1,
      updatedAtMs: 1,
      stateChangedAtMs: 1,
      idleSinceAtMs: null,
      destroyRequestedAtMs: null,
      tunnelStatus: "connected",
      state: "attached",
      desktop: null,
      desktopAvailable: false,
      desktopApps: [],
      leaseId: "lease-worker-turn",
      sshEndpoint: {
        host: "worker.example.test",
        port: 22,
        user: "worker",
        hostKey: HOST_KEY,
        keyRef: { source: "file", provider: "worker-keys", id: "/worker/key" },
      },
    };
  }

  function browserEnvironment(): WorkerTurnEnvironmentRecord {
    return {
      ...attachedEnvironment(),
      desktop: {
        protocol: "rfb",
        port: 5900,
        apps: [
          {
            id: "browser",
            executablePath: "/usr/local/bin/openclaw-worker-browser",
            cdpPort: 9222,
          },
        ],
      },
      desktopAvailable: true,
      desktopApps: ["browser"],
    };
  }

  function credential(deliveryId = "c".repeat(43)): MintedWorkerCredential {
    return {
      credential: ["worker", "turn", "credential"].join("-"),
      deliveryId,
      environmentId: ENVIRONMENT_ID,
      bundleHash: BUNDLE_HASH,
      sessionId: SESSION_ID,
      rpcSetVersion: 1,
      ownerEpoch: OWNER_EPOCH,
      expiresAtMs: Date.now() + 60_000,
    };
  }

  function unusedEnvironments(): WorkerTurnEnvironmentService {
    const unexpected = () => new Error("unexpected worker environment call");
    return {
      get: vi.fn(() => undefined),
      acquireTurnCredential: vi.fn(async () => {
        throw unexpected();
      }),
      acknowledgeCredentialDelivery: vi.fn(() => {
        throw unexpected();
      }),
      startTunnel: vi.fn(async () => {
        throw unexpected();
      }),
      stopTunnel: vi.fn(async () => {
        throw unexpected();
      }),
      destroy: vi.fn(async () => {
        throw unexpected();
      }),
    };
  }

  function turn(runId = "run-worker-turn", executionIdentity = false) {
    const config = {
      ...(executionIdentity
        ? { logging: { audit: { enabled: true, executionIdentity: true } } }
        : {}),
      agents: {
        defaults: {
          models: {
            "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    };
    return {
      preparedRunAdmission: prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: sessionTarget.agentId,
          ingress: { kind: "worker", boundary: "test.worker-turn", state: "present" },
        },
      }),
      sessionId: SESSION_ID,
      sessionKey: sessionTarget.sessionKey,
      agentId: sessionTarget.agentId,
      messageChannel: "telegram",
      currentMessagingTarget: "chat-worker",
      agentAccountId: "worker-account",
      currentThreadTs: "thread-worker",
      sessionFile,
      sessionTarget,
      workspaceDir: root,
      prompt: "Inspect this workspace",
      timeoutMs: 5_000,
      runId,
      provider: "openai",
      model: "gpt-test",
      config,
    };
  }

  it("atomically claims and releases a local turn around the local loop", async () => {
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    const result = await provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-local" },
      turn("run-local"),
      async () => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "local",
          runId: "run-local",
        });
        return { payloads: [{ text: "local" }], meta: { durationMs: 1 } };
      },
    );

    expect(result.payloads).toEqual([{ text: "local" }]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("leaves no placement row for an auxiliary model run without a session key", async () => {
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await provider.executeTurn(
      { sessionId: SESSION_ID, agentId: "main", runId: "run-model-probe" },
      { ...turn("run-model-probe"), modelRun: true },
      runLocal,
    );

    expect(runLocal).toHaveBeenCalledOnce();
    expect(placements.list()).toEqual([]);
  });

  it("keeps recovery-only admission invisible for sessions without durable placement", async () => {
    const provider = createWorkerSessionTurnPlacementProvider({
      admitNewPlacements: false,
      environments: unusedEnvironments(),
      placements,
    });

    await provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-local" },
      turn("run-local"),
      async () => ({ meta: { durationMs: 1 } }),
    );
    await provider.executeLocalTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-cli" },
      async () => ({ kind: "cli" }),
    );

    expect(placements.list()).toEqual([]);
  });

  it("still admits an existing local placement in recovery-only mode", async () => {
    const seedClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "seed-local-placement",
      runId: "seed-local-placement",
      owner: { kind: "local" },
    });
    placements.releaseTurn(seedClaim);
    const provider = createWorkerSessionTurnPlacementProvider({
      admitNewPlacements: false,
      environments: unusedEnvironments(),
      placements,
    });

    await provider.executeTurn(
      { sessionId: SESSION_ID, runId: "run-existing-local" },
      turn("run-existing-local"),
      async () => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "local",
          runId: "run-existing-local",
        });
        return { meta: { durationMs: 1 } };
      },
    );

    expect(placements.get(SESSION_ID)).toMatchObject({ state: "local", turnClaim: null });
  });

  it("holds a local placement claim around CLI execution", async () => {
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    const result = await provider.executeLocalTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId: "run-cli" },
      async () => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "local",
          runId: "run-cli",
        });
        return { kind: "cli" };
      },
    );

    expect(result).toEqual({ kind: "cli" });
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("mints a fresh claim token when a later turn reuses the run id", async () => {
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const claimIds: string[] = [];
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-reused",
    };

    for (let index = 0; index < 2; index += 1) {
      await provider.executeLocalTurn(claim, async () => {
        const claimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
        if (!claimId) {
          throw new Error("expected active placement claim");
        }
        claimIds.push(claimId);
      });
    }

    expect(claimIds).toHaveLength(2);
    expect(claimIds[0]).not.toBe(claimIds[1]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("does not let a stale local finally release a reclaimed run id", async () => {
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const secondStarted = createDeferred();
    const releaseSecond = createDeferred();
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-restarted",
    };

    const first = provider.executeLocalTurn(claim, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;
    const firstClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(placements.clearLocalTurnClaimsAfterRestart()).toBe(1);

    const second = provider.executeLocalTurn(claim, async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
    });
    await secondStarted.promise;
    const secondClaimId = placements.get(SESSION_ID)?.turnClaim?.claimId;
    expect(secondClaimId).toBeTruthy();
    expect(secondClaimId).not.toBe(firstClaimId);

    releaseFirst.resolve();
    await first;
    expect(placements.get(SESSION_ID)?.turnClaim?.claimId).toBe(secondClaimId);

    releaseSecond.resolve();
    await second;
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });

  it("rejects local CLI execution after worker activation", async () => {
    seedActivePlacement();
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ kind: "cli" }));

    await expect(
      provider.executeLocalTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-local-after-dispatch",
        },
        runLocal,
      ),
    ).rejects.toThrow(`Local turn rejected for session ${SESSION_ID} in placement active`);

    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it.each([
    ["CLI", "claude-cli"],
    ["plugin", "test-harness"],
  ])(
    "rejects an active worker turn assigned to a configured %s runtime",
    async (_kind, runtimeId) => {
      seedActivePlacement();
      const getEnvironment = vi.fn(() => undefined);
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: getEnvironment,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
      const runId = `run-${runtimeId}`;

      await expect(
        provider.executeTurn(
          { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
          {
            ...turn(runId),
            config: {
              agents: {
                defaults: {
                  models: {
                    "openai/gpt-test": { agentRuntime: { id: runtimeId } },
                  },
                },
              },
            },
          },
          runLocal,
        ),
      ).rejects.toThrow(`Cloud worker turns require the OpenClaw runtime, not ${runtimeId}`);

      expect(runLocal).not.toHaveBeenCalled();
      expect(getEnvironment).not.toHaveBeenCalled();
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    },
  );

  it("rejects a reused worker bundle without execution context before launch", async () => {
    seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    oldEnvironment.bootstrapReceipt = {
      ...oldEnvironment.bootstrapReceipt!,
      protocolFeatures: [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
    };
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => oldEnvironment),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-old-worker",
        },
        turn("run-old-worker"),
        runLocal,
      ),
    ).rejects.toThrow("reprovision the worker before launch");

    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("carries a non-main placement identity while reporting keep-local conflicts", async () => {
    let admissionWork: ExecutionIdentityAdmissionWork | undefined;
    cleanupAdmissionSink = configureExecutionIdentityAdmissionSink((work) => {
      admissionWork = work;
      return true;
    });
    sessionTarget = {
      ...sessionTarget,
      agentId: "worker-agent",
      sessionKey: "agent:worker-agent:worker-turn",
    };
    sessionFile = sessionTarget.sessionKey;
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
    });
    const initialized = await runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], {
      timeoutMs: 10_000,
    });
    expect(initialized.code).toBe(0);
    seedActivePlacement();
    const manager = openSessionManager();
    const earlierRequestId = manager.appendMessage(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 10 }),
    );
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        timestamp: 11,
      }),
    );
    manager.appendCustomMessageEntry("context", "Custom durable context", true, {});
    manager.appendCompaction("Compacted durable context", earlierRequestId, 100);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 12,
    });
    let descriptor: WorkerLaunchDescriptor | undefined;
    const acknowledgeCredentialDelivery = vi.fn(() => true);
    const reconcileWorkspace = vi.fn(
      async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
        expect(request.stagedResult).toBeDefined();
        request.stagedResult!.record(request.stagedResult!.ref);
        expect(placements.listPendingWorkspaceResults()).toMatchObject([
          { stagedResultRef: request.stagedResult!.ref, workspaceAcceptedAtMs: null },
        ]);
        request.journal.commit(MANIFEST_REF);
        return {
          manifestRef: MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
          getAppliedWorkspaceResult: () => ({
            manifestRef: MANIFEST_REF,
            manifest: { version: 1 as const, baseCommit: null, entries: [] },
            conflictPaths: ["src/local.ts"],
            verifyLocalStable: async () => {},
          }),
        };
      },
    );
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {
          expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
            owner: "worker",
            runId: "run-worker-turn",
          });
          expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
        }),
      })),
      runWorkspaceCommand: vi.fn(),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "worker",
          runId: "run-worker-turn",
          ownerEpoch: OWNER_EPOCH,
        });
        descriptor = parseWorkerLaunchDescriptor(structuredClone(request.descriptor));
        expect(request.timeoutMs).toBe(5_000);
        const activeRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
          descriptor.assignment.agentRuntimeIdentityToken,
        );
        expect(activeRuntimeIdentity?.delegatedAuthority.kind).toBe("worker");
        expect(
          activeRuntimeIdentity &&
            createAgentRuntimeApprovalAuthorityValidator(placements)(activeRuntimeIdentity),
        ).toBe(true);
        expect(descriptor.connectionEndpoint).toEqual({
          kind: "unix",
          socketPath: "/worker/gateway.sock",
        });
        await Promise.resolve();
        expect(acknowledgeCredentialDelivery).toHaveBeenCalledOnce();
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Worker reply" }],
            timestamp: 21,
          }),
        );
        createWorkerSessionPlacementGate(placements).updateAckCursors({
          sessionId: SESSION_ID,
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runId: "run-worker-turn",
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
      reconcileWorkspace,
      stop: vi.fn(async () => {}),
    };
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => browserEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      destroy: vi.fn(async () => attachedEnvironment()),
    };
    const resolveWorkspacePath = vi.fn(async () => root);
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      resolveWorkspacePath,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAgentEvent = vi.fn(() => {
      throw new Error("supplemental event failed");
    });

    const result = await provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: sessionTarget.sessionKey,
        agentId: sessionTarget.agentId,
        runId: "run-worker-turn",
      },
      {
        ...turn("run-worker-turn", true),
        toolsAllow: ["browser"],
        workspaceDir: path.join(root, "stale-caller-workspace"),
        transcriptPrompt: "Canonical transcript request",
        onAgentEvent,
      },
      runLocal,
    );

    expect(runLocal).not.toHaveBeenCalled();
    expect(resolveWorkspacePath).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      sessionKey: sessionTarget.sessionKey,
      agentId: sessionTarget.agentId,
    });
    expect(reconcileWorkspace).toHaveBeenCalledWith(expect.objectContaining({ localPath: root }));
    const conflictSummary =
      "Cloud result applied with 1 conflict(s); kept local versions: src/local.ts. Cloud versions staged at refs/openclaw/worker-results/";
    expect(result.payloads).toEqual([
      { text: expect.stringContaining(`Worker reply\n\n${conflictSummary}`) },
    ]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(placements.get(SESSION_ID)?.workspaceResultConflict).toMatchObject({
      paths: ["src/local.ts"],
      stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//u),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "assistant",
      data: {
        text: expect.stringContaining(conflictSummary),
        delta: expect.stringContaining(conflictSummary),
      },
    });
    expect(
      openSessionManager()
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "cloud-workspace-conflict",
        ),
    ).toBe(true);
    expect(descriptor?.assignment.prompt).toBe("Inspect this workspace");
    expect(descriptor?.assignment.suppressPromptTranscript).toBe(true);
    expect(descriptor?.assignment.agentId).toBe(sessionTarget.agentId);
    expect(descriptor?.version).toBe(3);
    const verifiedRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
      descriptor?.assignment.agentRuntimeIdentityToken,
    );
    expect(verifiedRuntimeIdentity?.operationalRunInstance).toEqual(
      descriptor?.assignment.operationalRunInstance,
    );
    expect(verifiedRuntimeIdentity?.executionIdentity?.runId).toBe("run-worker-turn");
    expect(verifiedRuntimeIdentity).toMatchObject({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-worker",
      turnSourceAccountId: "worker-account",
      turnSourceThreadId: "thread-worker",
    });
    expect(descriptor?.assignment.agentId).toBe(verifiedRuntimeIdentity?.agentId);
    expect(
      verifiedRuntimeIdentity &&
        createAgentRuntimeApprovalAuthorityValidator(placements)(verifiedRuntimeIdentity),
    ).toBe(false);
    expect(admissionWork?.kind).toBe("capture");
    if (admissionWork?.kind === "capture") {
      expect(admissionWork.envelope.runtimeInstanceId).toBe(ENVIRONMENT_ID);
    }
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(descriptor?.assignment).not.toHaveProperty("admittedRunContext");
    expect(descriptor?.assignment.toolAuthority.allowedToolNames).toEqual(["browser"]);
    expect(descriptor?.assignment.browser).toEqual({
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
    });
    expect(descriptor?.assignment.initialMessages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Compacted durable context"),
          },
        ],
        timestamp: expect.any(Number),
      },
      {
        role: "user",
        content: [{ type: "text", text: "Earlier request" }],
        timestamp: 10,
      },
      expect.objectContaining({ role: "assistant" }),
      {
        role: "user",
        content: [{ type: "text", text: "Custom durable context" }],
        timestamp: expect.any(Number),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 12,
      },
    ]);
    expect(
      openSessionManager()
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
        ),
    ).toContainEqual([{ type: "text", text: "Canonical transcript request" }]);
  });

  it("keeps reset tool pairs valid without replaying the already-persisted current user", async () => {
    seedActivePlacement();
    const manager = openSessionManager();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "shared-call", name: "read", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 16,
      }),
    );
    const firstKeptEntryId = manager.appendMessage(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 17 }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "shared-call",
      toolName: "read",
      content: [{ type: "text", text: "Discarded owner result" }],
      isError: false,
      timestamp: 18,
    });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "shared-call", name: "read", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 19,
      }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "shared-call",
      toolName: "read",
      content: [{ type: "text", text: "Kept owner result" }],
      isError: false,
      timestamp: 20,
    });
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier reply" }],
        timestamp: 21,
      }),
    );
    manager.appendResetBoundary("new", firstKeptEntryId);
    manager.appendMessage(
      makeAgentUserMessage({ content: "Inspect this workspace", timestamp: 22 }),
    );
    let descriptor: WorkerLaunchDescriptor | undefined;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      runWorkspaceCommand: vi.fn(),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        descriptor = parseWorkerLaunchDescriptor(structuredClone(request.descriptor));
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Worker reply" }],
            timestamp: 21,
          }),
        );
        createWorkerSessionPlacementGate(placements).updateAckCursors({
          sessionId: SESSION_ID,
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runId: "run-persisted-user",
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
    };
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => browserEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      destroy: vi.fn(async () => attachedEnvironment()),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-persisted-user",
      },
      {
        ...turn("run-persisted-user"),
        config: {
          ...turn("run-persisted-user").config,
          plugins: { entries: { browser: { enabled: false } } },
        },
        toolsAllow: ["browser"],
        suppressNextUserMessagePersistence: true,
      },
      async () => ({ meta: { durationMs: 1 } }),
    );

    expect(descriptor?.assignment.prompt).toBe("Inspect this workspace");
    const verifiedRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
      descriptor?.assignment.agentRuntimeIdentityToken,
    );
    expect(verifiedRuntimeIdentity?.operationalRunInstance).toEqual(
      descriptor?.assignment.operationalRunInstance,
    );
    expect(verifiedRuntimeIdentity).not.toHaveProperty("executionIdentity");
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(descriptor?.assignment.toolAuthority.allowedToolNames).toEqual([]);
    expect(descriptor?.assignment.browser).toBeUndefined();
    expect(descriptor?.assignment.initialMessages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ id: "shared-call" }] },
      { role: "toolResult", toolCallId: "shared-call" },
      { role: "assistant" },
    ]);
    expect(JSON.stringify(descriptor?.assignment.initialMessages)).not.toContain(
      "Discarded owner result",
    );
    const persistedEntries = openSessionManager().getEntries();
    const persistedCurrentUsers = persistedEntries.filter((entry) => {
      if (typeof entry !== "object" || entry === null || !("message" in entry)) {
        return false;
      }
      const message = entry.message;
      if (
        typeof message !== "object" ||
        message === null ||
        !("role" in message) ||
        !("content" in message)
      ) {
        return false;
      }
      return (
        message.role === "user" &&
        (message.content === "Inspect this workspace" ||
          (Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                typeof part === "object" &&
                part !== null &&
                "text" in part &&
                part.text === "Inspect this workspace",
            )))
      );
    });
    expect(persistedCurrentUsers).toHaveLength(1);
  });

  it("retains a cloud result when reconciliation fails after worker finishing", async () => {
    seedActivePlacement();
    const destroy = vi.fn(async () => attachedEnvironment());
    const tunnelFailure = new Error("worker tunnel disconnected before workspace reconcile");
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      runWorkspaceCommand: vi.fn(),
      launchTurn: vi.fn(async (): Promise<SpawnResult> => {
        const completed = openSessionManager();
        const leafId = completed.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Remote work completed" }],
            timestamp: 21,
          }),
        );
        createWorkerSessionPlacementGate(placements).updateAckCursors({
          sessionId: SESSION_ID,
          environmentId: ENVIRONMENT_ID,
          ownerEpoch: OWNER_EPOCH,
          runId: "run-reconcile-tunnel-loss",
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
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

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
      message:
        "Cloud worker finished, but its workspace result could not be reconciled: worker tunnel disconnected before workspace reconcile",
    });

    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: { runId: "run-reconcile-tunnel-loss" },
    });
    expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("reports canonical multi-call usage and the terminal provider model", async () => {
    seedActivePlacement();
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(async (): Promise<SpawnResult> => {
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
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
              content: [{ type: "text", text: "Usage reply" }],
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
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            }),
          );
          createWorkerSessionPlacementGate(placements).updateAckCursors({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            runId: "run-worker-usage",
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

    expect(result.meta.agentMeta).toEqual({
      sessionId: SESSION_ID,
      sessionFile,
      provider: "anthropic",
      model: "claude-reported",
      usage: {
        input: 300,
        output: 40,
        cacheRead: 60,
        cacheWrite: 5,
        total: 405,
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
      },
      promptTokens: 240,
    });
  });

  it("keeps an active placement when tunnel startup fails before remote handoff", async () => {
    seedActivePlacement();
    const acknowledgeCredentialDelivery = vi.fn(() => true);
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => {
        throw Object.assign(new Error("device-runner-transport-unimplemented: launch is pending"), {
          code: "device-runner-transport-unimplemented",
        });
      }),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-tunnel-unavailable",
        },
        turn("run-tunnel-unavailable"),
        runLocal,
      ),
    ).rejects.toMatchObject({ code: "device-runner-transport-unimplemented" });

    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("fails impossible replay before handoff and keeps the active placement reusable", async () => {
    seedActivePlacement();
    const manager = openSessionManager();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-replay", name: "read", arguments: {} }],
        model: "gpt-test",
        providerReplay: {
          v: 1,
          type: "openai-responses-compaction",
          data: "gAAAAlauncherReplayCiphertext",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-test",
          baseUrlHash: "ozhevd1smnk8s",
        },
        stopReason: "toolUse",
        timestamp: 1,
      }),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-replay",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      details: { payload: "x".repeat(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) },
      isError: false,
      timestamp: 2,
    });
    const launchTurn = vi.fn(async (): Promise<SpawnResult> => {
      throw new Error("unexpected worker handoff");
    });
    const acknowledgeCredentialDelivery = vi.fn(() => true);
    const startTunnel = vi.fn(
      async (): Promise<WorkerTunnelHandle> => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        launchTurn,
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      }),
    );
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel,
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-replay-local-fallback",
        },
        turn("run-replay-local-fallback"),
        runLocal,
      ),
    ).rejects.toThrow(WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE);

    expect(startTunnel).toHaveBeenCalledOnce();
    expect(launchTurn).not.toHaveBeenCalled();
    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("preserves a terminal workspace result when the worker child later exits nonzero", async () => {
    seedActivePlacement();
    const destroy = vi.fn(async () => attachedEnvironment());
    const launchTurn = vi.fn(async (): Promise<SpawnResult> => {
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        sessionId: SESSION_ID,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runId: "run-terminal-child-failure",
        liveSeq: 1,
      });
      return {
        stdout: "",
        stderr: "child cleanup failed",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        launchTurn,
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      })),
      stopTunnel: vi.fn(async () => {}),
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-terminal-child-failure",
        },
        turn("run-terminal-child-failure"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("child cleanup failed");

    expect(launchTurn).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.listPendingWorkspaceResults()).toMatchObject([
      {
        sessionId: SESSION_ID,
        runId: "run-terminal-child-failure",
        gatewayInstanceId: placements.workspaceResultInstanceId(),
        recoveryRequestedAtMs: expect.any(Number),
      },
    ]);
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "active",
      turnClaim: { owner: "worker", runId: "run-terminal-child-failure" },
    });
  });

  it("preserves an unresolved rollback journal when pre-launch recovery conflicts", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement for journal recovery");
    }
    const owner = {
      sessionId: active.sessionId,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      placementGeneration: active.generation,
    };
    const basePack = Buffer.from("conflicted journal snapshot");
    placements.beginWorkspaceReconciliation(owner, {
      version: 1,
      temporaryNonce: "e".repeat(32),
      baseManifestRef: active.workspaceBaseManifestRef,
      currentManifestRef: `sha256:${"f".repeat(64)}`,
      baseEntries: [
        {
          path: "blocked.txt",
          type: "file",
          mode: 0o644,
          size: 5,
          sha256: createHash("sha256").update("base\n").digest("hex"),
        },
      ],
      appliedEntries: [
        {
          path: "blocked.txt",
          type: "file",
          mode: 0o644,
          size: 7,
          sha256: createHash("sha256").update("worker\n").digest("hex"),
        },
      ],
      baseTree: "d".repeat(40),
      basePackSha256: createHash("sha256").update(basePack).digest("hex"),
      basePack,
    });
    await fs.writeFile(path.join(root, "blocked.txt"), "local\n");
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => attachedEnvironment()),
    };
    const enteredWorkspaceQueue = createDeferred();
    const releaseWorkspaceQueue = createDeferred();
    const workspaceOperations: NonNullable<WorkerTurnLauncherOptions["workspaceOperations"]> = {
      async run(environmentId, operation) {
        expect(environmentId).toBe(ENVIRONMENT_ID);
        enteredWorkspaceQueue.resolve();
        await releaseWorkspaceQueue.promise;
        return await operation();
      },
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      workspaceOperations,
    });

    const attempt = provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-blocked-journal",
      },
      turn("run-blocked-journal"),
      async () => ({ meta: { durationMs: 1 } }),
    );
    await enteredWorkspaceQueue.promise;
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    releaseWorkspaceQueue.resolve();
    await expect(attempt).rejects.toThrow("workspace recovery could not complete");

    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(placements.listWorkspaceReconciliationOwners()).toEqual([owner]);
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.destroy).not.toHaveBeenCalled();
  });

  it("fails placement and tears down after an ambiguous remote launch failure", async () => {
    seedActivePlacement();
    const teardownStates: string[] = [];
    const observedPlacements: WorkerSessionPlacementStore = {
      ...placements,
      startReconcile: (input) => {
        teardownStates.push(`reconcile-before:${placements.get(SESSION_ID)?.state ?? "missing"}`);
        const reconciling = placements.startReconcile(input);
        teardownStates.push(`reconcile-after:${reconciling.state}`);
        expect(reconciling.turnClaim).toBeNull();
        return reconciling;
      },
    };
    const stopTunnel = vi.fn(async () => {
      const placement = placements.get(SESSION_ID);
      teardownStates.push(`stop:${placement?.state ?? "missing"}`);
      expect(placement).toMatchObject({ state: "draining", turnClaim: null });
    });
    const destroy = vi.fn(async () => {
      teardownStates.push(`destroy:${placements.get(SESSION_ID)?.state ?? "missing"}`);
      return attachedEnvironment();
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(async () => {
          throw new Error("remote launch failed");
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
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements: observedPlacements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-failed",
        },
        turn("run-failed"),
        runLocal,
      ),
    ).rejects.toThrow("remote launch failed");
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({
      state: "failed",
      turnClaim: null,
      recoveryError: "remote launch failed",
    });
    expect(stopTunnel).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
    expect(destroy).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(teardownStates).toEqual([
      "stop:draining",
      "destroy:draining",
      "reconcile-before:draining",
      "reconcile-after:reconciling",
    ]);
  });

  it("keeps redacted process failure details on a valid UTF-16 boundary", async () => {
    seedActivePlacement();
    const secret = "$SUPERSECRET123";
    const redactedPrefix = "DISCORD_BOT_TOKEN=*** ";
    const padding = "a".repeat(399 - redactedPrefix.length);
    const retained = `${redactedPrefix}${padding}`;
    const emoji = String.fromCodePoint(0x1f600);
    const stderr = `DISCORD_BOT_TOKEN=${secret} ${padding}${emoji}tail`;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(
          async (): Promise<SpawnResult> => ({
            stdout: "",
            stderr,
            code: 1,
            signal: null,
            killed: false,
            termination: "exit",
          }),
        ),
        syncWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace sync");
        }),
        quiesceWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace quiescence");
        }),
        reconcileWorkspace: vi.fn(async () => {
          throw new Error("unexpected workspace reconciliation");
        }),
        stop: vi.fn(async () => {}),
      })),
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const failurePrefix = "Cloud worker process failed before completing the turn: ";
    let failure: unknown;

    try {
      await provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-process-failed",
        },
        turn("run-process-failed"),
        async () => ({ meta: { durationMs: 1 } }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toBe(`${failurePrefix}${retained}`);
    expect(message).not.toContain(secret);
    expect(hasLoneSurrogate(message)).toBe(false);
    const placement = placements.get(SESSION_ID);
    expect(placement).toMatchObject({ state: "failed", recoveryError: message, turnClaim: null });
    expect(hasLoneSurrogate(placement?.recoveryError ?? "")).toBe(false);
    expect(stopTunnel).toHaveBeenCalledWith(ENVIRONMENT_ID, OWNER_EPOCH);
    expect(destroy).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });

  it("waits before returning an actionable pending-result claim error", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const priorClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "prior-result-claim",
      runId: "prior-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.markWorkspaceResultPending(priorClaim);
    const waitForRelease = vi
      .spyOn(placements, "waitForTurnClaimRelease")
      .mockRejectedValue(new Error("timed out"));
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: priorClaim.runId,
        },
        turn(priorClaim.runId),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("already has an active turn claim");
    expect(waitForRelease).not.toHaveBeenCalled();

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "next-run",
        },
        turn("next-run"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow(
      "The previous cloud turn's workspace result is still reconciling; it retries automatically — try again shortly.",
    );
    expect(waitForRelease).toHaveBeenCalledWith(SESSION_ID, { timeoutMs: 15_000 });
  });

  it("retries admission when a collided claim releases before inspection", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const priorClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "released-before-inspection",
      runId: "prior-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    vi.spyOn(placements, "listPendingWorkspaceResults").mockImplementationOnce(() => {
      placements.releaseTurn(priorClaim);
      return [];
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "next-run",
        },
        turn("next-run"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("Active worker placement does not match its attached environment");
  });

  it("does not claim a stale worker after pending-result recovery reclaims it", async () => {
    seedActivePlacement();
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement");
    }
    const priorClaim = placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "reclaimed-result-claim",
      runId: "reclaimed-result-run",
      owner: {
        kind: "worker",
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      },
    });
    placements.markWorkspaceResultPending(priorClaim);
    vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementationOnce(async () => {
      placements.updateWorkspaceBaseManifest({ claim: priorClaim, manifestRef: MANIFEST_REF });
      placements.acceptWorkspaceResult(priorClaim);
      placements.completeWorkspaceResultAndReleaseTurn(priorClaim, { reclaim: true });
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "next-after-reclaim",
        },
        turn("next-after-reclaim"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow(
      "The previous cloud turn's workspace result is still reconciling; it retries automatically — try again shortly.",
    );
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("launches only one worker loop for concurrent admission of the same run", async () => {
    seedActivePlacement();
    const commandStarted = createDeferred();
    const commandFinished = createDeferred<{
      stdout: string;
      stderr: string;
      code: number;
      signal: null;
      killed: false;
      termination: "exit";
    }>();
    const launchTurn = vi.fn(() => {
      commandStarted.resolve();
      return commandFinished.promise;
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn,
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
    const claim = {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      runId: "run-overlap",
    };
    const first = provider.executeTurn(claim, turn("run-overlap"), async () => ({
      meta: { durationMs: 1 },
    }));
    await commandStarted.promise;

    await expect(
      provider.executeTurn(claim, turn("run-overlap"), async () => ({
        meta: { durationMs: 1 },
      })),
    ).rejects.toThrow("already has an active turn claim");
    expect(launchTurn).toHaveBeenCalledOnce();

    const completed = openSessionManager();
    const leafId = completed.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Only worker reply" }],
        timestamp: 31,
      }),
    );
    createWorkerSessionPlacementGate(placements).updateAckCursors({
      sessionId: SESSION_ID,
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      runId: "run-overlap",
      transcriptSeq: 2,
      liveSeq: 1,
    });
    const active = placements.get(SESSION_ID);
    if (active?.state !== "active") {
      throw new Error("expected active placement before drain race");
    }
    expect(() =>
      placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      }),
    ).toThrow("pending cloud workspace result");
    commandFinished.resolve({
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
    });
    await expect(first).resolves.toMatchObject({ payloads: [{ text: "Only worker reply" }] });
    const completedPlacement = placements.get(SESSION_ID);
    if (completedPlacement?.state !== "active") {
      throw new Error("expected active placement after worker completion");
    }
    placements.startDrain({
      sessionId: completedPlacement.sessionId,
      environmentId: completedPlacement.environmentId,
      ownerEpoch: completedPlacement.activeOwnerEpoch,
      expectedGeneration: completedPlacement.generation,
    });
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "draining", turnClaim: null });
  });

  it("keeps an active placement after an acknowledged turn failure and admits the next turn", async () => {
    seedActivePlacement();
    const turnIds: string[] = [];
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => attachedEnvironment());
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential(String(launchCount + 1).repeat(43))),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
          launchCount += 1;
          const descriptor = parseWorkerLaunchDescriptor(structuredClone(request.descriptor));
          turnIds.push(descriptor.assignment.turnId);
          if (launchCount === 1) {
            const completed = openSessionManager();
            const leafId = completed.appendMessage(
              makeAgentAssistantMessage({
                content: [{ type: "text", text: "Remote model failed" }],
                stopReason: "error",
                errorMessage: "Cloud worker turn failed",
                timestamp: 31,
              }),
            );
            createWorkerSessionPlacementGate(placements).updateAckCursors({
              sessionId: SESSION_ID,
              environmentId: ENVIRONMENT_ID,
              ownerEpoch: OWNER_EPOCH,
              runId: "run-model-failed",
              transcriptSeq: 2,
              liveSeq: 1,
            });
            return {
              stdout: JSON.stringify({
                status: "failed",
                reason: "turn-failed",
                transcriptLeafId: leafId,
                transcriptNextSeq: (placements.get(SESSION_ID)?.lastTranscriptAckCursor ?? 0) + 1,
              }),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          }
          const completed = openSessionManager();
          const leafId = completed.appendMessage(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "Recovered worker reply" }],
              timestamp: 41,
            }),
          );
          createWorkerSessionPlacementGate(placements).updateAckCursors({
            sessionId: SESSION_ID,
            environmentId: ENVIRONMENT_ID,
            ownerEpoch: OWNER_EPOCH,
            runId: "run-model-recovered",
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
      stopTunnel,
      destroy,
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-model-failed",
        },
        turn("run-model-failed"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).rejects.toThrow("Cloud worker turn failed");
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    expect(placements.listPendingWorkspaceResults()).toEqual([]);

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-model-recovered",
        },
        turn("run-model-recovered"),
        async () => ({ meta: { durationMs: 1 } }),
      ),
    ).resolves.toMatchObject({ payloads: [{ text: "Recovered worker reply" }] });
    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("redispatches a reclaimed placement before launching the worker turn", async () => {
    const reclaimed = seedReclaimedPlacement();
    const runId = "run-reclaimed-worker";
    const contextTtlMs = 30 * 60 * 1000;
    const registeredAt = Date.now();
    const admissionAt = registeredAt + contextTtlMs + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext(runId, {
      lifecycleGeneration,
      registeredAt,
      sessionKey: SESSION_KEY,
    });
    const releaseQueuedContext = retainQueuedAgentRunContext(runId, lifecycleGeneration);
    const redispatchEntered = createDeferred();
    const resumeRedispatch = createDeferred();
    const workerStarted = createDeferred();
    const resumeWorker = createDeferred();
    let redispatchCalls = 0;
    const redispatchReclaimed: NonNullable<
      WorkerTurnLauncherOptions["redispatchReclaimed"]
    > = async (placement) => {
      redispatchCalls += 1;
      expect(placement).toEqual(reclaimed);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      redispatchEntered.resolve();
      await resumeRedispatch.promise;
      seedActivePlacement();
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active redispatched placement");
      }
      return active;
    };
    const launchTurn = vi.fn(async (): Promise<SpawnResult> => {
      workerStarted.resolve();
      await resumeWorker.promise;
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: { owner: "worker", runId },
      });
      const completed = openSessionManager();
      const leafId = completed.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Redispatched worker reply" }],
          timestamp: 51,
        }),
      );
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        sessionId: SESSION_ID,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runId,
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
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        connectionEndpoint: { kind: "unix" as const, socketPath: "/worker/gateway.sock" },
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(),
        launchTurn,
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
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      redispatchReclaimed,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAdmitted = vi.fn(() => {
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: { owner: "worker", runId },
      });
      releaseQueuedContext?.("admitted");
    });
    const events: AgentEventPayload[] = [];
    const unsubscribe = subscribeAgentEvent((event) => events.push(event));
    const pending = provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
      turn(runId),
      runLocal,
      onAdmitted,
    );
    const result = await (async () => {
      try {
        await redispatchEntered.promise;
        clock.mockReturnValue(admissionAt);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(getAgentRunContext(runId)).toMatchObject({ lifecycleGeneration, registeredAt });
        expect(onAdmitted).not.toHaveBeenCalled();

        resumeRedispatch.resolve();
        await workerStarted.promise;
        expect(onAdmitted).toHaveBeenCalledOnce();
        expect(getAgentRunContext(runId)?.lastActiveAt).toBe(admissionAt);
        expect(runLocal).not.toHaveBeenCalled();

        clock.mockReturnValue(admissionAt + contextTtlMs + 1);
        expect(sweepStaleRunContexts()).toBe(0);
        expect(getAgentRunContext(runId)).toBeDefined();
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });

        clock.mockReturnValue(admissionAt);
        resumeWorker.resolve();
        return await pending;
      } finally {
        resumeRedispatch.resolve();
        resumeWorker.resolve();
        await pending.catch(() => {});
        unsubscribe();
        releaseQueuedContext?.("abandoned");
        clearAgentRunContext(runId);
        clock.mockRestore();
      }
    })();

    expect(events).toContainEqual(
      expect.objectContaining({
        runId,
        stream: "run_status",
        sessionKey: SESSION_KEY,
        agentId: "main",
        data: { phase: "provisioning_environment" },
      }),
    );
    expect(result.payloads).toEqual([{ text: "Redispatched worker reply" }]);
    expect(redispatchCalls).toBe(1);
    expect(launchTurn).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("releases a claimed worker turn when its admission callback fails", async () => {
    seedActivePlacement();
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runId = "run-admission-failed";
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const onAdmitted = vi.fn(() => {
      expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });
      throw new Error("worker admission callback failed");
    });

    await expect(
      provider.executeTurn(
        { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
        turn(runId),
        runLocal,
        onAdmitted,
      ),
    ).rejects.toThrow("worker admission callback failed");

    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("reclaims a rotated foreground run before an actual remote worker starts", async () => {
    seedActivePlacement();
    const runId = "run-rotated-worker";
    const sessionLane = `session:${runId}`;
    const globalLane = `global:${runId}`;
    const registeredAt = Date.now();
    const admissionAt = registeredAt + 30 * 60 * 1000 + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    let lifecycleGeneration = getAgentEventLifecycleGeneration();
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      ...turn(runId),
      lifecycleGeneration,
      trigger: "user",
    };
    registerAgentRunContext(runId, { lifecycleGeneration, registeredAt, sessionKey: SESSION_KEY });

    const remoteStarted = createDeferred();
    const finishRemote = createDeferred();
    const environments = unusedEnvironments();
    environments.get = vi.fn(() => attachedEnvironment());
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      workspaceOperations: {
        async run<T>(_environmentId: string, _operation: () => Promise<T>): Promise<T> {
          remoteStarted.resolve();
          await finishRemote.promise;
          throw new Error("remote lifecycle proof completed");
        },
      },
    });
    const uninstallPlacement = installSessionPlacementAdmissionProvider(provider);
    const controller = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => lifecycleGeneration,
      getParams: () => params,
      globalLane,
      initialQueuedLifecycleGeneration: lifecycleGeneration,
      sessionLane,
      setLifecycleGeneration: (generation) => {
        lifecycleGeneration = generation;
      },
      setParams: (next) => {
        params = next;
      },
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    setCommandLaneConcurrency(globalLane, 0);
    const pending = controller.enqueueSession(() => controller.enqueueGlobal(runLocal));

    try {
      for (
        let attempt = 0;
        attempt < 10 && getCommandLaneSnapshot(globalLane).queuedCount === 0;
        attempt++
      ) {
        await Promise.resolve();
      }
      expect(getCommandLaneSnapshot(globalLane).queuedCount).toBe(1);

      clock.mockReturnValue(admissionAt);
      const replacementGeneration = rotateAgentEventLifecycleGeneration();
      expect(sweepStaleRunContexts()).toBe(1);
      expect(getAgentRunContext(runId)).toBeUndefined();
      const versionBeforeAdmission = readAgentRunIndexVersion();

      setCommandLaneConcurrency(globalLane, 1);
      await remoteStarted.promise;
      expect(getAgentRunContext(runId)).toMatchObject({
        lifecycleGeneration: replacementGeneration,
        lastActiveAt: admissionAt,
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      expect(readAgentRunIndexVersion()).toBe(versionBeforeAdmission + 1);
      expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({ owner: "worker", runId });
      expect(runLocal).not.toHaveBeenCalled();

      finishRemote.resolve();
      await expect(pending).rejects.toThrow("remote lifecycle proof completed");
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      setCommandLaneConcurrency(globalLane, 1);
      finishRemote.resolve();
      uninstallPlacement();
      await pending.catch(() => {});
      clearAgentRunContext(runId);
      clock.mockRestore();
    }
  });

  it("rejects an actual worker turn when its lifecycle rotates during placement admission", async () => {
    seedActivePlacement();
    const runId = "run-worker-rotated-during-admission";
    const registeredAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(registeredAt);
    let lifecycleGeneration = getAgentEventLifecycleGeneration();
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      ...turn(runId),
      lifecycleGeneration,
      trigger: "user",
    };
    registerAgentRunContext(runId, { lifecycleGeneration, registeredAt, sessionKey: SESSION_KEY });

    const workspaceResolutionStarted = createDeferred();
    const resumeWorkspaceResolution = createDeferred();
    const environments = unusedEnvironments();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      resolveWorkspacePath: async () => {
        workspaceResolutionStarted.resolve();
        await resumeWorkspaceResolution.promise;
        return root;
      },
    });
    const uninstallPlacement = installSessionPlacementAdmissionProvider(provider);
    const controller = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => lifecycleGeneration,
      getParams: () => params,
      globalLane: `global:${runId}`,
      initialQueuedLifecycleGeneration: lifecycleGeneration,
      sessionLane: `session:${runId}`,
      setLifecycleGeneration: (generation) => {
        lifecycleGeneration = generation;
      },
      setParams: (next) => {
        params = next;
      },
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const pending = controller.enqueueSession(() => controller.enqueueGlobal(runLocal));

    try {
      await workspaceResolutionStarted.promise;
      clock.mockReturnValue(registeredAt + 30 * 60 * 1000 + 1);
      const replacementGeneration = rotateAgentEventLifecycleGeneration();
      expect(sweepStaleRunContexts()).toBe(1);
      registerAgentRunContext(runId, {
        lifecycleGeneration: replacementGeneration,
        registeredAt: Date.now(),
        sessionId: "replacement-session",
        sessionKey: "agent:main:replacement",
      });
      const versionBeforeRejectedAdmission = readAgentRunIndexVersion();

      resumeWorkspaceResolution.resolve();
      await expect(pending).rejects.toThrow("stale gateway lifecycle");
      expect(getAgentRunContext(runId)).toMatchObject({
        lifecycleGeneration: replacementGeneration,
        sessionId: "replacement-session",
        sessionKey: "agent:main:replacement",
      });
      expect(readAgentRunIndexVersion()).toBe(versionBeforeRejectedAdmission);
      expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      expect(environments.get).not.toHaveBeenCalled();
      expect(environments.startTunnel).not.toHaveBeenCalled();
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      resumeWorkspaceResolution.resolve();
      uninstallPlacement();
      await pending.catch(() => {});
      clearAgentRunContext(runId);
      clock.mockRestore();
    }
  });

  it("rejects a reclaimed placement when redispatch is unavailable", async () => {
    seedReclaimedPlacement();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-reclaimed-unavailable",
        },
        turn("run-reclaimed-unavailable"),
        runLocal,
      ),
    ).rejects.toThrow("Reclaimed worker placement requires redispatch");
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("does not fall back locally when reclaimed redispatch fails", async () => {
    seedReclaimedPlacement();
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
      redispatchReclaimed: async () => {
        throw new Error("reclaimed redispatch failed");
      },
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-reclaimed-failed",
        },
        turn("run-reclaimed-failed"),
        runLocal,
      ),
    ).rejects.toThrow("reclaimed redispatch failed");
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("rejects non-active placement without falling back to the local loop", async () => {
    placements.startDispatch({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      environments: unusedEnvironments(),
      placements,
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-requested",
        },
        turn("run-requested"),
        runLocal,
      ),
    ).rejects.toThrow("Worker turn rejected in placement requested");
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
