import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import type { MintedWorkerCredential } from "./credential.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import { createWorkerSessionTurnPlacementProvider } from "./worker-turn-launcher.js";

type WorkerTurnLauncherOptions = Parameters<typeof createWorkerSessionTurnPlacementProvider>[0];
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
  let root: string;
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;
  let sessionFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-turn-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database });
    const manager = SessionManager.create(path.join(root, "sessions"), path.join(root, "sessions"));
    const file = manager.getSessionFile();
    if (!file) {
      throw new Error("expected file-backed session manager");
    }
    sessionFile = file;
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function seedActivePlacement(): void {
    let placement = placements.startDispatch({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
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
      bootstrapReceipt: {
        bundleHash: BUNDLE_HASH,
        openclawVersion: "2026.7.2",
        protocolFeatures: [],
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

  function turn(runId = "run-worker-turn") {
    return {
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      sessionFile,
      workspaceDir: root,
      prompt: "Inspect this workspace",
      timeoutMs: 5_000,
      runId,
      provider: "openai",
      model: "gpt-test",
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-test": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
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

  it("launches the active worker with projected history and releases its claim", async () => {
    seedActivePlacement();
    const manager = SessionManager.open(sessionFile);
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
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      remoteSocketPath: "/worker/gateway.sock",
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
      runWorkspaceCommand: vi.fn(async (command): Promise<SpawnResult> => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "worker",
          runId: "run-worker-turn",
          ownerEpoch: OWNER_EPOCH,
        });
        descriptor = parseWorkerLaunchDescriptor(JSON.parse(command.input ?? ""));
        expect(command.argv).toEqual([
          "sh",
          "-c",
          'exec node "$HOME/.openclaw-worker/$1/openclaw.mjs" worker',
          "openclaw-worker",
          BUNDLE_HASH,
        ]);
        expect(command.argv.join(" ")).not.toContain(credential().credential);
        await Promise.resolve();
        expect(acknowledgeCredentialDelivery).toHaveBeenCalledOnce();
        const completed = SessionManager.open(sessionFile);
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
          transcriptSeq: 1,
          workspaceResultPending: true,
        });
        return {
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: leafId,
            transcriptNextSeq: 2,
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
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      destroy: vi.fn(async () => attachedEnvironment()),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    const result = await provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-worker-turn",
      },
      { ...turn(), transcriptPrompt: "Canonical transcript request" },
      runLocal,
    );

    expect(runLocal).not.toHaveBeenCalled();
    expect(result.payloads).toEqual([{ text: "Worker reply" }]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(descriptor?.assignment.prompt).toBe("Inspect this workspace");
    expect(descriptor?.assignment.suppressPromptTranscript).toBe(true);
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
      SessionManager.open(sessionFile)
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
        ),
    ).toContainEqual([{ type: "text", text: "Canonical transcript request" }]);
  });

  it("does not replay an already-persisted current user message into worker history", async () => {
    seedActivePlacement();
    const manager = SessionManager.open(sessionFile);
    manager.appendMessage(makeAgentUserMessage({ content: "Earlier request", timestamp: 18 }));
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier reply" }],
        timestamp: 19,
      }),
    );
    manager.appendMessage(
      makeAgentUserMessage({ content: "Inspect this workspace", timestamp: 20 }),
    );
    let descriptor: WorkerLaunchDescriptor | undefined;
    const tunnel: WorkerTunnelHandle = {
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: OWNER_EPOCH,
      remoteSocketPath: "/worker/gateway.sock",
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      runWorkspaceCommand: vi.fn(async (command): Promise<SpawnResult> => {
        descriptor = parseWorkerLaunchDescriptor(JSON.parse(command.input ?? ""));
        const completed = SessionManager.open(sessionFile);
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
          transcriptSeq: 1,
          workspaceResultPending: true,
        });
        return {
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: leafId,
            transcriptNextSeq: 2,
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
      get: vi.fn(() => attachedEnvironment()),
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
        suppressNextUserMessagePersistence: true,
      },
      async () => ({ meta: { durationMs: 1 } }),
    );

    expect(descriptor?.assignment.prompt).toBe("Inspect this workspace");
    expect(descriptor?.assignment.initialMessages).toMatchObject([
      { role: "user" },
      { role: "assistant" },
    ]);
    const persistedEntries = (await fs.readFile(sessionFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
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

  it("reports canonical multi-call usage and the terminal provider model", async () => {
    seedActivePlacement();
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => attachedEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(() => true),
      startTunnel: vi.fn(async () => ({
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        remoteSocketPath: "/worker/gateway.sock",
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(async (): Promise<SpawnResult> => {
          const completed = SessionManager.open(sessionFile);
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
            transcriptSeq: 1,
            workspaceResultPending: true,
          });
          return {
            stdout: JSON.stringify({
              status: "completed",
              transcriptLeafId: leafId,
              transcriptNextSeq: 2,
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
        total: 270,
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
        throw new Error("tunnel unavailable");
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
    ).rejects.toThrow("tunnel unavailable");

    expect(runLocal).not.toHaveBeenCalled();
    expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
    expect(stopTunnel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });

  it("preserves a terminal workspace result when the worker child later exits nonzero", async () => {
    seedActivePlacement();
    const destroy = vi.fn(async () => attachedEnvironment());
    const runWorkspaceCommand = vi.fn(async (): Promise<SpawnResult> => {
      createWorkerSessionPlacementGate(placements).updateAckCursors({
        sessionId: SESSION_ID,
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runId: "run-terminal-child-failure",
        liveSeq: 1,
        workspaceResultPending: true,
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
        remoteSocketPath: "/worker/gateway.sock",
        quiesceWorkspace: vi.fn(),
        runWorkspaceCommand,
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

    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
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
        remoteSocketPath: "/worker/gateway.sock",
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(async () => {
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
        remoteSocketPath: "/worker/gateway.sock",
        runWorkspaceCommand: vi.fn(
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
    const runWorkspaceCommand = vi.fn(() => {
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
        remoteSocketPath: "/worker/gateway.sock",
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand,
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
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();

    const completed = SessionManager.open(sessionFile);
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
      transcriptSeq: 1,
      workspaceResultPending: true,
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
        transcriptNextSeq: 2,
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
        remoteSocketPath: "/worker/gateway.sock",
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand: vi.fn(async (command): Promise<SpawnResult> => {
          launchCount += 1;
          const descriptor = parseWorkerLaunchDescriptor(JSON.parse(command.input ?? ""));
          turnIds.push(descriptor.assignment.turnId);
          if (launchCount === 1) {
            return {
              stdout: JSON.stringify({ status: "failed", reason: "turn-failed" }),
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            };
          }
          const completed = SessionManager.open(sessionFile);
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
            transcriptSeq: 1,
            workspaceResultPending: true,
          });
          return {
            stdout: JSON.stringify({
              status: "completed",
              transcriptLeafId: leafId,
              transcriptNextSeq: 2,
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
    let redispatchCalls = 0;
    const redispatchReclaimed: NonNullable<
      WorkerTurnLauncherOptions["redispatchReclaimed"]
    > = async (placement) => {
      redispatchCalls += 1;
      expect(placement).toEqual(reclaimed);
      expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      seedActivePlacement();
      const active = placements.get(SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active redispatched placement");
      }
      return active;
    };
    const runWorkspaceCommand = vi.fn(async (): Promise<SpawnResult> => {
      expect(placements.get(SESSION_ID)).toMatchObject({
        state: "active",
        turnClaim: { owner: "worker", runId },
      });
      const completed = SessionManager.open(sessionFile);
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
        transcriptSeq: 1,
        workspaceResultPending: true,
      });
      return {
        stdout: JSON.stringify({
          status: "completed",
          transcriptLeafId: leafId,
          transcriptNextSeq: 2,
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
        remoteSocketPath: "/worker/gateway.sock",
        quiesceWorkspace: vi.fn(async () => ({
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {}),
        })),
        runWorkspaceCommand,
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

    const result = await provider.executeTurn(
      { sessionId: SESSION_ID, sessionKey: SESSION_KEY, agentId: "main", runId },
      turn(runId),
      runLocal,
    );

    expect(result.payloads).toEqual([{ text: "Redispatched worker reply" }]);
    expect(redispatchCalls).toBe(1);
    expect(runWorkspaceCommand).toHaveBeenCalledOnce();
    expect(runLocal).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
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
