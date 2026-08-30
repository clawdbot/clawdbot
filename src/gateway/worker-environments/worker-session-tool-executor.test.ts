import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { readAgentRuntimeExecutionLineage } from "../agent-runtime-execution-lineage.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { bindWorkerTurnExecutionIdentity } from "./placement-turn-claim-events.js";
import { createWorkerSessionToolExecutor } from "./worker-session-tool-executor.js";

const sessionEntries = vi.hoisted(() => new Map<string, SessionEntry>());
const delivered = vi.hoisted(() => vi.fn());
const gatewayRequest = vi.hoisted(() => vi.fn());
const gatewayCreate = vi.hoisted(() => vi.fn());
const gatewayRuntimeIdentity = vi.hoisted(() => vi.fn());
const dispatchChild = vi.hoisted(() => vi.fn());
const spawnCallerIdentity = vi.hoisted(() => vi.fn());
const spawnArgs = vi.hoisted(() => vi.fn());
const githubPublicationRequest = vi.hoisted(() => vi.fn());
const resolveGatewayContext = () => undefined;
const scopedSessionAccess = vi.hoisted(() =>
  vi.fn(async (params: { run: () => Promise<unknown> }) => await params.run()),
);

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadGatewaySessionEntryReadOnly: (sessionKey: string) => ({
      agentId: parseAgentSessionKey(sessionKey)?.agentId,
      canonicalKey: sessionKey,
      entry: structuredClone(sessionEntries.get(sessionKey)),
    }),
  };
});

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: (options: unknown) => ({
    execute: async (toolCallId: string, args: unknown) => {
      await delivered({ args, options, toolCallId });
      return {
        content: [{ type: "text", text: "sent" }],
        details: { status: "ok" },
      };
    },
  }),
}));

vi.mock("../../agents/tools/sessions-spawn-tool.js", async () => {
  const { getGatewayToolCallerIdentity } =
    await import("../../agents/tools/gateway-caller-context.js");
  return {
    createSessionsSpawnTool: (options: {
      agentSessionKey: string;
      callGateway: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    }) => ({
      execute: async (_toolCallId: string, args: { task: string; worktree?: boolean }) => {
        spawnCallerIdentity(getGatewayToolCallerIdentity());
        spawnArgs(args);
        const details = await options.callGateway("sessions.create", {
          parentSessionKey: options.agentSessionKey,
          task: args.task,
          ...(args.worktree ? { worktree: true } : {}),
        });
        return {
          content: [{ type: "text", text: "spawned" }],
          details,
        };
      },
    }),
  };
});

vi.mock("../../agents/tools/scoped-session-access.js", () => ({
  runWithScopedSessionAccess: (params: unknown) => scopedSessionAccess(params as never),
}));

vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (request: unknown) => gatewayRequest(request),
  callInProcessGatewayTool: (method: string, params: Record<string, unknown>) =>
    gatewayRequest({ method, params }),
  callInProcessGatewayToolWithCreation: (
    method: string,
    params: Record<string, unknown>,
    creation: unknown,
    options: unknown,
  ) => gatewayCreate({ creation, method, options, params }),
  withAgentToolGatewayRuntimeIdentity: (request: unknown, identity: unknown) => {
    gatewayRuntimeIdentity(request, identity);
    return request;
  },
}));

const SOURCE = {
  agentId: "main",
  sessionId: "source-session",
  sessionKey: "agent:main:dashboard:source",
  environmentId: "source-environment",
  ownerEpoch: 3,
};
const TARGET = {
  agentId: "main",
  sessionId: "target-session",
  sessionKey: "agent:main:dashboard:target",
  environmentId: "target-environment",
  ownerEpoch: 4,
};
const PARENT = {
  sessionId: "parent-session",
  sessionKey: "agent:main:dashboard:parent",
};
const CHILD = {
  agentId: "main",
  sessionId: "spawned-child-session",
  environmentId: "spawned-child-environment",
  ownerEpoch: 5,
};
const GRANDCHILD = {
  agentId: "main",
  sessionId: "spawned-grandchild-session",
  environmentId: "spawned-grandchild-environment",
  ownerEpoch: 6,
};
const PARENT_EXECUTION_IDENTITY_TOKEN = {
  tokenVersion: 1,
  contextId: "parent-context",
  executionId: "parent-execution",
  runId: "source-run",
  createdAt: 1,
} satisfies ExecutionIdentityAdmissionToken;

