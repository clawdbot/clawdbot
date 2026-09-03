// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExecApprovalFollowupRuntimeHandoff } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import {
  getSubagentRunByChildSessionKey,
  registerSubagentRun,
  testing as subagentRegistryTesting,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../../agents/subagents/swarm/swarm-scheduler.test-support.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import { prepareAgentRunDispatch } from "../agent-turn/agent-run-admission-phase.js";
import { createAgentTurnIo } from "../agent-turn/io.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import type { GatewaySessionRow } from "../session-utils.js";
import {
  getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  mockCallArg,
  expectRespondError,
  flushScheduledDispatchStep,
  mockMainSessionEntry,
  buildExistingMainStoreEntry,
  backendGatewayClient,
  mockSessionResetSuccess,
  invokeAgent,
  describe1BeforeEach0,
  describe1AfterEach1,
  prime,
} from "./agent.test-harness.js";
import {
  handleChatAbortRequest,
  handleChatAbortRequestWithLifecycle,
} from "./chat-abort-handler.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

function expectReactivationFailure(respond: ReturnType<typeof vi.fn>, runId: string): void {
  expect(mocks.replaceSubagentRunAfterSteer).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith(
    false,
    { runId, status: "error", summary: "reactivate boom" },
    { code: "UNAVAILABLE", message: "reactivate boom" },
    { runId, error: "reactivate boom" },
  );
}

