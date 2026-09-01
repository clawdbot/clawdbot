import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import type { SessionEntry } from "../../config/sessions.js";
import { claimAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { readAgentRuntimeExecutionLineage } from "../agent-runtime-execution-lineage.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import * as environmentServiceModule from "./service.js";
import {
  SOURCE,
  CHILD,
  GRANDCHILD,
  PARENT_EXECUTION_IDENTITY_TOKEN,
  resolveGatewayContext,
  installWorkerSessionToolTestFixture,
} from "./worker-session-tool-executor.test-support.js";

const sessionEntries = vi.hoisted(() => new Map<string, SessionEntry>());
const delivered = vi.hoisted(() => vi.fn());
const gatewayRequest = vi.hoisted(() => vi.fn());
const gatewayCreate = vi.hoisted(() => vi.fn());
const gatewayRuntimeIdentity = vi.hoisted(() => vi.fn());
const dispatchChild = vi.hoisted(() => vi.fn());
const spawnCallerIdentity = vi.hoisted(() => vi.fn());
const spawnArgs = vi.hoisted(() => vi.fn());
const githubPublicationRequest = vi.hoisted(() => vi.fn());
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

const fixtureMocks = {
  sessionEntries,
  delivered,
  gatewayRequest,
  gatewayCreate,
  gatewayRuntimeIdentity,
  dispatchChild,
  spawnCallerIdentity,
  spawnArgs,
  githubPublicationRequest,
  scopedSessionAccess,
};

describe("worker session tool topology", () => {
  const getFixture = installWorkerSessionToolTestFixture(fixtureMocks);
  let placements: ReturnType<typeof getFixture>["placements"];
  let identity: ReturnType<typeof getFixture>["identity"];
  let execute: ReturnType<typeof getFixture>["execute"];
  let sourceClaim: ReturnType<typeof getFixture>["sourceClaim"];
  let delegatedAuthorities: ReturnType<typeof getFixture>["delegatedAuthorities"];
  let spawnState: ReturnType<typeof getFixture>["spawnState"];
  let activate: ReturnType<typeof getFixture>["activate"];
  let setEntry: ReturnType<typeof getFixture>["setEntry"];
  let spawn: ReturnType<typeof getFixture>["spawn"];

  beforeEach(() => {
    resetGlobalHookRunner();
    ({
      placements,
      identity,
      execute,
      sourceClaim,
      delegatedAuthorities,
      spawnState,
      activate,
      setEntry,
      spawn,
    } = getFixture());
  });

  afterEach(() => resetGlobalHookRunner());

  it("blocks a worker spawn before child effects and replays the decision", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    const receipts: DecisionReceiptV1[] = [];
    const clearReceipts = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const beforeToolCall = vi.fn(() => ({
      block: true,
      blockReason: "blocked by worker session policy",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", matcher: ["sessions_spawn"], handler: beforeToolCall },
      ]),
    );

    const [first, replay] = await (async () => {
      try {
        return [await spawn("blocked-worker-spawn"), await spawn("blocked-worker-spawn")] as const;
      } finally {
        clearReceipts();
      }
    })();

    expect(replay.resultJson).toBe(first.resultJson);
    expect(JSON.parse(first.resultJson)).toMatchObject({
      details: { status: "blocked", reason: "blocked by worker session policy" },
    });
    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      contextId: PARENT_EXECUTION_IDENTITY_TOKEN.contextId,
      executionId: PARENT_EXECUTION_IDENTITY_TOKEN.executionId,
      runId: PARENT_EXECUTION_IDENTITY_TOKEN.runId,
      action: { family: "plugin", operation: "before_tool_call" },
      decision: { outcome: "denied", reasonCode: "plugin_hook_blocked" },
      enforcement: { coverageState: "enforced" },
      source: { owner: "plugin-hook" },
    });
    expect(gatewayCreate).not.toHaveBeenCalled();
    expect(dispatchChild).not.toHaveBeenCalled();
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it("blocks an invalid worker policy rewrite before child effects", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          matcher: ["sessions_spawn"],
          handler: async () => ({ params: { task: "" } }),
        },
      ]),
    );

    const result = await spawn("invalid-worker-policy-rewrite");

    expect(JSON.parse(result.resultJson)).toMatchObject({
      details: {
        status: "blocked",
        reason: "Tool call blocked because before_tool_call returned invalid sessions_spawn input.",
      },
    });
    expect(gatewayCreate).not.toHaveBeenCalled();
    expect(dispatchChild).not.toHaveBeenCalled();
    expect(gatewayRequest).not.toHaveBeenCalled();
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

      expect(spawnState.childSessionKey).toMatch(/^agent:main:dashboard:cloud-[a-f0-9]{32}$/u);
      expect(spawnState.order).toEqual(["create", "dispatch", "send"]);
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
      expect(dispatchChild).toHaveBeenCalledWith(
        {
          sessionId: CHILD.sessionId,
          sessionKey: spawnState.childSessionKey,
          agentId: CHILD.agentId,
          executionMode: "worker-turn",
          profileId: "cloud-profile",
          inheritedProfile: {
            providerId: "fake",
            profileSnapshot: { install: "bundle", settings: { region: "source" } },
          },
        },
        undefined,
        expect.any(Function),
      );
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
      expect(sessionEntries.get(spawnState.childSessionKey!)).toMatchObject({
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
        spawnState.order.push("create");
        spawnState.childSessionKey = String(request.params.key);
        setEntry(spawnState.childSessionKey, CHILD.sessionId, {
          sessionKey: SOURCE.sessionKey,
          sessionId: SOURCE.sessionId,
        });
        throw new Error("session creation response was lost");
      },
    );
    const first = await spawn("spawn-response-loss");
    const replay = await spawn("spawn-response-loss");

    expect(spawnState.order).toEqual(["create", "dispatch", "send"]);
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(first.resultJson).not.toContain('"status":"error"');
    expect(replay.resultJson).toBe(first.resultJson);
  });

  it("recovers an active placement when cloud dispatch loses its response", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    dispatchChild.mockImplementationOnce(async (request: { sessionKey: string }) => {
      spawnState.order.push("dispatch");
      activate({
        ...CHILD,
        sessionKey: request.sessionKey,
      });
      throw new Error("cloud dispatch response was lost");
    });
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          spawnState.order.push("send");
          return { runId: "spawned-child-run", status: "accepted" };
        }
        throw new Error(`Unexpected gateway request: ${request.method}`);
      },
    );

    const result = await spawn("spawn-dispatch-response-loss");

    expect(result.resultJson).not.toContain('"status":"error"');
    expect(spawnState.order).toEqual(["create", "dispatch", "send"]);
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(placements.get(CHILD.sessionId)?.state).toBe("active");
  });

  it("replays a lost initial-task response with one stable downstream key", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    const sendKeys: string[] = [];
    gatewayRequest.mockImplementation(
      async (request: { method: string; params: Record<string, unknown> }) => {
        if (request.method === "agent") {
          spawnState.order.push("send");
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
    expect(spawnState.order).toEqual(["create", "dispatch", "send", "send"]);
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[1]).toBe(sendKeys[0]);
  });

  it("spawns a grandchild from the child cloud turn and communicates across both levels", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await spawn("spawn-child-for-nesting");
    const spawnedChildKey = spawnState.childSessionKey!;
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
    bindWorkerTurnOwner(
      placements,
      childClaim,
      childExecutionIdentityToken,
      childOperationalRun,
      {
        agentId: CHILD.agentId,
        sessionKey: spawnedChildKey,
      },
      () => {},
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

    const childSend = await execute({
      identity: childIdentity,
      toolName: "sessions_send",
      request: {
        toolCallId: "child-to-root",
        sessionKey: SOURCE.sessionKey,
        message: "child reporting to root",
      },
    });
    expect(JSON.parse(childSend.resultJson)).toMatchObject({ details: { status: "ok" } });
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
    const grandchildOperationalRun = createOperationalRunInstanceRef(grandchildClaim.runId);
    delegatedAuthorities.push(claimAgentRunDelegatedAuthority(grandchildOperationalRun));
    bindWorkerTurnOwner(
      placements,
      grandchildClaim,
      {
        ...PARENT_EXECUTION_IDENTITY_TOKEN,
        contextId: "grandchild-context",
        executionId: "grandchild-execution",
        runId: grandchildClaim.runId,
        createdAt: 3,
      },
      grandchildOperationalRun,
      { agentId: GRANDCHILD.agentId, sessionKey: spawnedGrandchildKey! },
      () => {},
    );
    const grandchildSend = await execute({
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
    expect(JSON.parse(grandchildSend.resultJson)).toMatchObject({ details: { status: "ok" } });

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
        spawnState.order.push("create");
        spawnState.childSessionKey = String(request.params.key);
        setEntry(spawnState.childSessionKey, CHILD.sessionId, {
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
});

describe("worker spawn startup composition", () => {
  const getFixture = installWorkerSessionToolTestFixture(fixtureMocks);

  it.each([false, true])(
    "retains parent authority across runtime-bound provisioning (closed=%s)",
    async (closed) => {
      const { root, placements, identity, setEntry, activate, closeSourceRun } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      const { createDesktopSessionRegistry } = await import("../desktop/session-registry.js");
      const { createGatewayWorkerEnvironmentRuntime, loadGatewayWorkerEnvironmentStartupState } =
        await import("../server-worker-environment-startup.js");
      const factory = vi.spyOn(environmentServiceModule, "createWorkerEnvironmentService");
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
          const startup = await loadGatewayWorkerEnvironmentStartupState();
          const registry = createEmptyPluginRegistry();
          const runtime = await createGatewayWorkerEnvironmentRuntime({
            getPluginRegistry: () => registry,
            getPortalRuntime: () => undefined,
            resolveGatewayContext,
            desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
            startup: { ...startup, placementStore: placements },
            log: { child: () => ({ warn: () => {} }) },
          });
          const service = runtime.workerEnvironmentService;
          const execute = factory.mock.calls.at(-1)?.[0].executeSessionTool;
          if (!service || !execute || !runtime.bindWorkerSessionDispatch) {
            throw new Error("worker session-tool runtime was not composed");
          }
          startup.store.createIntent({
            environmentId: SOURCE.environmentId,
            providerId: "fake",
            profileId: "cloud-profile",
            profileSnapshot: { install: "bundle", settings: { region: "source" } },
            provisionOperationId: "source-provision",
          });
          const base = service.get(SOURCE.environmentId);
          if (!base) {
            throw new Error("source environment fixture was not created");
          }
          const getEnvironment = vi.spyOn(service, "get").mockImplementation((environmentId) => {
            const owner = environmentId === SOURCE.environmentId ? SOURCE : CHILD;
            return {
              ...base,
              environmentId,
              state: "attached",
              leaseId: `lease-${environmentId}`,
              ownerEpoch: owner.ownerEpoch,
              attachedSessionIds: [owner.sessionId],
            };
          });
          const provisioning = createDeferred();
          const finishProvisioning = createDeferred();
          runtime.bindWorkerSessionDispatch(async (request, _onTransition, authorize) => {
            provisioning.resolve();
            await finishProvisioning.promise;
            authorize?.();
            activate({ ...CHILD, sessionKey: request.sessionKey });
            const placement = placements.get(CHILD.sessionId);
            if (placement?.state !== "active") {
              throw new Error("child fixture did not activate");
            }
            return placement;
          });
          try {
            const pending = execute({
              identity,
              toolName: "sessions_spawn",
              request: { toolCallId: "startup-parent-closure", task: "start the child" },
            });
            await Promise.race([
              provisioning.promise,
              pending.then(() => {
                throw new Error("worker spawn completed before provisioning");
              }),
            ]);
            if (closed) {
              closeSourceRun();
            }
            finishProvisioning.resolve();
            const result = await pending;
            expect(placements.get(CHILD.sessionId)?.state).toBe(closed ? undefined : "active");
            expect(gatewayRequest).toHaveBeenCalledTimes(closed ? 0 : 1);
            expect(result.resultJson.includes('"status":"error"')).toBe(closed);
          } finally {
            finishProvisioning.resolve();
            getEnvironment.mockRestore();
            await service.stop();
          }
        });
      } finally {
        factory.mockRestore();
      }
    },
  );
});

describe.each([false, true])(
  "worker spawn parent authority (audit=%s)",
  (collectExecutionIdentity) => {
    const getFixture = installWorkerSessionToolTestFixture(fixtureMocks, {
      collectExecutionIdentity,
    });

    it.each([false, true])(
      "launches the child only while the parent owner is active (closed=%s)",
      async (closed) => {
        const { setEntry, spawn, placements, sourceClaim, closeSourceRun } = getFixture();
        setEntry(SOURCE.sessionKey, SOURCE.sessionId);
        const dispatch = dispatchChild.getMockImplementation();
        if (!dispatch) {
          throw new Error("Missing child placement fixture");
        }
        const provisioning = createDeferred();
        const finishProvisioning = createDeferred();
        dispatchChild.mockImplementationOnce(async (...args) => {
          provisioning.resolve();
          await finishProvisioning.promise;
          return await dispatch(...args);
        });

        const pending = spawn("parent-closes-during-provisioning");
        await provisioning.promise;
        let drained: Promise<void> | undefined;
        if (closed) {
          closeSourceRun();
          drained = placements.closeWorkerTurnToolState(sourceClaim);
          // Parent teardown retains this claim until the admitted spawn settles.
          expect(placements.validateTurnClaim(sourceClaim)).toBe(true);
        }
        finishProvisioning.resolve();
        const result = await pending;
        await drained;

        expect(gatewayRequest).toHaveBeenCalledTimes(closed ? 0 : 1);
        expect(result.resultJson.includes('"status":"error"')).toBe(closed);
        expect(spawnCallerIdentity.mock.calls[0]?.[0]?.executionIdentityToken).toBe(
          collectExecutionIdentity ? PARENT_EXECUTION_IDENTITY_TOKEN : undefined,
        );
      },
    );
  },
);
