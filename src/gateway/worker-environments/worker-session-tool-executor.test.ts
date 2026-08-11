import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerSessionToolExecutor } from "./worker-session-tool-executor.js";

const sessionEntries = vi.hoisted(() => new Map<string, SessionEntry>());
const delivered = vi.hoisted(() => vi.fn());
const gatewayRequest = vi.hoisted(() => vi.fn());
const gatewayCreate = vi.hoisted(() => vi.fn());
const dispatchChild = vi.hoisted(() => vi.fn());
const scopedSessionAccess = vi.hoisted(() =>
  vi.fn(async (params: { run: () => Promise<unknown> }) => await params.run()),
);

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntryReadOnly: (sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: structuredClone(sessionEntries.get(sessionKey)),
    }),
  };
});

vi.mock("../../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: (options: unknown) => ({
    execute: async (toolCallId: string, args: unknown) => {
      delivered({ args, options, toolCallId });
      return {
        content: [{ type: "text", text: "sent" }],
        details: { status: "ok" },
      };
    },
  }),
}));

vi.mock("../../agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: (options: {
    agentSessionKey: string;
    callGateway: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }) => ({
    execute: async (_toolCallId: string, args: { task: string }) => {
      const details = await options.callGateway("sessions.create", {
        parentSessionKey: options.agentSessionKey,
        task: args.task,
      });
      return {
        content: [{ type: "text", text: "spawned" }],
        details,
      };
    },
  }),
}));

vi.mock("../../agents/tools/scoped-session-access.js", () => ({
  runWithScopedSessionAccess: (params: unknown) => scopedSessionAccess(params as never),
}));

vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: (request: unknown) => gatewayRequest(request),
  callInProcessGatewayToolWithCreation: (
    method: string,
    params: Record<string, unknown>,
    creation: unknown,
  ) => gatewayCreate({ creation, method, params }),
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

describe("worker session tool topology", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let placements: WorkerSessionPlacementStore;
  let identity: WorkerConnectionIdentity;
  let execute: ReturnType<typeof createWorkerSessionToolExecutor>;
  let sourceClaim: ReturnType<WorkerSessionPlacementStore["claimTurn"]>;
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
    placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send", "sessions_spawn"]);
    identity = {
      environmentId: SOURCE.environmentId,
      credentialHash: "credential-hash",
      bundleHash: "a".repeat(64),
      sessionId: SOURCE.sessionId,
      runId: sourceClaim.runId,
      ownerEpoch: SOURCE.ownerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-session-tools-v1"],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    sessionEntries.clear();
    delivered.mockReset();
    gatewayRequest.mockReset();
    gatewayCreate.mockReset();
    dispatchChild.mockReset();
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
        if (request.method === "chat.send") {
          spawnOrder.push("send");
          expect(placements.get(CHILD.sessionId)?.state).toBe("active");
          return { runId: "spawned-child-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );
    execute = createWorkerSessionToolExecutor({
      placements,
      dispatchChild,
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

  afterEach(async () => {
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

  it("creates no local turn, awaits active cloud placement, then sends the initial task once", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);

    const request = {
      identity,
      toolName: "sessions_spawn" as const,
      request: {
        toolCallId: "spawn-cloud-child",
        task: "run in the nested cloud session",
      },
    };
    const first = await execute(request);
    const replay = await execute(request);

    expect(spawnOrder).toEqual(["create", "dispatch", "send"]);
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(gatewayCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.create",
        params: expect.not.objectContaining({ task: expect.anything() }),
      }),
    );
    expect(dispatchChild).toHaveBeenCalledWith({
      sessionId: CHILD.sessionId,
      sessionKey: childSessionKey,
      agentId: CHILD.agentId,
      profileId: "cloud-profile",
      inheritedProfile: {
        providerId: "fake",
        profileSnapshot: { install: "bundle", settings: { region: "source" } },
      },
    });
    expect(gatewayRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "chat.send",
        params: expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^worker-session-spawn:/u),
          message: "run in the nested cloud session",
          sessionId: CHILD.sessionId,
        }),
      }),
    );
    expect(placements.get(CHILD.sessionId)?.state).toBe("active");
    expect(sessionEntries.get(childSessionKey!)).toMatchObject({
      sessionId: CHILD.sessionId,
      parentSessionKey: SOURCE.sessionKey,
      parentSessionId: SOURCE.sessionId,
    });
    expect(replay.resultJson).toBe(first.resultJson);
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
    const request = {
      identity,
      toolName: "sessions_spawn" as const,
      request: {
        toolCallId: "spawn-response-loss",
        task: "continue after ambiguous session creation",
      },
    };

    const first = await execute(request);
    const replay = await execute(request);

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
        if (request.method === "chat.send") {
          spawnOrder.push("send");
          return { runId: "spawned-child-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );

    const result = await execute({
      identity,
      toolName: "sessions_spawn",
      request: {
        toolCallId: "spawn-dispatch-response-loss",
        task: "continue after ambiguous cloud dispatch",
      },
    });

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
        if (request.method === "chat.send") {
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

    const result = await execute({
      identity,
      toolName: "sessions_spawn",
      request: {
        toolCallId: "spawn-initial-task-response-loss",
        task: "continue exactly once after response loss",
      },
    });

    expect(result.resultJson).not.toContain('"status":"error"');
    expect(spawnOrder).toEqual(["create", "dispatch", "send", "send"]);
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[1]).toBe(sendKeys[0]);
  });

  it("spawns a grandchild from the child cloud turn and communicates across both levels", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await execute({
      identity,
      toolName: "sessions_spawn",
      request: { toolCallId: "spawn-child-for-nesting", task: "start the child" },
    });
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
    const childIdentity: WorkerConnectionIdentity = {
      ...identity,
      environmentId: CHILD.environmentId,
      sessionId: CHILD.sessionId,
      runId: childClaim.runId,
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
        if (request.method === "chat.send") {
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
    const request = {
      identity,
      toolName: "sessions_spawn" as const,
      request: {
        toolCallId: "spawn-unknown-owner",
        task: "do not replay an unowned child",
      },
    };

    const first = await execute(request);
    const replay = await execute(request);

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

  it("denies a target key rebound to a replacement session id", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, "replacement-target", {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });

    const result = await send("stale-target");
    expect(result.resultJson).toContain("not an active cloud session incarnation");
    expect(delivered).not.toHaveBeenCalled();
  });
});
