import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerConnectRequestFrameSchema } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { saveMediaBuffer } from "../../media/store.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import {
  buildWorkerConnectParams,
  completeWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import {
  createAgentRuntimeApprovalAuthorityValidator,
  verifyAgentRuntimeIdentityToken,
} from "../agent-runtime-identity-token.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  browserEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setWorkerTurnAdmissionCleanup,
  setWorkerTurnSessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn launcher remote handoff", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("round-trips the stored bootstrap receipt while reporting keep-local conflicts", async () => {
    let admissionWork: ExecutionIdentityAdmissionWork | undefined;
    setWorkerTurnAdmissionCleanup(
      configureExecutionIdentityAdmissionSink((work) => {
        admissionWork = work;
        return true;
      }),
    );
    setWorkerTurnSessionTarget({
      ...sessionTarget,
      agentId: "worker-agent",
      sessionKey: "agent:worker-agent:worker-turn",
    });
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
    const environment = browserEnvironment();
    const bootstrapReceipt = environment.bootstrapReceipt;
    if (!bootstrapReceipt) {
      throw new Error("expected bootstrap receipt");
    }
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
      measureLaunchTurn,
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "worker",
          runId: "run-worker-turn",
          ownerEpoch: OWNER_EPOCH,
        });
        descriptor = completeWorkerLaunchDescriptor(structuredClone(request.plan), {
          kind: "unix",
          socketPath: "/worker/gateway.sock",
        });
        const connectFrame = {
          type: "req" as const,
          id: "launch-validation",
          method: "connect" as const,
          params: buildWorkerConnectParams(descriptor),
        };
        expect(Value.Check(WorkerConnectRequestFrameSchema, connectFrame)).toBe(true);
        expect(descriptor.admission.handshake).toEqual({
          bundleHash: bootstrapReceipt.bundleHash,
          openclawVersion: bootstrapReceipt.openclawVersion,
          protocolFeatures: bootstrapReceipt.protocolFeatures,
        });
        expect(descriptor.admission.handshake).not.toHaveProperty("installKind");
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
        expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
        request.onDispatchReady?.();
        expect(acknowledgeCredentialDelivery).toHaveBeenCalledOnce();
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
      syncWorkspace: vi.fn(async () => {
        throw new Error("unexpected workspace sync");
      }),
      reconcileWorkspace,
      stop: vi.fn(async () => {}),
    };
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => environment),
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
    expect(descriptor?.version).toBe(4);
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
    const remote = path.join(await realpath(root), "remote");
    await mkdir(remote);
    seedActivePlacement("worker-turn", remote);
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      mimeType: "image/png",
    };
    const inlineImages = [
      { ...image, sourceIndex: 0 },
      { ...image, sourceIndex: 2 },
    ];
    const savedImage = await saveMediaBuffer(
      Buffer.from(image.data, "base64"),
      "image/png",
      "inbound",
      5_000,
      "offloaded.png",
    );
    const imagePath = savedImage.path;
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
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
      })),
      runWorkspaceCommand: vi.fn(
        async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5_000,
            signal: command.signal,
          }),
      ),
      measureLaunchTurn,
      stageAttachments: vi.fn(async () => {}),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        descriptor = completeWorkerLaunchDescriptor(structuredClone(request.plan), {
          kind: "unix",
          socketPath: "/worker/gateway.sock",
        });
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
        images: inlineImages,
        imageOrder: ["inline", "offloaded", "inline"],
        media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
      },
      async () => ({ meta: { durationMs: 1 } }),
    );

    expect(descriptor?.assignment.prompt).toEqual([
      { type: "text", text: expect.stringContaining("Inspect this workspace") },
      image,
      image,
      image,
    ]);
    expect(JSON.stringify(descriptor?.assignment.prompt)).toContain(
      "media/inbound/openclaw-staged-",
    );
    expect(tunnel.stageAttachments).toHaveBeenCalledOnce();
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
});