describe("gateway agent handler chat.abort integration", () => {
  beforeEach(describe1BeforeEach0);

  afterEach(describe1AfterEach1);

  it("registers an abort controller into chatAbortControllers for an agent run", async () => {
    prime();
    const pending = new Promise(() => {});
    mocks.agentCommand.mockReturnValueOnce(pending);

    const context = makeContext();
    const runId = "idem-abort-register";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        reqId: runId,
        client: { ...operatorWriteCliClient(), connId: "conn-1" },
      },
    );

    const entry = context.chatAbortControllers.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    expect(abortEntry.sessionKey).toBe("agent:main:main");
    expect(abortEntry.sessionId).toBe("existing-session-id");
    expect(abortEntry.ownerConnId).toBe("conn-1");
    expect(abortEntry.controller.signal.aborted).toBe(false);
    expect(abortEntry.expiresAtMs - abortEntry.startedAtMs).toBeGreaterThan(24 * 60 * 60_000);
  });

  it("keeps selected-global goals on agent session change events", async () => {
    const goal = {
      schemaVersion: 1,
      id: "goal-work-global",
      objective: "Finish work global task",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      tokenStart: 0,
      tokensUsed: 5,
      continuationTurns: 0,
    } satisfies NonNullable<GatewaySessionRow["goal"]>;
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("global");
    mocks.loadSessionEntry.mockReturnValue({
      cfg: { agents: { list: [{ id: "main" }, { id: "work" }] }, session: { scope: "global" } },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      key: "global",
      sessionId: "global-session-id",
      kind: "global",
      updatedAt: Date.now(),
      goal,
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValue(new Promise(() => {}));

    const context = makeContext();
    context.getSessionEventSubscriberConnIds = () => new Set(["conn-1"]);
    const runId = "idem-agent-global-goal-event";
    await invokeAgent(
      {
        message: "hi",
        agentId: "work",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(mocks.loadGatewaySessionRow).toHaveBeenCalledWith("global", { agentId: "work" });
      expect(context.addChatRun).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({ sessionKey: "global", agentId: "work" }),
      );
      expect(context.chatAbortControllers.get(runId)?.agentId).toBe("work");
      expect(context.broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({
          sessionKey: "global",
          agentId: "work",
          goal: expect.objectContaining({ id: "goal-work-global" }),
        }),
        new Set(["conn-1"]),
        { agentId: "work", dropIfSlow: true, sessionKeys: ["global"] },
      );
    });
  });

  it("yields after the accepted ack before dispatching heavy agent work", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-yield-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await pending;

    expect(mockCallArg(respond)).toBe(true);
    const acceptedPayload = expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      status: "accepted",
    });
    expect(acceptedPayload).not.toHaveProperty("dedupeKeys");
    expect(acceptedPayload).not.toHaveProperty("ownerConnId");
    expect(acceptedPayload).not.toHaveProperty("ownerDeviceId");
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "accepted",
      dedupeKeys: [`agent:${runId}`],
    });
    expect(mockCallArg(respond, 0, 2)).toBeUndefined();
    expect(mockCallArg(respond, 0, 3)).toEqual({ runId });
    expect(mocks.agentCommand).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch when chat.abort lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-dispatch";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => {
      expect(respond).toHaveBeenCalled();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    });

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    expect(context.chatAbortControllers.has(runId)).toBe(true);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    await pending;

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("preserves stop-command reason when /stop lands during the accepted ack yield", async () => {
    prime();
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-dispatch";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRecordFields(mockCallArg(respond, 0, 1), {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });
    expect(context.chatAbortControllers.has(runId)).toBe(true);

    const stopRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "agent:main:main",
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-dispatch",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when chat.abort lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: requestedSessionKey, runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("keeps selected-global alias scope when aborting during pre-accept setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadConfigReturn = {
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      session: { scope: "global" },
    };
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "global-work-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "global",
    });
    const requestedSessionKey = "agent:work:main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        global: {
          sessionId: "global-work-session-id",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-selected-global-alias-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "work",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "global", agentId: "work", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-selected-global-alias-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when a stop command lands during pre-accept setup", async () => {
    prime();
    const requestedSessionKey = "agent:main:legacy-main";
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-stop-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: requestedSessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "accepted",
    });

    const stopRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: requestedSessionKey,
        message: "/stop",
        idempotencyKey: "idem-stop-command-before-registration",
      },
      respond: stopRespond as never,
      context,
      req: { type: "req", id: "stop-req", method: "chat.send" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(stopRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: requestedSessionKey,
      status: "timeout",
      summary: "aborted",
      stopReason: "stop",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "stop",
    });
  });

  it("does not dispatch when session-level chat.abort lands during pre-accept setup", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-session-level-abort-before-registration";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main" },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when chat.abort lands during slow attachment setup", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      }),
    );
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseCatalog?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not recreate a session deleted during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let deleted = false;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: deleted ? undefined : persistedEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-delete-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    deleted = true;
    releaseCatalog?.();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not dispatch into a session reset during slow attachment setup", async () => {
    const sessionKey = "agent:main:main";
    const persistedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      model: "vision-model",
      modelProvider: "test",
      providerOverride: "test",
      modelOverride: "vision-model",
    };
    let currentEntry = persistedEntry;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: currentEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockClear();
    mocks.agentCommand.mockClear();

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-reset-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    currentEntry = { ...persistedEntry, sessionId: "reset-session-id" };
    releaseCatalog?.();
    await pending;

    expectRespondError(respond, {
      message: `Session "${sessionKey}" changed while starting work. Retry.`,
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("keeps selected-global agent scope while aborting during attachment setup", async () => {
    mocks.listAgentIds.mockReturnValue(["main", "work"]);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      agentId: "work",
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "work-global-session-id",
        updatedAt: Date.now(),
        modelProvider: "test",
        model: "vision-model",
        providerOverride: "test",
        modelOverride: "vision-model",
      },
      canonicalKey: "global",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    let releaseCatalog: (() => void) | undefined;
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseCatalog = () =>
              resolve([
                {
                  id: "vision-model",
                  name: "vision-model",
                  provider: "test",
                  input: ["image"],
                },
              ]);
          }),
      ),
    } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    const runId = "idem-selected-global-abort-during-attachment-setup";
    const pending = invokeAgent(
      {
        message: "inspect this",
        agentId: "work",
        sessionKey: "global",
        idempotencyKey: runId,
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "pixel.png",
            content: Buffer.from("not really a png").toString("base64"),
          },
        ],
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "global",
        agentId: "work",
        status: "accepted",
      }),
    );
    await waitForAssertion(() => expect(context.loadGatewayModelCatalog).toHaveBeenCalled());
    expect(context.loadGatewayModelCatalog).toHaveBeenCalledWith({
      agentId: "work",
      readOnly: true,
    });
    expect(mocks.loadSessionEntry).toHaveBeenCalledWith("global", {
      agentId: "work",
      clone: false,
      projection: "list",
    });
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "global", agentId: "work", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-selected-global-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "global",
      agentId: "work",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseCatalog?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not dispatch when chat.abort lands before voice wake reroutes the session", async () => {
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    await waitForAssertion(() =>
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        sessionKey: "agent:main:main",
        status: "accepted",
      }),
    );
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      summary: "aborted",
      stopReason: "rpc",
    });

    releaseRouting?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    const finalResponse = respond.mock.calls.find(
      (call: unknown[]) => (call[1] as { status?: unknown } | undefined)?.status === "timeout",
    );
    expectRecordFields(requireValue(finalResponse, "terminal response missing")[1], {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
  });

  it("does not register or dispatch agent work prepared across a gateway restart", async () => {
    mocks.registerAgentRunContext.mockClear();
    let releaseRouting: (() => void) | undefined;
    mocks.loadVoiceWakeRoutingConfig.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseRouting = () =>
            resolve({
              version: 1,
              defaultTarget: { mode: "current" },
              routes: [],
              updatedAtMs: 0,
            });
        }),
    );
    mocks.resolveVoiceWakeRouteByTrigger.mockReturnValue({ sessionKey: "agent:main:voice" });
    mocks.loadSessionEntry.mockImplementation((sessionKey: string) => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: sessionKey === "agent:main:voice" ? "voice-session-id" : "main-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey === "agent:main:voice" ? "agent:main:voice" : "agent:main:main",
    }));
    mocks.updateSessionStore.mockResolvedValue(undefined);

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-voice-route";
    const pending = invokeAgent(
      {
        message: "wake up",
        sessionKey: "agent:main:main",
        voiceWakeTrigger: "robot wake",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseRouting).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseRouting?.();
    await pending;

    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:voice",
      status: "timeout",
      stopReason: "restart",
      timeoutPhase: "queue",
      providerStarted: false,
    });
  });

  it("does not mutate a session after losing lifecycle ownership while waiting for its store", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let updaterCompleted = false;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      await new Promise<void>((resolve) => {
        releaseSessionWrite = resolve;
      });
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      updaterCompleted = true;
      return result;
    });

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-session-write";
    const pending = invokeAgent(
      {
        message: "hi",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => expect(releaseSessionWrite).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseSessionWrite?.();
    await pending;

    expect(updaterCompleted).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      stopReason: "restart",
    });
  });

  it("does not acknowledge a bare reset that loses lifecycle ownership", async () => {
    prime();
    let releaseReset: (() => void) | undefined;
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { assertCurrent?: () => void }) => {
        await new Promise<void>((resolve) => {
          releaseReset = resolve;
        });
        opts.assertCurrent?.();
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-restart-during-bare-reset";
    const pending = invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );
    await waitForAssertion(() => expect(releaseReset).toBeTypeOf("function"));

    mocks.lifecycleGeneration = "post-restart-generation";
    releaseReset?.();
    await pending;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "timeout",
      stopReason: "restart",
    });
    expect(
      respond.mock.calls.some(
        (call: unknown[]) => (call[1] as { result?: unknown } | undefined)?.result !== undefined,
      ),
    ).toBe(false);
  });

  it("acknowledges a committed reset when restart prevents its follow-up", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-reset-commit",
      },
      {
        context,
        reqId: "restart-after-reset-commit",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toContain("Session reset.");
    expect(result.payloads?.[0]?.text).toContain("send the follow-up message again");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-reset-commit")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed bare reset after lifecycle rotation", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        return {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        };
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-bare-reset",
      },
      {
        context,
        reqId: "restart-after-bare-reset",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-bare-reset")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed reset when post-commit work fails after rotation", async () => {
    prime();
    mocks.performGatewaySessionReset.mockImplementation(
      async (opts: { onCommitted?: (commit: { key: string; sessionId: string }) => void }) => {
        opts.onCommitted?.({
          key: "agent:main:main",
          sessionId: "reset-session-id",
        });
        mocks.lifecycleGeneration = "post-restart-generation";
        throw new Error("post-commit cleanup failed");
      },
    );

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-post-commit-reset-failure",
      },
      {
        context,
        reqId: "post-commit-reset-failure",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
    expectRecordFields(context.dedupe.get("agent:idem-post-commit-reset-failure")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("acknowledges a committed reset when restart wins during later session persistence", async () => {
    prime();
    mockSessionResetSuccess({ reason: "reset" });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      const result = await updater(store);
      mocks.lifecycleGeneration = "post-restart-generation";
      return result;
    });

    const context = makeContext();
    const respond = await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-restart-after-reset-later",
      },
      {
        context,
        reqId: "restart-after-reset-later",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {
      status: "ok",
      summary: "completed",
    }).result as { payloads?: Array<{ text?: string }> };
    expect(result.payloads?.[0]?.text).toContain("send the follow-up message again");
    expectRecordFields(context.dedupe.get("agent:idem-restart-after-reset-later")?.payload, {
      status: "ok",
      summary: "completed",
    });
  });

  it("rejects unauthorized chat.abort during pre-accept setup", async () => {
    prime();
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry(),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockReturnValueOnce(new Promise(() => {}));

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-before-registration-unauthorized";
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        respond,
        reqId: runId,
        flushDispatch: false,
        client: { ...operatorWriteCliClient(), connId: "owner-conn" },
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expect(context.chatAbortControllers.has(runId)).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: { ...operatorWriteCliClient(), connId: "other-conn" },
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond, 0, 0)).toBe(false);
    expectRecordFields(mockCallArg(abortRespond, 0, 2), {
      code: "INVALID_REQUEST",
      message: "unauthorized",
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      sessionKey: "agent:main:main",
      status: "accepted",
    });

    releaseSessionWrite?.();
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(context.chatAbortControllers.has(runId)).toBe(true);
  });

  it("updates exec approval followup aliases when chat.abort lands during pre-accept setup", async () => {
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };
    const firstRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-preaccept-abort",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    const secondRegistration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "req-elevated-preaccept-abort",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated,
    });
    if (!firstRegistration || !secondRegistration) {
      throw new Error("expected runtime handoff ids");
    }
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "123",
    });
    let releaseSessionWrite: (() => void) | undefined;
    let sessionWriteCalls = 0;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      sessionWriteCalls += 1;
      if (sessionWriteCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseSessionWrite = resolve;
        });
      }
      const store = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "123",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockImplementation(() => new Promise(() => {}));
    const context = makeContext();
    const runId = firstRegistration.idempotencyKey;
    const aliasKey = "agent:exec-approval-followup:req-elevated-preaccept-abort";

    const pending = invokeAgent(
      {
        message: "exec followup",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: runId,
        internalRuntimeHandoffId: firstRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-1",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );
    await waitForAssertion(() => expect(sessionWriteCalls).toBe(1));
    expectRecordFields(context.dedupe.get(aliasKey)?.payload, {
      runId,
      sessionKey: "agent:main:telegram:direct:123",
      status: "accepted",
    });

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:telegram:direct:123", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: backendGatewayClient(),
      isWebchatConnect: () => false,
    });

    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expectRecordFields(context.dedupe.get(aliasKey)?.payload, {
      runId,
      status: "timeout",
      stopReason: "rpc",
    });

    releaseSessionWrite?.();
    await pending;

    const retryRespond = await invokeAgent(
      {
        message: "exec followup duplicate",
        sessionKey: "agent:main:telegram:direct:123",
        channel: "telegram",
        idempotencyKey: secondRegistration.idempotencyKey,
        internalRuntimeHandoffId: secondRegistration.handoffId,
      },
      {
        reqId: "exec-followup-preaccept-abort-2",
        client: backendGatewayClient(),
        context,
        flushDispatch: false,
      },
    );

    expect(mockCallArg(retryRespond, 0, 1)).toMatchObject({
      runId,
      status: "timeout",
      stopReason: "rpc",
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("starts the registered timeout only after dispatch admission resolves", async () => {
    prime();
    const context = makeContext();
    const runId = "idem-dispatch-admission-timeout-start";
    const sessionId = "existing-session-id";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let markAcquireStarted = () => {};
    const acquireStarted = new Promise<void>((resolve) => {
      markAcquireStarted = resolve;
    });
    let releaseAcquire = () => {};
    const acquireReleased = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    type AdmittedRunAbort = Parameters<
      Parameters<typeof prepareAgentRunDispatch>[0]["setAdmittedRunAbort"]
    >[0];
    let registration: AdmittedRunAbort | undefined;

    try {
      const pending = prepareAgentRunDispatch({
        promptedAt: nowMs,
        request: {
          message: "wait for dispatch admission",
          timeout: 120,
          idempotencyKey: runId,
        },
        cfg: {},
        sessionEntry: { sessionId, updatedAt: nowMs },
        resolvedSessionKey: "agent:main:main",
        activeSessionAgentId: "main",
        delivery: {} as never,
        allowModelOverride: false,
        lifecycleGeneration: "test-generation",
        getAdmittedSessionId: () => sessionId,
        suppressVisibleSessionEffects: false,
        isOneShotModelRun: false,
        isRestartRecoveryResumeRun: false,
        runId,
        agentDedupeKeys: [`agent:${runId}`],
        context,
        client: null,
        io: createAgentTurnIo(vi.fn()),
        abortForLifecycleRotation: () => false,
        acquireGatewayWorkAdmission: async () => {
          markAcquireStarted();
          await acquireReleased;
        },
        assertGatewayWorkAdmissionAllowed: () => {},
        hasGatewayAdmissionOutcome: () => false,
        respondToGatewayAdmissionOutcome: () => true,
        admissionAgentId: () => "main",
        getGatewayWorkAdmission: () => undefined,
        setAdmittedRunAbort: (value: AdmittedRunAbort) => {
          registration = value;
        },
        getAdmittedRunAbort: () => registration,
        markAgentRunAccepted: () => {},
      } as unknown as Parameters<typeof prepareAgentRunDispatch>[0]);

      await acquireStarted;
      expect(registration).toBeUndefined();
      nowMs += 90_000;
      releaseAcquire();
      await pending;

      const abortEntry = requireValue(registration?.entry, "chat abort entry missing");
      expect(abortEntry.startedAtMs).toBe(nowMs);
      expect(abortEntry.expiresAtMs).toBe(
        resolveAgentRunExpiresAtMs({ now: nowMs, timeoutMs: 120_000 }),
      );
    } finally {
      releaseAcquire();
      dateNow.mockRestore();
    }
  });

  it("uses the explicit no-timeout agent expiry instead of the chat 24h cap", async () => {
    prime();
    let onExecutionStarted: (() => void) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void }) =>
        new Promise(() => {
          onExecutionStarted = opts.onExecutionStarted;
        }),
    );

    const context = makeContext();
    const respond = vi.fn();
    const runId = "idem-abort-no-timeout";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
        timeout: 0,
      },
      { context, respond, reqId: runId },
    );

    const entry = context.chatAbortControllers.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    expect(abortEntry.expiresAtMs - abortEntry.startedAtMs).toBeGreaterThan(24 * 60 * 60_000);
    const startedAtMs = abortEntry.startedAtMs;
    const executionStartedAtMs = Date.now() + 60_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(executionStartedAtMs);
    try {
      requireValue(onExecutionStarted, "execution-start callback missing")();
      expect(abortEntry.startedAtMs).toBe(startedAtMs);
      expect(abortEntry.expiresAtMs - executionStartedAtMs).toBeGreaterThan(24 * 60 * 60_000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("starts and rearms the agent timeout at the actual gateway execution boundaries", async () => {
    prime();
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    const runId = "idem-agent-execution-timeout-boundaries";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, sessionId],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      },
    });
    await mutationStarted;
    let onExecutionStarted: (() => void) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void }) =>
        new Promise(() => {
          onExecutionStarted = opts.onExecutionStarted;
        }),
    );
    const context = makeContext();
    const respond = vi.fn();
    const admissionStartedAtMs = nowMs;
    const request = invokeAgent(
      {
        message: "wait for admission, then preserve a full execution timeout",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
        timeout: 120,
      },
      { context, respond, reqId: runId },
    );

    try {
      await waitForAssertion(() => expect(context.dedupe.has(`agent:${runId}`)).toBe(true));
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      nowMs += 90_000;
      releaseMutation();
      await mutation;
      await request;
      await waitForAssertion(() => expect(mocks.agentCommand).toHaveBeenCalledTimes(1));

      const abortEntry = requireValue(
        context.chatAbortControllers.get(runId),
        "chat abort entry missing",
      );
      expect(abortEntry.startedAtMs).toBe(nowMs);
      expect(abortEntry.startedAtMs).toBeGreaterThan(admissionStartedAtMs);
      expect(abortEntry.expiresAtMs).toBe(
        resolveAgentRunExpiresAtMs({ now: abortEntry.startedAtMs, timeoutMs: 120_000 }),
      );

      nowMs += 120_000;
      const executionStartedAtMs = nowMs;
      const executionStarted = requireValue(onExecutionStarted, "execution-start callback missing");
      executionStarted();
      expect(abortEntry.startedAtMs).toBe(admissionStartedAtMs + 90_000);
      expect(abortEntry.expiresAtMs).toBe(
        resolveAgentRunExpiresAtMs({ now: executionStartedAtMs, timeoutMs: 120_000 }),
      );

      const firstExecutionExpiryMs = abortEntry.expiresAtMs;
      nowMs += 120_000;
      executionStarted();
      expect(abortEntry.startedAtMs).toBe(admissionStartedAtMs + 90_000);
      expect(abortEntry.expiresAtMs).toBe(firstExecutionExpiryMs);
    } finally {
      releaseMutation();
      await mutation;
      dateNow.mockRestore();
    }
  });

  it("keeps an elapsed queue deadline terminal before the maintenance sweep", async () => {
    prime();
    const runId = "idem-agent-expired-queue-deadline";
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let onExecutionStarted: (() => void) | undefined;
    mocks.agentCommand.mockImplementation(
      (opts: { onExecutionStarted?: () => void }) =>
        new Promise(() => {
          onExecutionStarted = opts.onExecutionStarted;
        }),
    );
    const context = makeContext();

    try {
      await invokeAgent(
        {
          message: "do not revive an expired queue deadline",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
          timeout: 120,
        },
        { context, respond: vi.fn(), reqId: runId },
      );

      const abortEntry = requireValue(
        context.chatAbortControllers.get(runId),
        "chat abort entry missing",
      );
      const startedAtMs = abortEntry.startedAtMs;
      const queueExpiresAtMs = abortEntry.expiresAtMs;
      nowMs = queueExpiresAtMs + 1;
      const executionStarted = requireValue(onExecutionStarted, "execution-start callback missing");
      executionStarted();

      expect(abortEntry.startedAtMs).toBe(startedAtMs);
      expect(abortEntry.expiresAtMs).toBe(queueExpiresAtMs);
      expect(abortEntry.controller.signal.aborted).toBe(false);

      nowMs = queueExpiresAtMs - 1;
      executionStarted();
      expect(abortEntry.expiresAtMs).toBe(queueExpiresAtMs);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("sets the maintenance expiry to the configured agent timeout, not the 24h chat default", async () => {
    prime();
    const pending = new Promise(() => {});
    mocks.agentCommand.mockReturnValueOnce(pending);

    mocks.loadConfigReturn = {
      agents: { defaults: { timeoutSeconds: 48 * 60 * 60 } },
    };
    const context = makeContext();
    const runId = "idem-abort-expires";
    const before = Date.now();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );
    mocks.loadConfigReturn = {};

    const entry = context.chatAbortControllers.get(runId);
    const abortEntry = requireValue(entry, "chat abort entry missing");
    // 48h configured timeout must not be silently truncated to the 24h
    // chat.send default cap baked into resolveChatRunExpiresAtMs. Assert
    // at least 25h to leave headroom above the 24h cap; the expected
    // value is ~48h.
    const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000;
    expect(abortEntry.expiresAtMs - before).toBeGreaterThan(TWENTY_FIVE_HOURS_MS);
  });

  it("chat.abort by runId aborts the agent run's signal and removes the entry", async () => {
    prime();
    const pending = new Promise(() => {});
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return pending;
    });

    const context = makeContext();
    const runId = "idem-abort-run";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    expect(context.chatAbortControllers.has(runId)).toBe(true);
    expect(capturedSignal?.aborted).toBe(false);

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
  });

  it.each([
    { name: "announcing", expectsCompletionMessage: true, collect: false },
    { name: "nonannouncing", expectsCompletionMessage: false, collect: false },
    { name: "unspecified completion", expectsCompletionMessage: undefined, collect: false },
    { name: "collector", expectsCompletionMessage: false, collect: true },
    {
      name: "collector partial persistence error",
      expectsCompletionMessage: false,
      collect: true,
      releaseOnParent: true,
      partialFailure: true,
    },
    {
      name: "collector session cascade partial persistence error",
      expectsCompletionMessage: false,
      collect: true,
      releaseOnParent: true,
      partialFailure: true,
      cascade: true,
    },
    {
      name: "collector parent signal",
      expectsCompletionMessage: false,
      collect: true,
      releaseOnParent: true,
    },
  ])(
    "chat.abort by runId kills only registered children of its non-admin owner: $name",
    async ({ expectsCompletionMessage, collect, releaseOnParent, partialFailure, cascade }) => {
      prime();
      subagentRegistryTesting.setDepsForTest({
        persistSubagentRunsToDisk: () => {},
        persistSubagentRunsToDiskOrThrow: () => {},
        callGateway: async () => await new Promise(() => {}),
      });
      const pending = new Promise(() => {});
      let capturedSignal: AbortSignal | undefined;
      mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
        capturedSignal = opts.abortSignal;
        return pending;
      });

      const context = makeContext();
      const client = {
        ...operatorWriteCliClient(["operator.read", "operator.write"]),
        connId: "owner-conn",
      };
      const runId = "idem-abort-owned-subagents";
      const ownedChildSessionKey = "agent:main:subagent:owned-by-aborted-turn";
      const queuedChildSessionKey = "agent:main:subagent:queued-by-aborted-turn";
      const unrelatedChildSessionKey = "agent:main:subagent:owned-by-other-turn";
      await invokeAgent(
        {
          message: "hi",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: runId,
        },
        { context, reqId: runId, client },
      );
      for (const [childSessionKey, requesterTurnRunId, queued] of [
        [ownedChildSessionKey, runId, false],
        ...(collect ? [[queuedChildSessionKey, runId, true] as const] : []),
        [unrelatedChildSessionKey, "other-parent-turn", false],
      ] as const) {
        registerSubagentRun({
          runId: childSessionKey,
          childSessionKey,
          controllerSessionKey:
            cascade && requesterTurnRunId !== runId ? "agent:main:other" : "agent:main:main",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          requesterAgentId: "main",
          requesterTurnRunId,
          task: requesterTurnRunId,
          cleanup: "keep",
          expectsCompletionMessage,
          collect,
          queued,
        });
      }

      const queuedDispatch = vi.fn(async () => {});
      const unselectedDispatch = vi.fn(async () => {});
      let childOperation: ReturnType<typeof createReplyOperation> | undefined;
      if (collect) {
        const sessionId = "active-collector-session";
        await replaceSessionEntry(
          {
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            sessionKey: ownedChildSessionKey,
          },
          { sessionId, updatedAt: Date.now() },
        );
        childOperation = createReplyOperation({
          sessionKey: ownedChildSessionKey,
          sessionId,
          resetTriggered: false,
        });
        childOperation.attachBackend({
          kind: "embedded",
          isStreaming: () => true,
          cancel: () => {
            if (!releaseOnParent) {
              expect(releaseSwarmRun(ownedChildSessionKey)).toBe(true);
            }
          },
        });
        if (releaseOnParent) {
          capturedSignal?.addEventListener(
            "abort",
            () => {
              expect(releaseSwarmRun(ownedChildSessionKey)).toBe(true);
            },
            { once: true },
          );
        }
        enqueueSwarmRun({
          groupId: "abort-owned-collectors",
          runId: queuedChildSessionKey,
          maxConcurrent: 1,
          activeRunIds: [ownedChildSessionKey],
          start: queuedDispatch,
          onStartFailure: () => true,
        });
        enqueueSwarmRun({
          groupId: "abort-owned-collectors",
          runId: unrelatedChildSessionKey,
          maxConcurrent: 1,
          activeRunIds: [],
          start: unselectedDispatch,
          onStartFailure: () => true,
        });
      }
      try {
        const foreignRespond = vi.fn();
        await handleChatAbortRequest({
          params: { sessionKey: "agent:main:main", runId },
          respond: foreignRespond as never,
          context,
          req: { type: "req", id: "foreign-abort-req", method: "chat.abort" },
          client: { ...client, connId: "foreign-conn" },
          isWebchatConnect: () => false,
        });
        expect(mockCallArg(foreignRespond)).toBe(false);
        expect(capturedSignal?.aborted).toBe(false);
        expect(getSubagentRunByChildSessionKey(ownedChildSessionKey)?.execution.status).toBe(
          "running",
        );
        if (collect) {
          expect(getSubagentRunByChildSessionKey(queuedChildSessionKey)?.execution.status).toBe(
            "queued",
          );
          expect(queuedDispatch).not.toHaveBeenCalled();
        }
        const abortRespond = vi.fn();
        if (partialFailure) {
          context.chatRunState.getOrCreate(runId).buffer = "partial";
          mocks.loadSessionEntry.mockImplementationOnce(() => {
            throw new Error("partial persistence failed");
          });
        }
        const abort = handleChatAbortRequestWithLifecycle(
          {
            params: { sessionKey: "agent:main:main", ...(cascade ? {} : { runId }) },
            respond: abortRespond as never,
            context,
            req: { type: "req", id: "abort-req", method: "chat.abort" },
            client,
            isWebchatConnect: () => false,
          },
          cascade ? { cascadeDescendants: true } : {},
        );

        if (partialFailure) {
          await expect(abort).rejects.toThrow("partial persistence failed");
        } else {
          await abort;
          expect(mockCallArg(abortRespond)).toBe(true);
          expectRecordFields(mockCallArg(abortRespond, 0, 1), { aborted: true, runIds: [runId] });
        }
        expect(capturedSignal?.aborted).toBe(true);
        expect(getSubagentRunByChildSessionKey(ownedChildSessionKey)).toMatchObject({
          endedReason: "subagent-killed",
          killReconciliation: { suppressTaskDelivery: true },
        });
        expect(
          getSubagentRunByChildSessionKey(unrelatedChildSessionKey)?.execution.endedAt,
        ).toBeUndefined();
        if (collect) {
          expect(getSubagentRunByChildSessionKey(queuedChildSessionKey)).toMatchObject({
            execution: { status: "terminal" },
            endedReason: "subagent-killed",
          });
          expect(childOperation?.abortSignal.aborted).toBe(true);
          await Promise.resolve();
          expect(queuedDispatch).not.toHaveBeenCalled();
          await waitForAssertion(() => expect(unselectedDispatch).toHaveBeenCalledOnce());
        }
      } finally {
        childOperation?.complete();
        swarmSchedulerTesting.reset();
      }
    },
  );

  it("chat.abort by runId allows the owner connection to use a stale session key", async () => {
    prime();
    const pending = new Promise(() => {});
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return pending;
    });

    const context = makeContext();
    const runId = "idem-abort-stale-session-key";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        context,
        reqId: runId,
        client: { ...operatorWriteCliClient(), connId: "owner-conn" },
      },
    );

    const active = requireValue(context.chatAbortControllers.get(runId), "active run missing");
    context.chatAbortControllers.set(runId, {
      ...active,
      sessionKey: "agent:main:canonical",
    });

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: { ...operatorWriteCliClient(), connId: "owner-conn" },
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(capturedSignal?.aborted).toBe(true);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
  });

  it("keeps the sessions.abort wait snapshot after late agent completion", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    let resolveRun:
      | ((value: { payloads: Array<{ text: string }>; meta: { durationMs: number } }) => void)
      | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    const context = makeContext();
    const runId = "idem-abort-snapshot-wins";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });
    expect(capturedSignal?.aborted).toBe(true);

    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 100,
        ok: true,
        payload: {
          runId,
          status: "timeout",
          stopReason: "rpc",
          endedAt: 100,
        },
      },
    });

    resolveRun?.({ payloads: [{ text: "late ok" }], meta: { durationMs: 1 } });

    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "timeout",
        stopReason: "rpc",
        endedAt: 100,
      });
    });
  });

  it("chat.abort without runId aborts the active agent run for the sessionKey", async () => {
    prime();
    let capturedSignal: AbortSignal | undefined;
    mocks.agentCommand.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise(() => {});
    });

    const context = makeContext();
    const runId = "idem-abort-session";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const abortRespond = vi.fn();
    await handleChatAbortRequest({
      params: { sessionKey: "agent:main:main" },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mockCallArg(abortRespond)).toBe(true);
    expectRecordFields(mockCallArg(abortRespond, 0, 1), {
      aborted: true,
      runIds: [runId],
    });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("removes the chatAbortControllers entry after the run completes successfully", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-cleanup-ok";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(false);
    });
  });

  it("retains agent RPC registration until terminal persistence settles", async () => {
    prime();
    let resolveAgent: (value: {
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }) => void = () => undefined;
    const agentResult = new Promise<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>((resolve) => {
      resolveAgent = resolve;
    });
    mocks.agentCommand.mockReturnValueOnce(agentResult);

    const context = makeContext();
    const runId = "idem-abort-cleanup-persisting";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    const entry = requireValue(context.chatAbortControllers.get(runId), "chat abort entry missing");
    let resolvePersistence: () => void = () => undefined;
    entry.projectSessionTerminalPersistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    resolveAgent({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(true);
    });
    resolvePersistence();
    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(false);
    });
  });

  it("removes the chatAbortControllers entry after the run errors", async () => {
    prime();
    mocks.clearAgentRunContext.mockClear();
    mocks.agentCommand.mockRejectedValueOnce(new Error("boom"));

    const context = makeContext();
    const runId = "idem-abort-cleanup-err";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(mocks.clearAgentRunContext).toHaveBeenCalledWith(runId, "test-generation");
    });
  });

  it("removes the chatAbortControllers entry if pre-dispatch reactivation fails", async () => {
    prime("reactivation-session");
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(
      createSubagentRunRecord({
        runId: "previous-run",
        childSessionKey: "agent:main:main",
        execution: { status: "terminal", endedAt: 3 },
      }),
    );
    mocks.replaceSubagentRunAfterSteer.mockRejectedValueOnce(new Error("reactivate boom"));

    const context = makeContext();
    const runId = "idem-abort-reactivation-fails";
    const respond = vi.fn();
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expectReactivationFailure(respond, runId);
  });

  it("restores admitted restart recovery if pre-dispatch reactivation fails", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "recovery-session";
    const runId = "recovery-reactivation-fails";
    const storePath = "/tmp/sessions.json";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
          reservation: {
            runId,
            attempt: 1,
            lifecycleGeneration: "test-generation",
          },
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(
      createSubagentRunRecord({
        runId: "previous-run",
        childSessionKey: sessionKey,
        execution: { status: "terminal", endedAt: 3 },
      }),
    );
    mocks.replaceSubagentRunAfterSteer.mockRejectedValueOnce(new Error("reactivate boom"));

    const respond = vi.fn();
    await invokeAgent(
      {
        message: "resume after restart",
        agentId: "main",
        sessionKey,
        sessionId,
        expectedExistingSessionId: sessionId,
        idempotencyKey: runId,
        inputProvenance: {
          kind: "internal_system",
          sourceSessionKey: sessionKey,
          sourceTool: "main_session_restart_recovery",
        },
      },
      { client: backendGatewayClient(), reqId: runId, respond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(store[sessionKey]).toMatchObject({
      sessionId,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        chargedAttempts: 1,
      },
    });
    expect(store[sessionKey]?.mainRestartRecovery?.reservation).toBeUndefined();
    expectReactivationFailure(respond, runId);
  });

  it("releases a foreground recovery owner if pre-dispatch reactivation fails", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const runId = "foreground-reactivation-fails";
    const storePath = "/tmp/sessions.json";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.getLatestSubagentRunByChildSessionKey.mockReturnValueOnce(
      createSubagentRunRecord({
        runId: "previous-run",
        childSessionKey: sessionKey,
        execution: { status: "terminal", endedAt: 3 },
      }),
    );
    mocks.replaceSubagentRunAfterSteer.mockRejectedValueOnce(new Error("reactivate boom"));

    const respond = await invokeAgent(
      {
        message: "new foreground turn",
        agentId: "main",
        sessionKey,
        sessionId,
        idempotencyKey: runId,
      },
      { client: backendGatewayClient(), reqId: runId },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(store[sessionKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expectReactivationFailure(respond, runId);
  });

  it("releases gateway admission when foreground owner cleanup exhausts retries", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const runId = "foreground-release-fails";
    const storePath = "/tmp/sessions.json";
    const store: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 1,
        },
      },
    };
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath,
      entry: structuredClone(store[sessionKey]),
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.applySessionEntryReplacements.mockRejectedValue(new Error("owner release write failed"));

    await expect(
      invokeAgent(
        {
          message: "new foreground turn",
          agentId: "main",
          sessionKey,
          sessionId,
          deliver: true,
          replyChannel: "telegram",
          bestEffortDeliver: false,
          idempotencyKey: runId,
        },
        {
          client: backendGatewayClient(),
          reqId: runId,
          respond: vi.fn(),
          flushDispatch: false,
        },
      ),
    ).rejects.toThrow("owner release write failed");
    await expect(
      runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        signal: AbortSignal.timeout(100),
        run: async () => "released",
      }),
    ).resolves.toBe("released");
  });

  it("does not dispatch a duplicate agent run when dedupe was evicted but the run is active", async () => {
    prime();
    mocks.agentCommand.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1 },
    });

    const context = makeContext();
    const runId = "idem-abort-collision";
    const preExisting = {
      controller: new AbortController(),
      sessionId: "chat-send-session",
      sessionKey: "agent:main:main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      ownerConnId: "chat-send-conn",
      ownerDeviceId: undefined,
    };
    context.chatAbortControllers.set(runId, preExisting);
    context.dedupe.delete(`agent:${runId}`);
    mocks.registerAgentRunContext.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.chatAbortControllers.get(runId)).toBe(preExisting);
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mocks.registerAgentRunContext).not.toHaveBeenCalled();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("does not dispatch a duplicate sessionless run while its reservation is active", async () => {
    prime();
    let finishRun!: (result: {
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }) => void;
    mocks.agentCommand.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRun = resolve;
      }),
    );

    const context = makeContext();
    const runId = "idem-sessionless-active-collision";
    const request = {
      message: "hi",
      agentId: "main",
      sessionId: "sessionless-existing-session",
      idempotencyKey: runId,
    };
    await invokeAgent(request, { context, reqId: runId });
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);

    const duplicateRespond = vi.fn();
    await invokeAgent(request, {
      context,
      reqId: `${runId}-duplicate`,
      respond: duplicateRespond,
    });

    expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
    expect(duplicateRespond).toHaveBeenCalledWith(
      true,
      { runId, status: "in_flight", agentId: "main" },
      undefined,
      {
        cached: true,
        runId,
      },
    );

    finishRun({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
  });

  it("keeps a sessionless run from replacing an active projected run", async () => {
    prime();
    const context = makeContext();
    const runId = "idem-sessionless-projected-collision";
    const preExisting = {
      controller: new AbortController(),
      sessionId: "chat-send-session",
      sessionKey: "agent:main:main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    context.chatAbortControllers.set(runId, preExisting);
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionId: "sessionless-existing-session",
        idempotencyKey: runId,
      },
      { context, reqId: runId, respond },
    );

    expect(context.chatAbortControllers.get(runId)).toBe(preExisting);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
  });

  it("returns in_flight instead of replaying cached accepted agent replies", async () => {
    prime();
    mocks.agentCommand.mockImplementationOnce(
      () =>
        new Promise(() => {
          // Keep the first run pending so the dedupe entry remains accepted.
        }),
    );

    const context = makeContext();
    const runId = "idem-cached-accepted";
    await invokeAgent(
      {
        message: "hi",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: runId, flushDispatch: false },
    );

    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "accepted",
      sessionKey: "agent:main:main",
    });

    const duplicateRespond = vi.fn();
    await invokeAgent(
      {
        message: "hi again",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      { context, reqId: `${runId}-duplicate`, respond: duplicateRespond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(duplicateRespond).toHaveBeenCalledWith(
      true,
      { runId, status: "in_flight", sessionKey: "agent:main:main", agentId: "main" },
      undefined,
      {
        cached: true,
        runId,
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