describe("worker session tool topology", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;
  let identity: WorkerConnectionIdentity;
  let execute: ReturnType<typeof createWorkerSessionToolExecutor>;
  let sourceClaim: ReturnType<WorkerSessionPlacementStore["claimTurn"]>;
  let delegatedAuthorities: AgentRunDelegatedAuthority[];
  let childSessionKey: string | undefined;
  let spawnOrder: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-tools-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database });
    activate(SOURCE);
    activate(TARGET);
    sourceClaim = placements.claimTurn({
      sessionId: SOURCE.sessionId,
      agentId: SOURCE.agentId,
      sessionKey: SOURCE.sessionKey,
      claimId: "source-claim",
      runId: "source-run",
      owner: {
        kind: "worker",
        environmentId: SOURCE.environmentId,
        ownerEpoch: SOURCE.ownerEpoch,
      },
    });
    placements.authorizeWorkerTurnTools(sourceClaim, [
      "sessions_send",
      "sessions_spawn",
      "github_publish",
    ]);
    delegatedAuthorities = [];
    const sourceOperationalRun = createOperationalRunInstanceRef(sourceClaim.runId);
    delegatedAuthorities.push(claimAgentRunDelegatedAuthority(sourceOperationalRun));
    bindWorkerTurnExecutionIdentity(
      placements,
      sourceClaim,
      PARENT_EXECUTION_IDENTITY_TOKEN,
      sourceOperationalRun,
      { agentId: SOURCE.agentId, sessionKey: SOURCE.sessionKey },
    );
    identity = {
      environmentId: SOURCE.environmentId,
      credentialHash: "credential-hash",
      bundleHash: "a".repeat(64),
      sessionId: SOURCE.sessionId,
      runId: sourceClaim.runId,
      turnClaim: sourceClaim,
      ownerEpoch: SOURCE.ownerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-session-tools-v1"],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    sessionEntries.clear();
    delivered.mockReset();
    gatewayRequest.mockReset();
    gatewayCreate.mockReset();
    gatewayRuntimeIdentity.mockReset();
    dispatchChild.mockReset();
    spawnCallerIdentity.mockReset();
    spawnArgs.mockReset();
    githubPublicationRequest.mockReset();
    githubPublicationRequest.mockResolvedValue({
      requestId: "publication-1",
      status: "requested",
      message: "Publication was accepted.",
    });
    scopedSessionAccess.mockClear();
    childSessionKey = undefined;
    spawnOrder = [];
    gatewayCreate.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        spawnOrder.push("create");
        childSessionKey = String(request.params.key);
        setEntry(childSessionKey, CHILD.sessionId, {
          sessionKey: SOURCE.sessionKey,
          sessionId: SOURCE.sessionId,
        });
        return { ok: true, key: childSessionKey, sessionId: CHILD.sessionId };
      },
    );
    dispatchChild.mockImplementation(async (request: { sessionKey: string }) => {
      spawnOrder.push("dispatch");
      expect(placements.get(CHILD.sessionId)).toBeUndefined();
      activate({
        ...CHILD,
        sessionKey: request.sessionKey,
      });
      return placements.get(CHILD.sessionId);
    });
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          spawnOrder.push("send");
          expect(placements.get(CHILD.sessionId)?.state).toBe("active");
          return { runId: "spawned-child-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );
    execute = createWorkerSessionToolExecutor({
      resolveGatewayContext,
      placements,
      dispatchChild,
      githubPublication: { requestForClaim: githubPublicationRequest },
      portals: {
        getService: () => undefined,
        carrier: { open: vi.fn() },
        onChanged: vi.fn(),
      },
      environments: {
        get: (environmentId: string) => {
          if (environmentId === SOURCE.environmentId) {
            return {
              state: "attached",
              ownerEpoch: SOURCE.ownerEpoch,
              attachedSessionIds: [SOURCE.sessionId],
              providerId: "fake",
              profileId: "cloud-profile",
              profileSnapshot: { install: "bundle", settings: { region: "source" } },
            };
          }
          if (environmentId === CHILD.environmentId) {
            return {
              state: "attached",
              ownerEpoch: CHILD.ownerEpoch,
              attachedSessionIds: [CHILD.sessionId],
              providerId: "fake",
              profileId: "cloud-profile",
              profileSnapshot: { install: "bundle", settings: { region: "source" } },
            };
          }
          if (environmentId === GRANDCHILD.environmentId) {
            return {
              state: "attached",
              ownerEpoch: GRANDCHILD.ownerEpoch,
              attachedSessionIds: [GRANDCHILD.sessionId],
              providerId: "fake",
              profileId: "cloud-profile",
              profileSnapshot: { install: "bundle", settings: { region: "source" } },
            };
          }
          return undefined;
        },
      } as never,
    });
  });

  it("records publication intent with the exact claim and no credential fields", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);

    const result = await execute({
      identity,
      toolName: "github_publish",
      request: {
        toolCallId: "publish-cloud-work",
        title: "Publish the cloud fix",
      },
    });

    expect(JSON.parse(result.resultJson)).toMatchObject({
      details: { requestId: "publication-1", status: "requested" },
    });
    expect(githubPublicationRequest).toHaveBeenCalledWith({
      claim: sourceClaim,
      sessionKey: SOURCE.sessionKey,
      agentId: SOURCE.agentId,
      idempotencyKey: "publish-cloud-work",
      title: "Publish the cloud fix",
      assertCurrent: expect.any(Function),
    });
    expect(JSON.stringify(githubPublicationRequest.mock.calls)).not.toContain("token");
  });

  it("revalidates publication authority after awaited Gateway work", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    githubPublicationRequest.mockImplementationOnce(async (request) => {
      placements.closeWorkerTurnToolAdmission(sourceClaim);
      request.assertCurrent?.();
      return {
        requestId: "unreachable",
        status: "requested",
        message: "unreachable",
      };
    });

    await expect(
      execute({
        identity,
        toolName: "github_publish",
        request: { toolCallId: "publish-lost-authority" },
      }),
    ).rejects.toThrow("Worker session tool authority changed");
  });

  it("rejects publication when the exact turn was not granted the tool", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send"]);

    await expect(
      execute({
        identity,
        toolName: "github_publish",
        request: { toolCallId: "publish-without-authority" },
      }),
    ).rejects.toThrow("Worker session tool authority changed");
    expect(githubPublicationRequest).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    for (const authority of delegatedAuthorities) {
      releaseAgentRunDelegatedAuthority(authority);
    }
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function activate(session: {
    agentId: string;
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    sessionKey: string;
  }): void {
    let placement = placements.startDispatch(session);
    placement = placements.transition({
      sessionId: session.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: session.environmentId },
    });
    placement = placements.transition({
      sessionId: session.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = placements.transition({
      sessionId: session.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `manifest-${session.sessionId}`,
        remoteWorkspaceDir: `/workspace/${session.sessionId}`,
      },
    });
    placements.transition({
      sessionId: session.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: session.ownerEpoch },
    });
  }

  function setEntry(
    sessionKey: string,
    sessionId: string,
    parent?: { sessionKey: string; sessionId: string },
  ): void {
    sessionEntries.set(sessionKey, {
      sessionId,
      updatedAt: Date.now(),
      ...(parent ? { parentSessionKey: parent.sessionKey, parentSessionId: parent.sessionId } : {}),
    });
  }

  async function send(toolCallId: string) {
    return await execute({
      identity,
      toolName: "sessions_send",
      request: {
        toolCallId,
        sessionKey: TARGET.sessionKey,
        message: "status",
        timeoutSeconds: 0,
      },
    });
  }

  function spawn(toolCallId: string, task = "start the child") {
    return execute({ identity, toolName: "sessions_spawn", request: { toolCallId, task } });
  }

  it.each([false, true])(
    "creates and replays a cloud child with inherited required isolation (%s)",
    async (required) => {
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      const creator = { type: "human", id: "profile-worker-creator" } as const;
      Object.assign(sessionEntries.get(SOURCE.sessionKey)!, {
        createdActor: creator,
        ...(required ? { sandbox: "required" as const } : {}),
      });

      const first = await spawn("spawn-cloud-child", "run in the nested cloud session");
      const replay = await spawn("spawn-cloud-child", "run in the nested cloud session");

      expect(childSessionKey).toMatch(/^agent:main:dashboard:cloud-[a-f0-9]{32}$/u);
      expect(spawnOrder).toEqual(["create", "dispatch", "send"]);
      expect(gatewayCreate).toHaveBeenCalledOnce();
      expect(gatewayCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          creation: expect.objectContaining({
            actor: required ? creator : { type: "agent", id: SOURCE.agentId },
            requesterSessionKey: SOURCE.sessionKey,
            via: "spawn",
          }),
          method: "sessions.create",
          options: {
            resolveGatewayContext,
            sessionMutationCommitGuard: expect.any(Function),
            timeoutMs: null,
          },
          params: expect.not.objectContaining({ task: expect.anything() }),
        }),
      );
      expect(gatewayCreate.mock.calls[0]?.[0]?.creation?.sandbox).toBe(
        required ? "required" : undefined,
      );
      expect(dispatchChild).toHaveBeenCalledWith({
        sessionId: CHILD.sessionId,
        sessionKey: childSessionKey,
        agentId: CHILD.agentId,
        executionMode: "worker-turn",
        profileId: "cloud-profile",
        inheritedProfile: {
          providerId: "fake",
          profileSnapshot: { install: "bundle", settings: { region: "source" } },
        },
      });
      expect(gatewayRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentRunTracking: "native_subagent",
          method: "agent",
          params: expect.objectContaining({
            idempotencyKey: expect.stringMatching(/^worker-session-spawn:/u),
            message: "run in the nested cloud session",
            sessionId: CHILD.sessionId,
          }),
        }),
      );
      expect(spawnArgs).toHaveBeenCalledWith(
        expect.objectContaining({ expectsCompletionMessage: false, visible: true, worktree: true }),
      );
      expect(placements.get(CHILD.sessionId)?.state).toBe("active");
      expect(sessionEntries.get(childSessionKey!)).toMatchObject({
        sessionId: CHILD.sessionId,
        parentSessionKey: SOURCE.sessionKey,
        parentSessionId: SOURCE.sessionId,
      });
      expect(replay.resultJson).toBe(first.resultJson);
    },
  );

  it.each([
    { label: "default", mode: undefined },
    { label: "read-only", mode: "read-only" },
    { label: "guarded", mode: "guarded" },
    { label: "workspace", mode: "workspace" },
    { label: "full", mode: "full" },
  ] as const)("inherits the parent's $label permission mode in a cloud child", async ({ mode }) => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    if (mode) {
      sessionEntries.get(SOURCE.sessionKey)!.permissionMode = mode;
    }

    await spawn("spawn-cloud-child-with-permissions");

    const createParams = gatewayCreate.mock.calls[0]?.[0]?.params;
    expect(createParams).toMatchObject({ worktree: true });
    if (mode) {
      expect(createParams).toMatchObject({ permissionMode: mode });
    } else {
      expect(createParams).not.toHaveProperty("permissionMode");
    }
  });

  it("carries the exact admitted parent identity into a worker-hosted child spawn", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);

    await spawn("spawn-with-parent-identity");

    expect(spawnCallerIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: SOURCE.agentId,
        sessionKey: SOURCE.sessionKey,
        executionIdentityToken: PARENT_EXECUTION_IDENTITY_TOKEN,
        operationalRunInstance: expect.objectContaining({ runId: sourceClaim.runId }),
        receiptAuthority: expect.any(Function),
        workerTurnClaim: sourceClaim,
      }),
    );
    const runtimeIdentity = gatewayRuntimeIdentity.mock.calls[0]?.[1];
    expect(runtimeIdentity).toMatchObject({
      kind: "agentRuntime",
      agentId: SOURCE.agentId,
      sessionKey: SOURCE.sessionKey,
      executionIdentity: PARENT_EXECUTION_IDENTITY_TOKEN,
      operationalRunInstance: expect.objectContaining({ runId: sourceClaim.runId }),
      delegatedAuthority: expect.objectContaining({ kind: "worker", turnClaim: sourceClaim }),
      sessionSpawnContext: {
        inheritedToolPolicy: {
          version: 1,
          allow: ["sessions_spawn", "sessions_send", "github_publish"],
          deny: [],
        },
      },
    });
    expect(readAgentRuntimeExecutionLineage(runtimeIdentity?.sessionSpawnContext)).toMatchObject({
      relation: "sessions_spawn",
      requesterRef: SOURCE.sessionKey,
      controllerRef: SOURCE.sessionKey,
      depth: 1,
      externalNativeActions: "observable",
    });
    expect(JSON.stringify(gatewayRuntimeIdentity.mock.calls[0]?.[0])).not.toContain(
      PARENT_EXECUTION_IDENTITY_TOKEN.executionId,
    );
    expect(JSON.stringify(runtimeIdentity?.sessionSpawnContext)).not.toContain(SOURCE.sessionKey);
  });

  it("coalesces concurrent spawn retries into one cloud child", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    const create = gatewayCreate.getMockImplementation();
    if (!create) {
      throw new Error("missing session creation fixture");
    }
    let finishCreate: (() => void) | undefined;
    gatewayCreate.mockImplementation(async (request) => {
      await new Promise<void>((resolve) => {
        finishCreate = resolve;
      });
      return await create(request);
    });
    const retries = Array.from({ length: 32 }, () => spawn("concurrent-spawn"));
    await vi.waitFor(() => expect(gatewayCreate).toHaveBeenCalledOnce());
    finishCreate?.();
    const results = await Promise.all(retries);

    expect(new Set(results.map((result) => result.resultJson))).toHaveLength(1);
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(dispatchChild).toHaveBeenCalledOnce();
    expect(gatewayRequest).toHaveBeenCalledOnce();
  });

  it("recovers a committed child when session creation loses its response", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    gatewayCreate.mockImplementationOnce(
      async (request: { method: string; params: Record<string, unknown> }) => {
        spawnOrder.push("create");
        childSessionKey = String(request.params.key);
        setEntry(childSessionKey, CHILD.sessionId, {
          sessionKey: SOURCE.sessionKey,
          sessionId: SOURCE.sessionId,
        });
        throw new Error("session creation response was lost");
      },
    );
    const first = await spawn("spawn-response-loss");
    const replay = await spawn("spawn-response-loss");

    expect(spawnOrder).toEqual(["create", "dispatch", "send"]);
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(first.resultJson).not.toContain('"status":"error"');
    expect(replay.resultJson).toBe(first.resultJson);
  });

  it("recovers an active placement when cloud dispatch loses its response", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    dispatchChild.mockImplementationOnce(async (request: { sessionKey: string }) => {
      spawnOrder.push("dispatch");
      activate({
        ...CHILD,
        sessionKey: request.sessionKey,
      });
      throw new Error("cloud dispatch response was lost");
    });
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          spawnOrder.push("send");
          return { runId: "spawned-child-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );

    const result = await spawn("spawn-dispatch-response-loss");

    expect(result.resultJson).not.toContain('"status":"error"');
    expect(spawnOrder).toEqual(["create", "dispatch", "send"]);
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(placements.get(CHILD.sessionId)?.state).toBe("active");
  });

  it("replays a lost initial-task response with one stable downstream key", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    const sendKeys: string[] = [];
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          spawnOrder.push("send");
          sendKeys.push(String(request.params.idempotencyKey));
          if (sendKeys.length === 1) {
            throw new Error("initial task response was lost");
          }
          return { runId: "spawned-child-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );

    const result = await spawn("spawn-initial-task-response-loss");

    expect(result.resultJson).not.toContain('"status":"error"');
    expect(spawnOrder).toEqual(["create", "dispatch", "send", "send"]);
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[1]).toBe(sendKeys[0]);
  });

  it("spawns a grandchild from the child cloud turn and communicates across both levels", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await spawn("spawn-child-for-nesting");
    const spawnedChildKey = childSessionKey!;
    const childClaim = placements.claimTurn({
      sessionId: CHILD.sessionId,
      agentId: CHILD.agentId,
      sessionKey: spawnedChildKey,
      claimId: "child-claim",
      runId: "child-run",
      owner: {
        kind: "worker",
        environmentId: CHILD.environmentId,
        ownerEpoch: CHILD.ownerEpoch,
      },
    });
    placements.authorizeWorkerTurnTools(childClaim, ["sessions_spawn", "sessions_send"]);
    const childExecutionIdentityToken = {
      ...PARENT_EXECUTION_IDENTITY_TOKEN,
      contextId: "child-context",
      executionId: "child-execution",
      runId: childClaim.runId,
      createdAt: 2,
    } satisfies ExecutionIdentityAdmissionToken;
    const childOperationalRun = createOperationalRunInstanceRef(childClaim.runId);
    delegatedAuthorities.push(claimAgentRunDelegatedAuthority(childOperationalRun));
    bindWorkerTurnExecutionIdentity(
      placements,
      childClaim,
      childExecutionIdentityToken,
      childOperationalRun,
      { agentId: CHILD.agentId, sessionKey: spawnedChildKey },
    );
    const childIdentity: WorkerConnectionIdentity = {
      ...identity,
      environmentId: CHILD.environmentId,
      sessionId: CHILD.sessionId,
      runId: childClaim.runId,
      turnClaim: childClaim,
      ownerEpoch: CHILD.ownerEpoch,
    };
    let spawnedGrandchildKey: string | undefined;
    gatewayCreate.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        spawnedGrandchildKey = String(request.params.key);
        setEntry(spawnedGrandchildKey, GRANDCHILD.sessionId, {
          sessionKey: spawnedChildKey,
          sessionId: CHILD.sessionId,
        });
        return {
          ok: true,
          key: spawnedGrandchildKey,
          sessionId: GRANDCHILD.sessionId,
        };
      },
    );
    dispatchChild.mockImplementation(async (request: { sessionKey: string }) => {
      activate({ ...GRANDCHILD, sessionKey: request.sessionKey });
      return placements.get(GRANDCHILD.sessionId);
    });
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          return { runId: "spawned-grandchild-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );

    await execute({
      identity: childIdentity,
      toolName: "sessions_spawn",
      request: { toolCallId: "spawn-grandchild", task: "start the grandchild" },
    });
    expect(spawnCallerIdentity.mock.calls.map((call) => call[0]?.executionIdentityToken)).toEqual([
      PARENT_EXECUTION_IDENTITY_TOKEN,
      childExecutionIdentityToken,
    ]);
    expect(sessionEntries.get(spawnedGrandchildKey!)).toMatchObject({
      parentSessionKey: spawnedChildKey,
      parentSessionId: CHILD.sessionId,
      sessionId: GRANDCHILD.sessionId,
    });

    await execute({
      identity: childIdentity,
      toolName: "sessions_send",
      request: {
        toolCallId: "child-to-root",
        sessionKey: SOURCE.sessionKey,
        message: "child reporting to root",
      },
    });
    const grandchildClaim = placements.claimTurn({
      sessionId: GRANDCHILD.sessionId,
      agentId: GRANDCHILD.agentId,
      sessionKey: spawnedGrandchildKey!,
      claimId: "grandchild-claim",
      runId: "grandchild-run",
      owner: {
        kind: "worker",
        environmentId: GRANDCHILD.environmentId,
        ownerEpoch: GRANDCHILD.ownerEpoch,
      },
    });
    placements.authorizeWorkerTurnTools(grandchildClaim, ["sessions_send"]);
    await execute({
      identity: {
        ...identity,
        environmentId: GRANDCHILD.environmentId,
        sessionId: GRANDCHILD.sessionId,
        runId: grandchildClaim.runId,
        turnClaim: grandchildClaim,
        ownerEpoch: GRANDCHILD.ownerEpoch,
      },
      toolName: "sessions_send",
      request: {
        toolCallId: "grandchild-to-child",
        sessionKey: spawnedChildKey,
        message: "grandchild reporting to child",
      },
    });

    expect(delivered).toHaveBeenCalledTimes(2);
    expect(delivered.mock.calls.map((call) => call[0].args.sessionKey)).toEqual([
      SOURCE.sessionKey,
      spawnedChildKey,
    ]);
  });

  it("records an unprovable post-create incarnation as unknown and releases the claim", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    gatewayCreate.mockImplementationOnce(
      async (request: { method: string; params: Record<string, unknown> }) => {
        spawnOrder.push("create");
        childSessionKey = String(request.params.key);
        setEntry(childSessionKey, CHILD.sessionId, {
          sessionKey: "agent:main:dashboard:other-parent",
          sessionId: "other-parent-session",
        });
        throw new Error("session creation response was lost");
      },
    );
    const first = await spawn("spawn-unknown-owner");
    const replay = await spawn("spawn-unknown-owner");

    expect(first.resultJson).toContain("outcome is unknown");
    expect(replay.resultJson).toContain("prior operation outcome is unknown");
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(gatewayRequest).not.toHaveBeenCalled();
    expect(() => placements.releaseTurn(sourceClaim)).not.toThrow();
  });

  it("delivers only across exact live parent, child, and sibling incarnations", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    await expect(send("parent-to-child")).resolves.toBeDefined();

    setEntry(SOURCE.sessionKey, SOURCE.sessionId, {
      sessionKey: TARGET.sessionKey,
      sessionId: TARGET.sessionId,
    });
    setEntry(TARGET.sessionKey, TARGET.sessionId);
    await expect(send("child-to-parent")).resolves.toBeDefined();

    setEntry(PARENT.sessionKey, PARENT.sessionId);
    setEntry(SOURCE.sessionKey, SOURCE.sessionId, PARENT);
    setEntry(TARGET.sessionKey, TARGET.sessionId, PARENT);
    await expect(send("sibling-to-sibling")).resolves.toBeDefined();

    expect(delivered).toHaveBeenCalledTimes(3);
    expect(scopedSessionAccess).toHaveBeenCalledOnce();
    expect(scopedSessionAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedSessionId: PARENT.sessionId,
        targetSessionKey: PARENT.sessionKey,
      }),
    );
    expect(delivered).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ sessionKey: TARGET.sessionKey }),
        options: expect.objectContaining({
          expectedTargetSessionId: TARGET.sessionId,
          idempotencyKey: expect.stringMatching(/^worker-session-send:/u),
        }),
      }),
    );
  });

  it.each([
    { relation: "parent", placement: "unplaced" },
    { relation: "parent", placement: "local" },
    { relation: "sibling", placement: "unplaced" },
    { relation: "sibling", placement: "local" },
  ] as const)(
    "delivers to an authorized Gateway $relation with $placement placement",
    async ({ relation, placement }) => {
      setEntry(TARGET.sessionKey, TARGET.sessionId);
      setEntry(SOURCE.sessionKey, SOURCE.sessionId, relation === "parent" ? PARENT : TARGET);
      setEntry(PARENT.sessionKey, PARENT.sessionId, relation === "sibling" ? TARGET : undefined);
      if (placement === "local") {
        const claim = placements.claimTurn({
          ...PARENT,
          agentId: SOURCE.agentId,
          claimId: "gateway-target-claim",
          runId: "gateway-target-run",
          owner: { kind: "local" },
        });
        placements.releaseTurn(claim);
        expect(placements.get(PARENT.sessionId)?.state).toBe("local");
      } else {
        expect(placements.get(PARENT.sessionId)).toBeUndefined();
      }

      const result = await execute({
        identity,
        toolName: "sessions_send",
        request: {
          toolCallId: "send-to-gateway",
          sessionKey: PARENT.sessionKey,
          message: "Report the Gateway result",
          timeoutSeconds: 30,
        },
      });

      expect(JSON.parse(result.resultJson)).toMatchObject({ details: { status: "ok" } });
      expect(delivered).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          args: expect.objectContaining({ sessionKey: PARENT.sessionKey }),
          options: expect.objectContaining({ expectedTargetSessionId: PARENT.sessionId }),
        }),
      );
    },
  );

  it("deduplicates retries without collapsing distinct identical sends", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });

    const first = await send("identical-send-one");
    const replay = await send("identical-send-one");
    await send("identical-send-two");

    expect(replay.resultJson).toBe(first.resultJson);
    expect(delivered).toHaveBeenCalledTimes(2);
    const firstKey = (
      delivered.mock.calls[0]?.[0] as { options?: { idempotencyKey?: string } } | undefined
    )?.options?.idempotencyKey;
    const secondKey = (
      delivered.mock.calls[1]?.[0] as { options?: { idempotencyKey?: string } } | undefined
    )?.options?.idempotencyKey;
    expect(firstKey).toMatch(/^worker-session-send:/u);
    expect(secondKey).toMatch(/^worker-session-send:/u);
    expect(secondKey).not.toBe(firstKey);
  });

  it("coalesces concurrent retries into one message effect", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    let finishDelivery: (() => void) | undefined;
    delivered.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishDelivery = resolve;
        }),
    );

    const retries = Array.from({ length: 32 }, () => send("concurrent-retry"));
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    finishDelivery?.();
    const results = await Promise.all(retries);

    expect(new Set(results.map((result) => result.resultJson))).toHaveLength(1);
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("replays a completed send after the target incarnation changes", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });

    const first = await send("completed-before-target-replacement");
    setEntry(TARGET.sessionKey, "replacement-target", {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    const replay = await send("completed-before-target-replacement");

    expect(replay.resultJson).toBe(first.resultJson);
    expect(delivered).toHaveBeenCalledOnce();
  });

  it("records repeated downstream send failures as unknown instead of replayable failure", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    delivered.mockImplementation(() => {
      throw new Error("target send response was lost");
    });

    const first = await send("send-response-loss");
    const replay = await send("send-response-loss");

    expect(first.resultJson).toContain("outcome is unknown");
    expect(replay.resultJson).toContain("prior operation outcome is unknown");
    expect(delivered).toHaveBeenCalledTimes(2);
    expect(() => placements.releaseTurn(sourceClaim)).not.toThrow();
  });

  it("denies stale parent incarnations, parent-key reuse, self-send, and cross-tree targets", async () => {
    const denied = [
      {
        name: "stale-parent",
        sourceParent: PARENT,
        targetParent: PARENT,
        parentEntryId: "replacement-parent",
        error: "outside the authorized session tree",
      },
      {
        name: "parent-key-reuse",
        sourceParent: PARENT,
        targetParent: { ...PARENT, sessionId: "other-parent" },
        parentEntryId: PARENT.sessionId,
        error: "outside the authorized session tree",
      },
      {
        name: "cross-tree",
        sourceParent: PARENT,
        targetParent: { sessionKey: "agent:main:dashboard:other", sessionId: "other-parent" },
        parentEntryId: PARENT.sessionId,
        error: "outside the authorized session tree",
      },
    ];
    for (const testCase of denied) {
      sessionEntries.clear();
      setEntry(PARENT.sessionKey, testCase.parentEntryId);
      setEntry(SOURCE.sessionKey, SOURCE.sessionId, testCase.sourceParent);
      setEntry(TARGET.sessionKey, TARGET.sessionId, testCase.targetParent);
      const result = await send(testCase.name);
      expect(result.resultJson).toContain(testCase.error);
    }

    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    const selfSend = await execute({
      identity,
      toolName: "sessions_send",
      request: {
        toolCallId: "self-send",
        sessionKey: SOURCE.sessionKey,
        message: "status",
      },
    });
    expect(selfSend.resultJson).toContain("not an exact live session");
    expect(delivered).not.toHaveBeenCalled();
  });

  it.each(["target", "shared parent"] as const)(
    "denies a replaced %s incarnation after awaiting sibling admission",
    async (replaced) => {
      setEntry(PARENT.sessionKey, PARENT.sessionId);
      setEntry(SOURCE.sessionKey, SOURCE.sessionId, PARENT);
      setEntry(TARGET.sessionKey, TARGET.sessionId, PARENT);
      scopedSessionAccess.mockImplementationOnce(async (params) => {
        if (replaced === "target") {
          setEntry(TARGET.sessionKey, "replacement-target", PARENT);
          activate({ ...TARGET, sessionId: "replacement-target" });
        } else {
          setEntry(PARENT.sessionKey, "replacement-parent");
        }
        return await params.run();
      });

      const result = await send("replaced-during-admission");
      expect(result.resultJson).toContain(
        replaced === "target"
          ? "target incarnation changed"
          : "outside the authorized session tree",
      );
      expect(delivered).not.toHaveBeenCalled();
    },
  );
});
