// Imported by agent.test.ts to keep its mocked suite in one Vitest module graph.
import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  getAgentTestMocks,
  makeContext,
  type AgentHandlerArgs,
  type AgentParams,
  type AgentCommandCall,
  setDateOnlyFakeClockActive,
  waitForAssertion,
  requireValue,
  expectRecordFields,
  expectSqliteSessionFileMarkerForEntry,
  mockCallArg,
  expectRespondError,
  flushScheduledDispatchStep,
  mockMainSessionEntry,
  buildExistingMainStoreEntry,
  useTestStateDir,
  primeMainAgentRun,
  runMainAgent,
  runMainAgentAndCaptureEntry,
  backendGatewayClient,
  operatorWriteCliClient,
  waitForAgentCommandCall,
  invokeAgent,
  describe0AfterEach0,
} from "./agent.test-harness.js";
import { chatHandlers } from "./chat.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = getAgentTestMocks();

describe("gateway agent handler", () => {
  afterEach(describe0AfterEach0);

  it("passes resolved maintenance config to the gateway admission store write", async () => {
    primeMainAgentRun({
      cfg: {
        session: {
          maintenance: {
            mode: "enforce",
            maxEntries: 42,
          },
        },
      },
    });

    await runMainAgent("hi", "idem-maintenance-config");

    const updateOptions = mocks.updateSessionStore.mock.calls.at(-1)?.[2];
    expect(updateOptions).toMatchObject({
      takeCacheOwnership: true,
      maintenanceConfig: {
        mode: "enforce",
        maxEntries: 42,
      },
    });
  });

  it("resolves explicit recipient sessions before Gateway admission", async () => {
    const sessionKey = "agent:ops:whatsapp:work:direct:+15551234567";
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = { session: { dmScope: "per-account-channel-peer" } };
    mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({
      sessionKey,
      channel: "whatsapp",
      to: "user:+15551234567",
      accountId: "work",
      threadId: "topic-42",
    });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    });
    let persistedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store = {
        [sessionKey]: { sessionId: "recipient-session", updatedAt: Date.now() },
      };
      const result = await updater(store);
      persistedEntry = store[sessionKey];
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent({
      message: "hi",
      agentId: "ops",
      channel: "whatsapp",
      to: "+15551234567",
      threadId: "topic-42",
      idempotencyKey: "recipient-session-route",
    });

    expect(mocks.resolveAgentExplicitRecipientSession).toHaveBeenCalledWith({
      cfg: mocks.loadConfigReturn,
      agentId: "ops",
      channel: "whatsapp",
      to: "+15551234567",
      accountId: undefined,
      threadId: "topic-42",
    });
    const call = await waitForAgentCommandCall<{
      sessionKey?: string;
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string;
    }>();
    expect(call.sessionKey).toBe(sessionKey);
    expect(call).toMatchObject({
      channel: "whatsapp",
      to: "user:+15551234567",
      accountId: "work",
      threadId: "topic-42",
    });
    expect(persistedEntry?.delivery).toEqual(
      normalizeSessionDeliveryState({
        context: {
          channel: "whatsapp",
          to: "user:+15551234567",
          accountId: "work",
          threadId: "topic-42",
        },
      }),
    );
  });

  it.each(["webchat", "LAST"])(
    "keeps the agent main session for non-deliverable channel hint %s",
    async (channel) => {
      const sessionKey = "agent:ops:main";
      mocks.listAgentIds.mockReturnValue(["main", "ops"]);
      mocks.resolveExplicitAgentSessionKey.mockReturnValue(sessionKey);
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "ops-main", updatedAt: Date.now() },
        canonicalKey: sessionKey,
      });
      mocks.updateSessionStore.mockImplementation(
        async (_path, updater) =>
          await updater({
            [sessionKey]: { sessionId: "ops-main", updatedAt: Date.now() },
          }),
      );
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await invokeAgent({
        message: "hi",
        agentId: "ops",
        channel,
        to: "+15551234567",
        idempotencyKey: `non-deliverable-${channel}`,
      });

      expect(mocks.resolveAgentExplicitRecipientSession).not.toHaveBeenCalled();
      const call = await waitForAgentCommandCall<{ sessionKey?: string }>();
      expect(call.sessionKey).toBe(sessionKey);
    },
  );

  it("dedupes retries while explicit recipient session routing is pending", async () => {
    const sessionKey = "agent:ops:whatsapp:work:direct:+15551234567";
    const runId = "recipient-session-route-pending";
    let finishRoute = (_result: { sessionKey: string }) => {};
    const routePending = new Promise<{ sessionKey: string }>((resolve) => {
      finishRoute = resolve;
    });
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = { session: { dmScope: "per-account-channel-peer" } };
    mocks.resolveAgentExplicitRecipientSession.mockReturnValue(routePending);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) =>
        await updater({
          [sessionKey]: { sessionId: "recipient-session", updatedAt: Date.now() },
        }),
    );
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const context = makeContext();
    const request = {
      message: "hi",
      agentId: "ops",
      channel: "whatsapp",
      accountId: "work",
      to: "+15551234567",
      idempotencyKey: runId,
    } satisfies AgentParams;
    const first = invokeAgent(request, { context, reqId: runId });
    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        status: "accepted",
      });
    });
    expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("sessionKey");

    const duplicateRespond = vi.fn();
    await invokeAgent(request, {
      context,
      reqId: `${runId}-duplicate`,
      respond: duplicateRespond,
      flushDispatch: false,
    });
    expect(duplicateRespond).toHaveBeenCalledWith(true, { runId, status: "in_flight" }, undefined, {
      cached: true,
      runId,
    });
    expect(mocks.resolveAgentExplicitRecipientSession).toHaveBeenCalledTimes(1);

    finishRoute({ sessionKey });
    await first;
  });

  it("honors owner cancellation while explicit recipient session routing is pending", async () => {
    const sessionKey = "agent:ops:whatsapp:work:direct:+15551234567";
    const runId = "recipient-session-route-abort";
    let finishRoute = (_result: { sessionKey: string }) => {};
    const routePending = new Promise<{ sessionKey: string }>((resolve) => {
      finishRoute = resolve;
    });
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.loadConfigReturn = { session: { dmScope: "per-account-channel-peer" } };
    mocks.resolveAgentExplicitRecipientSession.mockReturnValue(routePending);
    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    });
    mocks.updateSessionStore.mockImplementation(
      async (_path, updater) =>
        await updater({
          [sessionKey]: { sessionId: "recipient-session", updatedAt: Date.now() },
        }),
    );
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const ownerClient = { connId: "owner-conn" } as AgentHandlerArgs["client"];
    const pending = invokeAgent(
      {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "+15551234567",
        idempotencyKey: runId,
      },
      { context, client: ownerClient, reqId: runId, flushDispatch: false },
    );
    await waitForAssertion(() => {
      expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
        runId,
        agentId: "ops",
        status: "accepted",
      });
    });
    expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("sessionKey");

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey: "agent:ops:main", runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-recipient-route", method: "chat.abort" },
      client: ownerClient,
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
    expect(context.dedupe.get(`agent:${runId}`)?.payload).not.toHaveProperty("sessionKey");

    finishRoute({ sessionKey });
    await pending;
    await flushScheduledDispatchStep();

    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("clears pending dedupe when explicit recipient session routing fails", async () => {
    const runId = "recipient-session-route-error";
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({
      error: new Error("ambiguous recipient"),
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "team",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "ambiguous recipient",
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("clears pending dedupe when the routed recipient session is unavailable", async () => {
    const sessionKey = "agent:ops:whatsapp:direct:+15551234567";
    const runId = "recipient-session-route-archived";
    mocks.listAgentIds.mockReturnValue(["main", "ops"]);
    mocks.resolveAgentExplicitRecipientSession.mockResolvedValue({ sessionKey });
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "recipient-session", updatedAt: 1, archivedAt: 1 },
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "hi",
        agentId: "ops",
        channel: "whatsapp",
        to: "+15551234567",
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      message: `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("rejects agent RPC creation in an agent harness-owned namespace", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const runId = "agent-harness-reserved";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined,
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "claim reserved session",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "Session key namespace is reserved for agent harness-owned sessions.",
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it.each(["agent:main:harness:codex:supervision:native-thread", "agent:main:ordinary-locked"])(
    "rejects agent RPC session-id rotation for locked session %s",
    async (sessionKey) => {
      const runId = "agent-harness-session-id-rotation";
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: "/tmp/sessions.json",
        entry: {
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          sessionId: "native-session",
        },
        canonicalKey: sessionKey,
      });
      mocks.agentCommand.mockClear();
      const updateSessionStoreCallsBefore = mocks.updateSessionStore.mock.calls.length;
      const context = makeContext();
      const respond = vi.fn();

      await invokeAgent(
        {
          message: "replace native transcript identity",
          agentId: "main",
          sessionKey,
          sessionId: "replacement-session",
          idempotencyKey: runId,
        },
        { context, respond, reqId: runId, flushDispatch: false },
      );

      expectRespondError(respond, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "Agent harness-owned session identity is locked and cannot be replaced or shared.",
      });
      expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
      expect(mocks.updateSessionStore).toHaveBeenCalledTimes(updateSessionStoreCallsBefore);
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    },
  );

  it("rejects one-shot model runs against harness-owned sessions", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    const runId = "agent-harness-model-run";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockClear();
    const context = makeContext();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "run through another model",
        agentId: "main",
        sessionKey,
        modelRun: true,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId, flushDispatch: false },
    );

    expectRespondError(respond, {
      code: ErrorCodes.INVALID_REQUEST,
      message: "Agent harness-owned sessions cannot be used for one-shot model runs.",
    });
    expect(context.dedupe.has(`agent:${runId}`)).toBe(false);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("allows raw model runs against grandfathered unlocked harness-prefixed sessions", async () => {
    const sessionKey = "agent:main:harness:notes";
    const runId = "legacy-harness-model-run";
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        sessionId: "legacy-session",
        updatedAt: Date.now(),
      },
      canonicalKey: sessionKey,
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "pong" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "Reply exactly: pong",
        agentId: "main",
        sessionKey,
        modelRun: true,
        promptMode: "none",
        idempotencyKey: runId,
      },
      {
        reqId: runId,
        client: operatorWriteCliClient(),
      },
    );

    expectRecordFields(await waitForAgentCommandCall(), {
      modelRun: true,
      promptMode: "none",
      sessionEffects: "internal",
      sessionId: "legacy-session",
      sessionKey,
    });
  });

  it("passes a canonical user-turn recorder to gateway agent runs", async () => {
    primeMainAgentRun();

    await runMainAgent("persist me", "idem-user-turn-recorder");

    const call = await waitForAgentCommandCall<
      AgentCommandCall & {
        userTurnTranscriptRecorder?: {
          persistApproved: () => Promise<unknown>;
        };
      }
    >();
    expect(call.userTurnTranscriptRecorder).toEqual(
      expect.objectContaining({
        persistApproved: expect.any(Function),
        persistFallback: expect.any(Function),
      }),
    );
  });

  it("attributes gateway agent prompts to the authenticated connection user", async () => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "persist me",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-attributed-user-turn-recorder",
      },
      {
        reqId: "idem-attributed-user-turn-recorder",
        client: {
          ...requireValue(operatorWriteCliClient(), "expected operator client"),
          authenticatedUserId: "alice@example.com",
        },
      },
    );

    const call = await waitForAgentCommandCall<
      AgentCommandCall & { userTurnTranscriptRecorder?: { message?: unknown } }
    >();
    expect(call.userTurnTranscriptRecorder?.message).toMatchObject({
      role: "user",
      content: "persist me",
      __openclaw: { senderId: "alice@example.com" },
    });
  });

  it("dispatches with the session id reloaded during lifecycle admission", async () => {
    const sessionKey = "agent:main:main";
    const initialSessionId = "session-before-reset";
    const admittedSessionId = "session-after-reset";
    let currentSessionId = initialSessionId;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: currentSessionId, updatedAt: Date.now() },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({
        [sessionKey]: { sessionId: initialSessionId, updatedAt: Date.now() },
      });
      currentSessionId = admittedSessionId;
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("hi", "idem-reset-before-admission");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).toBe(admittedSessionId);
  });

  it("does not recreate a session deleted before lifecycle admission", async () => {
    const sessionKey = "agent:main:main";
    let deleted = false;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: deleted ? undefined : { sessionId: "session-before-delete", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({
        [sessionKey]: { sessionId: "session-before-delete", updatedAt: Date.now() },
      });
      deleted = true;
      return result;
    });
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not recreate the deleted session",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-deleted-before-admission",
      },
      { respond, reqId: "idem-deleted-before-admission" },
    );

    expectRespondError(respond, {
      message: `Error: Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not recreate a session deleted before its initial store touch", async () => {
    const sessionKey = "agent:main:main";
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "session-before-delete", updatedAt: Date.now() },
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater({}));
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not recreate the deleted session",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-deleted-before-touch",
      },
      { respond, reqId: "idem-deleted-before-touch" },
    );

    expectRespondError(respond, {
      message: `Error: Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("does not recreate a newly touched session deleted before lifecycle admission", async () => {
    const sessionKey = "agent:main:slack:group:new-session";
    let storedEntry: Record<string, unknown> | undefined;
    mocks.loadSessionEntry.mockImplementation(() => ({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: storedEntry,
      canonicalKey: sessionKey,
    }));
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const result = await updater({});
      storedEntry = undefined;
      return result;
    });
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not revive the newly deleted session",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-new-session-deleted-before-admission",
      },
      { respond, reqId: "idem-new-session-deleted-before-admission" },
    );

    expectRespondError(respond, {
      message: `Error: Session "${sessionKey}" was deleted while starting work. Retry.`,
    });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("blocks the initial store touch and preserves an abort while admission waits", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    mocks.updateSessionStore.mockClear();
    const sessionKey = "agent:main:main";
    const runId = "idem-abort-during-admission";
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "existing-session-id"],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((release) => {
          releaseMutation = release;
        });
      },
    });
    await mutationStarted;
    const context = makeContext();
    const respond = vi.fn();
    const request = invokeAgent(
      {
        message: "do not run after abort",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId },
    );
    await waitForAssertion(() => {
      expect(context.dedupe.has(`agent:${runId}`)).toBe(true);
    });
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();

    const abortRespond = vi.fn();
    await expectDefined(
      chatHandlers["chat.abort"],
      'chatHandlers["chat.abort"] test invariant',
    )({
      params: { sessionKey, runId },
      respond: abortRespond as never,
      context,
      req: { type: "req", id: "abort-req", method: "chat.abort" },
      client: null,
      isWebchatConnect: () => false,
    });
    releaseMutation();
    await mutation;
    await request;

    expect(mockCallArg(abortRespond)).toBe(true);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(
      respond.mock.calls.some(
        ([ok, payload]) => ok === true && (payload as { status?: string })?.status === "timeout",
      ),
    ).toBe(true);
  });

  it("does not revive an expired reservation after lifecycle admission waits", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:main";
    const runId = "idem-expired-during-admission";
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "existing-session-id"],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((release) => {
          releaseMutation = release;
        });
      },
    });
    await mutationStarted;
    const context = makeContext();
    const respond = vi.fn();
    const request = invokeAgent(
      {
        message: "do not run after queue expiry",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId },
    );
    const dedupeKey = `agent:${runId}`;
    await waitForAssertion(() => {
      expect(context.dedupe.has(dedupeKey)).toBe(true);
    });
    const reserved = context.dedupe.get(dedupeKey);
    context.dedupe.set(dedupeKey, {
      ts: reserved?.ts ?? Date.now(),
      ok: true,
      payload: {
        ...(reserved?.payload as Record<string, unknown>),
        expiresAtMs: Date.now() - 1,
      },
    });

    releaseMutation();
    await mutation;
    await request;

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(
      respond.mock.calls.some(
        ([ok, payload]) =>
          ok === true &&
          (payload as { status?: string; stopReason?: string })?.status === "timeout" &&
          (payload as { stopReason?: string }).stopReason === "timeout",
      ),
    ).toBe(true);
  });

  it("preserves a newer terminal reservation result after lifecycle admission waits", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:main";
    const runId = "idem-terminal-during-admission";
    let releaseMutation = () => {};
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, "existing-session-id"],
      run: async () => {
        markMutationStarted();
        await new Promise<void>((release) => {
          releaseMutation = release;
        });
      },
    });
    await mutationStarted;
    const context = makeContext();
    const respond = vi.fn();
    const request = invokeAgent(
      {
        message: "do not overwrite the replacement result",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, respond, reqId: runId },
    );
    const dedupeKey = `agent:${runId}`;
    await waitForAssertion(() => {
      expect(context.dedupe.has(dedupeKey)).toBe(true);
    });
    const replacement = {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", summary: "replacement completed" },
    };
    context.dedupe.set(dedupeKey, replacement);

    releaseMutation();
    await mutation;
    await request;

    expect(context.dedupe.get(dedupeKey)).toBe(replacement);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenLastCalledWith(
      true,
      replacement.payload,
      undefined,
      expect.objectContaining({ cached: true, runId }),
    );
  });

  it("runs gateway agent work inside its lifecycle admission context", async () => {
    primeMainAgentRun();
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    mocks.agentCommand.mockImplementationOnce(async () => {
      await expect(
        interruptSessionWorkAdmissions({
          scope: "/tmp/sessions.json",
          identities: [sessionKey, sessionId],
          timeoutMs: 5,
        }),
      ).resolves.toBe(true);
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      };
    });

    await invokeAgent({
      message: "run in-band lifecycle work",
      agentId: "main",
      sessionKey,
      idempotencyKey: "idem-agent-admission-context",
    });

    expect(mocks.agentCommand).toHaveBeenCalledOnce();
  });

  it("adopts a recovery admission when a lifecycle mutation interposes before the RPC", async () => {
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    const runId = "idem-recovery-admission-handoff";
    const scope = "/tmp/sessions.json";
    primeMainAgentRun({ sessionId });
    mocks.agentCommand.mockClear();
    const admission = await beginSessionWorkAdmission({
      scope,
      identities: [sessionKey, sessionId],
      assertAllowed: () => {},
    });
    const handoffId = admission.createHandoff();
    let markMutationStarted = () => {};
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    let mutationRan = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        markMutationStarted();
        expect(
          await interruptSessionWorkAdmissions({
            scope,
            identities: [sessionKey, sessionId],
            timeoutMs: 1_000,
          }),
        ).toBe(true);
      },
      run: async () => {
        mutationRan = true;
      },
    });
    await mutationStarted;
    const respond = vi.fn();

    try {
      await invokeAgent(
        {
          message: "resume the admitted turn",
          agentId: "main",
          sessionKey,
          expectedExistingSessionId: sessionId,
          internalRuntimeHandoffId: handoffId,
          idempotencyKey: runId,
        },
        {
          client: backendGatewayClient(),
          flushDispatch: false,
          reqId: runId,
          respond,
        },
      );
      await mutation;

      expect(cancelSessionWorkAdmissionHandoff(handoffId)).toBe(false);
      expect(mutationRan).toBe(true);
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: "timeout", stopReason: "restart" }),
        undefined,
        expect.objectContaining({ cached: true, runId }),
      );
    } finally {
      cancelSessionWorkAdmissionHandoff(handoffId);
      admission.release();
      await mutation;
    }
  });

  it("classifies gateway lifecycle interruption as restart", async () => {
    primeMainAgentRun();
    const sessionKey = "agent:main:main";
    const sessionId = "existing-session-id";
    let observedAbortReason: unknown;
    mocks.agentCommand.mockImplementationOnce(
      async (opts: { abortSignal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          const finish = () => {
            observedAbortReason = opts.abortSignal?.reason;
            reject(
              observedAbortReason instanceof Error
                ? observedAbortReason
                : new Error("agent lifecycle interrupted"),
            );
          };
          if (opts.abortSignal?.aborted) {
            finish();
            return;
          }
          opts.abortSignal?.addEventListener("abort", finish, { once: true });
        }),
    );
    const context = makeContext();
    const runId = "idem-agent-lifecycle-restart";
    await invokeAgent(
      {
        message: "interrupt as restart",
        agentId: "main",
        sessionKey,
        idempotencyKey: runId,
      },
      { context, reqId: runId },
    );
    await waitForAgentCommandCall();

    await interruptSessionWorkAdmissions({
      scope: "/tmp/sessions.json",
      identities: [sessionKey, sessionId],
    });
    await flushScheduledDispatchStep();

    expect(isAgentRunRestartAbortReason(observedAbortReason)).toBe(true);
    expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, {
      runId,
      status: "timeout",
      stopReason: "restart",
    });
  });

  it("does not mutate a session archived before the initial store update", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const sessionKey = "agent:main:main";
    const archivedEntry = {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      archivedAt: Date.now(),
    };
    const store = { [sessionKey]: structuredClone(archivedEntry) };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "do not touch the archive",
        agentId: "main",
        sessionKey,
        idempotencyKey: "idem-archive-before-store-update",
      },
      { respond, reqId: "idem-archive-before-store-update" },
    );

    expectRespondError(respond, {
      message: `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    });
    expect(store).toEqual({ [sessionKey]: archivedEntry });
    expect(mocks.agentCommand).not.toHaveBeenCalled();
  });

  it("uses the freshest alias when checking archive state before migration", async () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "main", default: true }] },
    };
    mocks.loadConfigReturn = cfg;
    mocks.loadSessionEntry.mockReturnValue({
      cfg,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "restored-session", updatedAt: 2 },
      canonicalKey: "agent:main:work",
      // Post-flip the accessor target carries the alias set prepared at request
      // start; freshest-entry resolution happens inside the patch transaction.
      storeKeys: ["agent:main:work", "agent:main:main"],
    });
    const store = {
      "agent:main:work": {
        sessionId: "archived-session",
        updatedAt: 1,
        archivedAt: 1,
      },
      "agent:main:main": {
        sessionId: "restored-session",
        updatedAt: 2,
      },
    };
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => await updater(store));
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent({
      message: "continue restored session",
      agentId: "main",
      sessionKey: "agent:main:main",
      idempotencyKey: "idem-restored-alias",
    });

    expect(mocks.agentCommand).toHaveBeenCalled();
    expect(store["agent:main:work"]?.archivedAt).toBeUndefined();
    expect(store["agent:main:main"]).toBeUndefined();
  });

  it("does not persist a gateway user-turn recorder after the session key is rebound", async () => {
    primeMainAgentRun({ sessionId: "accepted-session-id" });

    await runMainAgent("stale after reset", "idem-user-turn-rebound");

    const call = await waitForAgentCommandCall<
      AgentCommandCall & {
        userTurnTranscriptRecorder?: {
          persistApproved: () => Promise<unknown>;
        };
      }
    >();
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "new-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
      store: {
        "agent:main:main": {
          sessionId: "new-session-id",
          updatedAt: Date.now(),
        },
      },
    });

    await expect(call.userTurnTranscriptRecorder?.persistApproved()).resolves.toBeUndefined();
  });

  it("does not pass a text-only user-turn recorder for image agent runs", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      model: "vision-model",
      modelProvider: "test",
      modelOverride: "vision-model",
      modelOverrideSource: "user",
      providerOverride: "test",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });
    const context = {
      ...makeContext(),
      loadGatewayModelCatalog: vi.fn(async () => [
        {
          id: "vision-model",
          name: "vision-model",
          provider: "test",
          input: ["image"],
        },
      ]),
    } as unknown as GatewayRequestContext;

    await invokeAgent(
      {
        message: "describe this image",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "idem-image-user-turn-recorder",
        attachments: [
          {
            type: "file",
            mimeType: "image/png",
            fileName: "test.png",
            content: Buffer.from("fake-png-data").toString("base64"),
          },
        ],
      },
      { context, reqId: "idem-image-user-turn-recorder" },
    );

    const call = await waitForAgentCommandCall();
    expect(call.images).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
      }),
    ]);
    expect(call.userTurnTranscriptRecorder).toBeUndefined();
  });

  it("does not pass a text-only user-turn recorder for offloaded image agent runs", async () => {
    await withTempDir({ prefix: "openclaw-gateway-agent-offloaded-image-" }, async (root) => {
      useTestStateDir(root);
      mockMainSessionEntry({
        sessionId: "existing-session-id",
        model: "vision-model",
        modelProvider: "test",
        modelOverride: "vision-model",
        modelOverrideSource: "user",
        providerOverride: "test",
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const context = {
        ...makeContext(),
        loadGatewayModelCatalog: vi.fn(async () => [
          {
            id: "vision-model",
            name: "vision-model",
            provider: "test",
            input: ["image"],
          },
        ]),
      } as unknown as GatewayRequestContext;

      await invokeAgent(
        {
          message: "describe this large image",
          agentId: "main",
          sessionKey: "agent:main:main",
          idempotencyKey: "idem-offloaded-image-user-turn-recorder",
          attachments: [
            {
              type: "file",
              mimeType: "image/png",
              fileName: "large.png",
              content: Buffer.alloc(2_000_001, 1).toString("base64"),
            },
          ],
        },
        { context, reqId: "idem-offloaded-image-user-turn-recorder" },
      );

      const call = await waitForAgentCommandCall();
      expect(call.images).toEqual([]);
      expect(call.imageOrder).toEqual(["offloaded"]);
      expect(call.message).toContain("[media attached: media://inbound/");
      expect(call.userTurnTranscriptRecorder).toBeUndefined();
    });
  });

  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({ acp: existingAcpMeta }),
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(requireValue(capturedEntry, "updated session entry missing").acp).toEqual(
      existingAcpMeta,
    );
  });

  it("clears automatic recovery quarantine state when a user turn rotates the session id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const staleEntry = {
      sessionId: "quarantined-session-id",
      updatedAt: 0,
      sessionStartedAt: 0,
      lastInteractionAt: 0,
      abortedLastRun: true,
      restartRecoveryRuns: [
        { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
        { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
      ],
      mainRestartRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: 3,
        lastRunId: "recovery-run-1",
      },
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: 3,
        wedgedAt: 4,
        wedgedReason: "automatic_attempt_budget_exceeded",
      },
    };
    mockMainSessionEntry(staleEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-rotated-recovery-clear");

    expect(capturedEntry.sessionId).not.toBe("quarantined-session-id");
    expect(capturedEntry.abortedLastRun).toBeUndefined();
    expect(capturedEntry.restartRecoveryRuns).toBeUndefined();
    expect(capturedEntry.mainRestartRecovery).toBeUndefined();
    expect(capturedEntry.subagentRecovery).toEqual({
      automaticAttempts: 2,
      lastAttemptAt: 3,
      wedgedAt: 4,
      wedgedReason: "automatic_attempt_budget_exceeded",
    });
  });

  it("drops a stale transcript path when a stale session rotates ids", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(new Date("2026-05-07T12:00:00.000Z"));
    const staleEntry = {
      sessionId: "old-session-id",
      sessionFile: "/tmp/openclaw/agents/main/sessions/old-session-id.jsonl",
      updatedAt: 0,
      sessionStartedAt: 0,
    };
    mockMainSessionEntry(staleEntry);

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": { ...staleEntry },
      };
      const result = await updater(store);
      capturedEntry = result as Record<string, unknown>;
      return result;
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-stale-transcript");

    expect(capturedEntry?.sessionId).not.toBe("old-session-id");
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it("rotates a failed session instead of resuming when its transcript is missing", async () => {
    const now = Date.parse("2026-05-18T09:45:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);
    const missingTranscriptEntry = {
      sessionId: "failed-missing-session-id",
      sessionFile: "/tmp/openclaw/missing/failed-missing-session-id.jsonl",
      status: "failed",
      updatedAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
      startedAt: now - 2_000,
      endedAt: now - 1_000,
      runtimeMs: 1_000,
      abortedLastRun: true,
    };
    mockMainSessionEntry(missingTranscriptEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-failed-missing-transcript");

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).not.toBe("failed-missing-session-id");
    expect(capturedEntry?.sessionId).not.toBe("failed-missing-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expect(capturedEntry?.startedAt).toBeUndefined();
    expect(capturedEntry?.endedAt).toBeUndefined();
    expect(capturedEntry?.runtimeMs).toBeUndefined();
    expect(capturedEntry?.abortedLastRun).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });

  it.each([
    { name: "status-done row", status: "done" as const, expectReuse: true },
    { name: "status-killed row", status: "killed" as const, expectReuse: false },
    { name: "endedAt-only row", status: undefined, expectReuse: false },
  ])(
    "handles a terminal main session from a $name when its transcript is newer",
    async (scenario) => {
      const now = Date.parse("2026-05-18T09:47:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      setDateOnlyFakeClockActive(true);
      vi.setSystemTime(now);
      mocks.readTranscriptStatsSync.mockReturnValue({
        eventCount: 1,
        lastMutationAtMs: now - 1_000,
        lastObservedMutationAtMs: now - 10_000,
        maxSeq: 0,
        sizeBytes: 64,
      });

      await withTempDir({ prefix: "openclaw-gateway-terminal-main-newer-" }, async (root) => {
        const sessionsDir = `${root}/sessions`;
        const sessionFile = "terminal-main-session.jsonl";
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: {
            sessionId: "terminal-main-session",
            sessionFile,
            ...(scenario.status ? { status: scenario.status } : {}),
            updatedAt: now - 10_000,
            sessionStartedAt: now - 60_000,
            lastInteractionAt: now - 10_000,
            startedAt: now - 20_000,
            endedAt: now - 15_000,
            runtimeMs: 5_000,
            cliSessionBindings: {
              "claude-cli": { sessionId: "old-claude-cli-session" },
              "codex-cli": { sessionId: "old-codex-cli-session" },
            },
            cliSessionIds: {
              "claude-cli": "old-claude-cli-session",
              "codex-cli": "old-codex-cli-session",
            },
            claudeCliSessionId: "old-claude-cli-session",
          },
          canonicalKey: "agent:main:main",
        });

        const capturedEntry = await runMainAgentAndCaptureEntry(
          "test-idem-terminal-main-newer-transcript",
        );

        const call = await waitForAgentCommandCall<{ sessionId?: string }>();
        if (scenario.expectReuse) {
          expect(call.sessionId).toBe("terminal-main-session");
          expect(capturedEntry?.sessionId).toBe("terminal-main-session");
          return;
        }
        expect(call.sessionId).not.toBe("terminal-main-session");
        expect(capturedEntry?.sessionId).not.toBe("terminal-main-session");
        expect(capturedEntry?.status).toBeUndefined();
        expect(capturedEntry?.startedAt).toBeUndefined();
        expect(capturedEntry?.endedAt).toBeUndefined();
        expect(capturedEntry?.runtimeMs).toBeUndefined();
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
        expect(capturedEntry?.cliSessionBindings).toBeUndefined();
        expect(capturedEntry?.cliSessionIds).toBeUndefined();
        expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
      });
    },
  );

  it("reuses terminal main sessions when the fresh store row has the transcript marker", async () => {
    const now = Date.parse("2026-05-18T09:47:30.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTempDir({ prefix: "openclaw-gateway-terminal-main-fresh-marker-" }, async (root) => {
      const sessionsDir = `${root}/sessions`;
      await fs.mkdir(sessionsDir, { recursive: true });
      const sessionFile = "terminal-main-session.jsonl";
      const transcriptPath = `${sessionsDir}/${sessionFile}`;
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
        "utf8",
      );
      await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
      const staleEntry = {
        sessionId: "terminal-main-session",
        sessionFile,
        status: "done",
        updatedAt: now - 10_000,
        cliSessionBindings: {
          "claude-cli": { sessionId: "existing-claude-cli-session" },
        },
        cliSessionIds: {
          "claude-cli": "existing-claude-cli-session",
        },
        claudeCliSessionId: "existing-claude-cli-session",
      };
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: `${sessionsDir}/sessions.json`,
        entry: staleEntry,
        canonicalKey: "agent:main:main",
      });
      let capturedEntry: Record<string, unknown> | undefined;
      mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
        const store = {
          "agent:main:main": {
            ...staleEntry,
            updatedAt: now,
          },
        };
        const result = await updater(store);
        capturedEntry = result as Record<string, unknown>;
        return result;
      });
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });

      await runMainAgent("hi", "test-idem-terminal-main-fresh-marker");

      const call = await waitForAgentCommandCall<{ sessionId?: string }>();
      expect(call.sessionId).toBe("terminal-main-session");
      expect(capturedEntry?.sessionId).toBe("terminal-main-session");
      expectSqliteSessionFileMarkerForEntry(capturedEntry);
      expect(capturedEntry?.cliSessionIds).toEqual({
        "claude-cli": "existing-claude-cli-session",
      });
      expect(capturedEntry?.claudeCliSessionId).toBe("existing-claude-cli-session");
    });
  });

  it("honors explicit gateway session-id resumes for terminal main rows", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);

    await withTempDir(
      { prefix: "openclaw-gateway-terminal-main-explicit-resume-" },
      async (root) => {
        const sessionsDir = `${root}/sessions`;
        await fs.mkdir(sessionsDir, { recursive: true });
        const sessionFile = "terminal-main-session.jsonl";
        const transcriptPath = `${sessionsDir}/${sessionFile}`;
        await fs.writeFile(
          transcriptPath,
          `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
          "utf8",
        );
        await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
        const existingEntry = {
          sessionId: "terminal-main-session",
          sessionFile,
          status: "done",
          updatedAt: now - 10_000,
          sessionStartedAt: now - 60_000,
          lastInteractionAt: now - 10_000,
          startedAt: now - 20_000,
          endedAt: now - 15_000,
          runtimeMs: 5_000,
        };
        mocks.loadSessionEntry.mockReturnValue({
          cfg: {},
          storePath: `${sessionsDir}/sessions.json`,
          entry: existingEntry,
          canonicalKey: "agent:main:main",
        });
        let capturedEntry: Record<string, unknown> | undefined;
        mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
          const store: Record<string, unknown> = {
            "agent:main:main": { ...existingEntry },
          };
          const result = await updater(store);
          capturedEntry = result as Record<string, unknown>;
          return result;
        });
        mocks.agentCommand.mockResolvedValue({
          payloads: [{ text: "ok" }],
          meta: { durationMs: 100 },
        });

        await invokeAgent({
          message: "resume terminal main",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "terminal-main-session",
          idempotencyKey: "test-idem-terminal-main-explicit-resume",
        } as AgentParams);

        const call = await waitForAgentCommandCall<{ sessionId?: string }>();
        expect(call.sessionId).toBe("terminal-main-session");
        expect(capturedEntry?.sessionId).toBe("terminal-main-session");
        expectSqliteSessionFileMarkerForEntry(capturedEntry);
        expect(capturedEntry?.status).toBe("done");
        expect(capturedEntry?.startedAt).toBe(now - 20_000);
        expect(capturedEntry?.endedAt).toBe(now - 15_000);
        expect(capturedEntry?.runtimeMs).toBe(5_000);
      },
    );
  });

  it.each(["heartbeat", "cron"] as const)(
    "preserves terminal main session reuse for %s gateway runs",
    async (runKind) => {
      const now = Date.parse("2026-05-18T09:49:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      setDateOnlyFakeClockActive(true);
      vi.setSystemTime(now);

      await withTempDir(
        { prefix: `openclaw-gateway-terminal-main-${runKind}-reuse-` },
        async (root) => {
          const sessionsDir = `${root}/sessions`;
          await fs.mkdir(sessionsDir, { recursive: true });
          const sessionFile = `terminal-main-${runKind}.jsonl`;
          const transcriptPath = `${sessionsDir}/${sessionFile}`;
          await fs.writeFile(
            transcriptPath,
            `${JSON.stringify({ type: "session", id: "terminal-main-session" })}\n`,
            "utf8",
          );
          await fs.utimes(transcriptPath, new Date(now - 1_000), new Date(now - 1_000));
          const existingEntry = {
            sessionId: "terminal-main-session",
            sessionFile,
            status: "done",
            updatedAt: now - 10_000,
            sessionStartedAt: now - 60_000,
            lastInteractionAt: now - 10_000,
            startedAt: now - 20_000,
            endedAt: now - 15_000,
            runtimeMs: 5_000,
          };
          mocks.loadSessionEntry.mockReturnValue({
            cfg: {},
            storePath: `${sessionsDir}/sessions.json`,
            entry: existingEntry,
            canonicalKey: "agent:main:main",
          });

          let capturedEntry: Record<string, unknown> | undefined;
          mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
            const store: Record<string, unknown> = {
              "agent:main:main": { ...existingEntry },
            };
            const result = await updater(store);
            capturedEntry = result as Record<string, unknown>;
            return result;
          });
          mocks.agentCommand.mockResolvedValue({
            payloads: [{ text: "ok" }],
            meta: { durationMs: 100 },
          });

          await invokeAgent({
            message: `${runKind} probe`,
            agentId: "main",
            sessionKey: "agent:main:main",
            bootstrapContextRunKind: runKind,
            idempotencyKey: `test-idem-terminal-main-${runKind}-reuse`,
          } as AgentParams);

          const call = await waitForAgentCommandCall<{ sessionId?: string }>();
          expect(call.sessionId).toBe("terminal-main-session");
          expect(capturedEntry?.sessionId).toBe("terminal-main-session");
          expectSqliteSessionFileMarkerForEntry(capturedEntry);
        },
      );
    },
  );

  it("rotates a failed session when its default transcript is missing", async () => {
    const now = Date.parse("2026-05-18T09:48:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    setDateOnlyFakeClockActive(true);
    vi.setSystemTime(now);
    const missingDefaultTranscriptEntry = {
      sessionId: "failed-missing-default-session-id",
      status: "failed",
      updatedAt: now,
      sessionStartedAt: now,
      lastInteractionAt: now,
    };
    mockMainSessionEntry(missingDefaultTranscriptEntry);

    const capturedEntry = await runMainAgentAndCaptureEntry(
      "test-idem-failed-missing-default-transcript",
    );

    const call = await waitForAgentCommandCall<{ sessionId?: string }>();
    expect(call.sessionId).not.toBe("failed-missing-default-session-id");
    expect(capturedEntry?.sessionId).not.toBe("failed-missing-default-session-id");
    expect(capturedEntry?.status).toBeUndefined();
    expectSqliteSessionFileMarkerForEntry(capturedEntry);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
