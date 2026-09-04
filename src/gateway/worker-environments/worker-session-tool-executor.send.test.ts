import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import type { SessionEntry } from "../../config/sessions.js";
import { releaseAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  SOURCE,
  TARGET,
  PARENT,
  PARENT_EXECUTION_IDENTITY_TOKEN,
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
  scopedSessionAccess,
};

describe("worker session tool send delivery", () => {
  const getFixture = installWorkerSessionToolTestFixture(fixtureMocks);
  let placements: ReturnType<typeof getFixture>["placements"];
  let identity: ReturnType<typeof getFixture>["identity"];
  let execute: ReturnType<typeof getFixture>["execute"];
  let sourceClaim: ReturnType<typeof getFixture>["sourceClaim"];
  let delegatedAuthorities: ReturnType<typeof getFixture>["delegatedAuthorities"];
  let activate: ReturnType<typeof getFixture>["activate"];
  let setEntry: ReturnType<typeof getFixture>["setEntry"];
  let send: ReturnType<typeof getFixture>["send"];

  beforeEach(() => {
    resetGlobalHookRunner();
    ({
      placements,
      identity,
      execute,
      sourceClaim,
      delegatedAuthorities,
      activate,
      setEntry,
      send,
    } = getFixture());
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("delivers across exact live family incarnations with the source channel", async () => {
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
    sessionEntries.get(SOURCE.sessionKey)!.delivery = {
      kind: "external",
      context: { channel: "telegram", to: "source-chat" },
      route: { channel: "telegram", target: { to: "source-chat" } },
      origin: { provider: "telegram" },
    };
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
          agentChannel: "telegram",
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

  it("delivers a validated policy rewrite with the original tool-call identity", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          matcher: ["sessions_send"],
          handler: () => ({ params: { sessionKey: TARGET.sessionKey, message: "rewritten" } }),
        },
      ]),
    );

    const receipts: DecisionReceiptV1[] = [];
    const clearReceipts = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await send("rewritten-worker-send");
    } finally {
      clearReceipts();
    }

    expect(delivered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        args: expect.objectContaining({ message: "rewritten" }),
        toolCallId: "rewritten-worker-send",
      }),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      contextId: PARENT_EXECUTION_IDENTITY_TOKEN.contextId,
      executionId: PARENT_EXECUTION_IDENTITY_TOKEN.executionId,
      runId: PARENT_EXECUTION_IDENTITY_TOKEN.runId,
      action: { family: "plugin", operation: "before_tool_call" },
      decision: { outcome: "allowed", reasonCode: "plugin_hook_allowed" },
      enforcement: { coverageState: "enforced" },
      source: { owner: "plugin-hook" },
    });
  });

  it("suppresses policy receipts and effects when worker authority closes during the hook", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    let resolvePolicy!: () => void;
    const policy = new Promise<void>((resolve) => {
      resolvePolicy = resolve;
    });
    const beforeToolCall = vi.fn(async () => {
      await policy;
      return {};
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", matcher: ["sessions_send"], handler: beforeToolCall },
      ]),
    );
    const receipts: DecisionReceiptV1[] = [];
    const clearReceipts = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const result = await (async () => {
      try {
        const pending = send("authority-closes-during-policy");
        await vi.waitFor(() => expect(beforeToolCall).toHaveBeenCalledOnce());
        releaseAgentRunDelegatedAuthority(delegatedAuthorities[0]!);
        resolvePolicy();
        return await pending;
      } finally {
        clearReceipts();
      }
    })();

    expect(result.resultJson).toMatch(/authority changed|lost ownership/u);
    expect(receipts).toEqual([]);
    expect(delivered).not.toHaveBeenCalled();
  });

  it("suppresses dispatch when worker authority closes after policy", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    gatewayRequest.mockResolvedValue({ runId: "target-run", status: "accepted" });
    let enterDispatch!: () => void;
    const dispatchEntered = new Promise<void>((resolve) => {
      enterDispatch = resolve;
    });
    let finishDispatch!: () => void;
    const dispatch = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    delivered.mockImplementationOnce(async ({ options }) => {
      enterDispatch();
      await dispatch;
      return await options.callGateway({ method: "agent", params: {} });
    });

    const pending = send("authority-closes-after-policy");
    await dispatchEntered;
    releaseAgentRunDelegatedAuthority(delegatedAuthorities[0]!);
    finishDispatch();
    const result = await pending;

    // The send already entered the tool, which can queue directly without a Gateway RPC.
    // Later authority loss must preserve that attempt's uncertainty and prevent replay.
    expect(result.resultJson).toContain("outcome is unknown");
    expect((await send("authority-closes-after-policy")).resultJson).toContain(
      "outcome is unknown",
    );
    expect(delivered).toHaveBeenCalledOnce();
    expect(gatewayRequest).not.toHaveBeenCalled();
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
    await Promise.all(retries);

    expect(delivered).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent policy blocks before message effects", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    setEntry(TARGET.sessionKey, TARGET.sessionId, {
      sessionKey: SOURCE.sessionKey,
      sessionId: SOURCE.sessionId,
    });
    let resolvePolicy!: (value: { block: true; blockReason: string }) => void;
    const policy = new Promise<{ block: true; blockReason: string }>((resolve) => {
      resolvePolicy = resolve;
    });
    const beforeToolCall = vi.fn(async () => await policy);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", matcher: ["sessions_send"], handler: beforeToolCall },
      ]),
    );

    const retries = Array.from({ length: 2 }, () => send("concurrent-policy-block"));
    await vi.waitFor(() => expect(beforeToolCall).toHaveBeenCalledOnce());
    resolvePolicy({ block: true, blockReason: "blocked by worker session policy" });
    const results = await Promise.all(retries);
    const replay = await send("concurrent-policy-block");

    expect(new Set(results.map((result) => result.resultJson))).toHaveLength(1);
    expect(replay.resultJson).toBe(results[0]?.resultJson);
    expect(replay.resultJson).toContain("blocked by worker session policy");
    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(delivered).not.toHaveBeenCalled();
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

describe.each([false, true])(
  "worker send source authority (audit=%s)",
  (collectExecutionIdentity) => {
    const getFixture = installWorkerSessionToolTestFixture(fixtureMocks, {
      collectExecutionIdentity,
    });

    it("does not deliver to a sibling after the source owner closes during admission", async () => {
      const { setEntry, send, placements, sourceClaim, delegatedAuthorities } = getFixture();
      setEntry(PARENT.sessionKey, PARENT.sessionId);
      setEntry(SOURCE.sessionKey, SOURCE.sessionId, PARENT);
      setEntry(TARGET.sessionKey, TARGET.sessionId, PARENT);
      const admissionStarted = createDeferred();
      const finishAdmission = createDeferred();
      scopedSessionAccess.mockImplementationOnce(async (params) => {
        admissionStarted.resolve();
        await finishAdmission.promise;
        return await params.run();
      });

      const pending = send("source-closes-during-sibling-admission");
      await admissionStarted.promise;
      releaseAgentRunDelegatedAuthority(delegatedAuthorities[0]!);
      const drained = placements.closeWorkerTurnToolState(sourceClaim);
      expect(placements.validateTurnClaim(sourceClaim)).toBe(true);
      finishAdmission.resolve();
      const result = await pending;
      await drained;

      expect(delivered).not.toHaveBeenCalled();
      expect(result.resultJson).toContain('"status":"error"');
    });
  },
);
