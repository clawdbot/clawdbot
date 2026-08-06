/**
 * Tests follow-up session send status transitions and broadcasts.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorShape, ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const loadSessionEntryReadOnlyMock = vi.fn();
const readSessionMessageCountAsyncMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const resolveDeletedAgentIdFromSessionKeyMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();
const isEmbeddedAgentRunActiveMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const waitForEmbeddedAgentRunEndMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const chatSendWithAdmissionOwnedMock = vi.fn();
const handleChatAbortRequestWithLifecycleMock = vi.fn();

vi.mock("../../agents/embedded-agent-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/embedded-agent-runner/runs.js")>(
    "../../agents/embedded-agent-runner/runs.js",
  );
  return {
    ...actual,
    abortEmbeddedAgentRun: (...args: unknown[]) => abortEmbeddedAgentRunMock(...args),
    isEmbeddedAgentRunActive: (...args: unknown[]) => isEmbeddedAgentRunActiveMock(...args),
    waitForEmbeddedAgentRunEnd: (...args: unknown[]) => waitForEmbeddedAgentRunEndMock(...args),
  };
});

vi.mock("../../auto-reply/reply/queue/cleanup.js", async () => {
  const actual = await vi.importActual<typeof import("../../auto-reply/reply/queue/cleanup.js")>(
    "../../auto-reply/reply/queue/cleanup.js",
  );
  return {
    ...actual,
    clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
  };
});

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  loadSessionEntryReadOnly: (...args: unknown[]) => loadSessionEntryReadOnlyMock(...args),
  loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
  resolveDeletedAgentIdFromSessionKey: (...args: unknown[]) =>
    resolveDeletedAgentIdFromSessionKeyMock(...args),
}));

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionMessageCountAsync: (...args: unknown[]) => readSessionMessageCountAsyncMock(...args),
  };
});

vi.mock("../../agents/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/subagent-registry-read.js")>(
    "../../agents/subagent-registry-read.js",
  );
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("../../agents/subagent-registry-runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

vi.mock("./chat-send-handler.js", () => ({
  handleChatSend: (...args: unknown[]) => chatSendWithAdmissionOwnedMock(...args),
}));

vi.mock("./chat-abort-handler.js", () => ({
  handleChatAbortRequestWithLifecycle: (...args: unknown[]) =>
    handleChatAbortRequestWithLifecycleMock(...args),
}));

import { sessionMessagingHandlers } from "./sessions-messaging.js";

function createRequestContext(overrides: Record<string, unknown> = {}): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: { runs: new Map() },
    dedupe: new Map(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig: () => ({}),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

describe("sessions.send completed subagent follow-up status", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadSessionEntryReadOnlyMock.mockReset();
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(0);
    loadGatewaySessionRowMock.mockReset();
    resolveDeletedAgentIdFromSessionKeyMock.mockReset().mockReturnValue(null);
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    abortEmbeddedAgentRunMock.mockReset();
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
    clearSessionQueuesMock.mockReset();
    handleChatAbortRequestWithLifecycleMock
      .mockReset()
      .mockImplementation(async (options: { respond: RespondFn }) => {
        options.respond(true, { ok: true, aborted: true, runIds: ["run-old"] });
      });
    chatSendWithAdmissionOwnedMock
      .mockReset()
      .mockImplementation(
        async (options: { respond: RespondFn }, onAdmissionOwned: () => Promise<boolean>) => {
          if (await onAdmissionOwned()) {
            await chatSendMock(options);
          }
        },
      );
  });

  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} rejects keys belonging to a deleted agent`, async () => {
      const orphanKey = "agent:deleted-agent:main";
      loadSessionEntryMock.mockReturnValue({
        cfg: {},
        canonicalKey: orphanKey,
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "sess-orphan" },
      });
      resolveDeletedAgentIdFromSessionKeyMock.mockReturnValue("deleted-agent");

      const respondMock = vi.fn();
      await expectDefined(
        sessionMessagingHandlers[method],
        "sessionMessagingHandlers[method] test invariant",
      )({
        req: { id: "req-deleted-agent" } as never,
        params: { key: orphanKey, message: "hi" },
        respond: respondMock as unknown as RespondFn,
        context: createRequestContext(),
        client: null,
        isWebchatConnect: () => false,
      });

      expect(respondMock).toHaveBeenCalledWith(false, undefined, {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      });
    });
  }

  it("reactivates completed subagent sessions before broadcasting sessions.changed", async () => {
    const childSessionKey = "agent:main:subagent:followup";
    const completedRun = {
      runId: "run-old",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep" as const,
      createdAt: 1,
      execution: {
        status: "terminal" as const,
        startedAt: 2,
        endedAt: 3,
        outcome: { status: "ok" as const },
      },
    };

    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: childSessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-followup" },
    });
    getLatestSubagentRunByChildSessionKeyMock.mockReturnValue(completedRun);
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);
    loadGatewaySessionRowMock.mockReturnValue({
      status: "running",
      startedAt: 123,
      endedAt: undefined,
      runtimeMs: 10,
    });
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-new", status: "started" }, undefined, undefined);
    });

    const broadcastToConnIds = vi.fn();
    const respondMock = vi.fn();
    const respond = respondMock as unknown as RespondFn;
    const context = createRequestContext({
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
    });

    await expectDefined(
      sessionMessagingHandlers["sessions.send"],
      'sessionMessagingHandlers["sessions.send"] test invariant',
    )({
      req: { id: "req-1" } as never,
      params: {
        key: childSessionKey,
        message: "follow-up",
        idempotencyKey: "run-new",
      },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    const call = respondMock.mock.calls.at(0) as
      | [boolean, { runId?: string; status?: string; messageSeq?: number }, unknown?, unknown?]
      | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.runId).toBe("run-new");
    expect(call?.[1]?.status).toBe("started");
    expect(call?.[1]?.messageSeq).toBe(1);
    expect(call?.[2]).toBeUndefined();
    expect(call?.[3]).toBeUndefined();
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock,
      broadcastToConnIds,
      completedRun,
      childSessionKey,
      task: "follow-up",
    });
  });

  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} returns retryable unavailable before side effects while projection rebuilds`, async () => {
      const sessionKey = "agent:main:main";
      loadSessionEntryMock.mockReturnValue({
        cfg: {},
        canonicalKey: sessionKey,
        storePath: "/tmp/sessions.json",
        entry: { sessionId: "sess-rebuilding" },
      });
      readSessionMessageCountAsyncMock.mockRejectedValue(
        new SessionTranscriptProjectionUnavailableError("sess-rebuilding"),
      );

      const respondMock = vi.fn();
      await expectDefined(
        sessionMessagingHandlers[method],
        "sessionMessagingHandlers[method] test invariant",
      )({
        req: { id: "req-rebuilding" } as never,
        params: {
          key: sessionKey,
          message: "follow-up",
          idempotencyKey: "retry-safe-send",
        },
        respond: respondMock as unknown as RespondFn,
        context: createRequestContext(),
        client: null,
        isWebchatConnect: () => false,
      });

      expect(respondMock).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          details: { method },
          retryable: true,
          retryAfterMs: 250,
        }),
      );
      expect(isEmbeddedAgentRunActiveMock).not.toHaveBeenCalled();
      expect(chatSendMock).not.toHaveBeenCalled();
    });
  }

  it("sessions.steer refreshes the pending sequence after an active run drains", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-active" },
    });
    readSessionMessageCountAsyncMock.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-steered", status: "started" }, undefined, undefined);
    });

    const respondMock = vi.fn();
    await expectDefined(
      sessionMessagingHandlers["sessions.steer"],
      'sessionMessagingHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-after-drain",
      },
      respond: respondMock as unknown as RespondFn,
      context: createRequestContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("sess-active");
    expect(waitForEmbeddedAgentRunEndMock).toHaveBeenCalledWith("sess-active", 15_000);
    expect(readSessionMessageCountAsyncMock).toHaveBeenCalledTimes(2);
    expect(respondMock.mock.calls.at(0)?.[1]).toMatchObject({
      runId: "run-steered",
      messageSeq: 4,
      interruptedActiveRun: true,
    });
  });

  it("sessions.steer refreshes when a run finishes before the active check", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-finished" },
    });
    readSessionMessageCountAsyncMock.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    isEmbeddedAgentRunActiveMock.mockReturnValue(false);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-raced", status: "started" }, undefined, undefined);
    });

    const respondMock = vi.fn();
    await expectDefined(
      sessionMessagingHandlers["sessions.steer"],
      'sessionMessagingHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-raced" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-after-race",
      },
      respond: respondMock as unknown as RespondFn,
      context: createRequestContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(readSessionMessageCountAsyncMock).toHaveBeenCalledTimes(2);
    expect(respondMock.mock.calls.at(0)?.[1]).toMatchObject({
      runId: "run-raced",
      messageSeq: 4,
    });
  });

  it("sessions.steer preserves delivery when projection rebuilds after interruption", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-rebuild-after-interrupt" },
    });
    readSessionMessageCountAsyncMock
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(
        new SessionTranscriptProjectionUnavailableError("sess-rebuild-after-interrupt"),
      );
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-after-rebuild", status: "started" }, undefined, undefined);
    });

    const respondMock = vi.fn();
    await expectDefined(
      sessionMessagingHandlers["sessions.steer"],
      'sessionMessagingHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-rebuild-after-interrupt" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-after-rebuild",
      },
      respond: respondMock as unknown as RespondFn,
      context: createRequestContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("sess-rebuild-after-interrupt");
    expect(chatSendMock).toHaveBeenCalledTimes(1);
    expect(respondMock.mock.calls.at(0)?.[1]).toMatchObject({
      runId: "run-after-rebuild",
      interruptedActiveRun: true,
    });
    expect(respondMock.mock.calls.at(0)?.[1]).not.toHaveProperty("messageSeq");
  });

  it("sessions.steer replaying a cached idempotency key leaves the active run alone", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-unrelated-run" },
    });
    readSessionMessageCountAsyncMock.mockResolvedValue(6);
    // An unrelated run started after the original steer completed.
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "steer-retry", status: "completed" }, undefined, { cached: true });
    });
    chatSendWithAdmissionOwnedMock.mockImplementationOnce(
      async (options: { respond: RespondFn }) => {
        await chatSendMock(options);
      },
    );

    const respondMock = vi.fn();
    await expectDefined(
      sessionMessagingHandlers["sessions.steer"],
      'sessionMessagingHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer-replay" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-retry",
      },
      respond: respondMock as unknown as RespondFn,
      context: createRequestContext({
        dedupe: new Map([
          ["chat:steer-retry", { ts: 1, ok: true, payload: { runId: "steer-retry" } }],
        ]),
      }),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
    expect(readSessionMessageCountAsyncMock).toHaveBeenCalledTimes(1);
    expect(respondMock.mock.calls.at(0)?.[1]).not.toHaveProperty("interruptedActiveRun");
    expect(respondMock.mock.calls.at(0)?.[3]).toMatchObject({ cached: true });
  });

  it("sessions.steer still interrupts the active run for a fresh idempotency key", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-active" },
    });
    readSessionMessageCountAsyncMock.mockResolvedValue(6);
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "steer-fresh", status: "started" }, undefined, undefined);
    });

    const respondMock = vi.fn();
    await expectDefined(
      sessionMessagingHandlers["sessions.steer"],
      'sessionMessagingHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer-fresh" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-fresh",
      },
      respond: respondMock as unknown as RespondFn,
      context: createRequestContext(),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortEmbeddedAgentRunMock).toHaveBeenCalledWith("sess-active");
    expect(clearSessionQueuesMock).toHaveBeenCalledWith([sessionKey, sessionKey, "sess-active"]);
    expect(respondMock.mock.calls.at(0)?.[1]).toMatchObject({ interruptedActiveRun: true });
  });

  it("sessions.steer replaying an in-flight idempotency key leaves its own run alone", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-in-flight" },
    });
    readSessionMessageCountAsyncMock.mockResolvedValue(6);
    isEmbeddedAgentRunActiveMock.mockReturnValue(true);
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "steer-inflight", status: "in_flight" }, undefined, {
        cached: true,
        runId: "steer-inflight",
      });
    });
    chatSendWithAdmissionOwnedMock.mockImplementationOnce(
      async (options: { respond: RespondFn }) => {
        await chatSendMock(options);
      },
    );

    const respondMock = vi.fn();
    await expectDefined(
      sessionMessagingHandlers["sessions.steer"],
      'sessionMessagingHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer-inflight" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-inflight",
      },
      respond: respondMock as unknown as RespondFn,
      // The run the first attempt started is still registered under its own id.
      context: createRequestContext({
        chatAbortControllers: new Map([
          ["steer-inflight", { sessionKey, sessionId: "sess-in-flight" }],
        ]),
      }),
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalled();
    expect(clearSessionQueuesMock).not.toHaveBeenCalled();
    expect(readSessionMessageCountAsyncMock).toHaveBeenCalledTimes(1);
    expect(respondMock.mock.calls.at(0)?.[3]).toMatchObject({ cached: true });
  });

  it("sessions.steer makes a concurrent retry wait for successful interruption", async () => {
    const sessionKey = "agent:main:main";
    const idempotencyKey = "steer-concurrent-success";
    const abortEntered = createDeferred();
    const releaseAbort = createDeferred();
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-concurrent-success" },
    });
    handleChatAbortRequestWithLifecycleMock.mockImplementationOnce(
      async (options: { respond: RespondFn }, lifecycle: { excludeRunIds?: Set<string> }) => {
        expect(lifecycle.excludeRunIds).toEqual(new Set([idempotencyKey]));
        abortEntered.resolve(undefined);
        await releaseAbort.promise;
        options.respond(true, { ok: true, aborted: true, runIds: ["run-old"] });
      },
    );
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: idempotencyKey, status: "started" });
    });
    const context = createRequestContext({
      chatAbortControllers: new Map([
        [
          "run-old",
          {
            sessionKey,
            sessionId: "sess-concurrent-success",
            controlUiVisible: true,
            projectSessionActive: true,
          },
        ],
      ]),
    });
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const invoke = (reqId: string, respond: ReturnType<typeof vi.fn>) =>
      expectDefined(
        sessionMessagingHandlers["sessions.steer"],
        'sessionMessagingHandlers["sessions.steer"] test invariant',
      )({
        req: { id: reqId } as never,
        params: {
          key: sessionKey,
          message: "replacement turn",
          idempotencyKey,
        },
        respond: respond as unknown as RespondFn,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

    const first = invoke("req-concurrent-success-1", firstRespond);
    await abortEntered.promise;
    const second = invoke("req-concurrent-success-2", secondRespond);
    await Promise.resolve();

    expect(secondRespond).not.toHaveBeenCalled();
    expect(handleChatAbortRequestWithLifecycleMock).toHaveBeenCalledTimes(1);
    expect(chatSendMock).not.toHaveBeenCalled();

    releaseAbort.resolve(undefined);
    await Promise.all([first, second]);

    expect(firstRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: idempotencyKey,
        status: "started",
        interruptedActiveRun: true,
      }),
      undefined,
    );
    expect(secondRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        runId: idempotencyKey,
        status: "started",
        interruptedActiveRun: true,
      }),
      undefined,
      { cached: true },
    );
    expect(chatSendMock).toHaveBeenCalledTimes(1);
  });

  it("sessions.steer replays interruption failure to a concurrent retry", async () => {
    const sessionKey = "agent:main:main";
    const idempotencyKey = "steer-concurrent-failure";
    const abortEntered = createDeferred();
    const releaseAbort = createDeferred();
    const interruptError = errorShape(ErrorCodes.UNAVAILABLE, "interrupt failed");
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-concurrent-failure" },
    });
    handleChatAbortRequestWithLifecycleMock.mockImplementationOnce(
      async (options: { respond: RespondFn }) => {
        abortEntered.resolve(undefined);
        await releaseAbort.promise;
        options.respond(false, undefined, interruptError);
      },
    );
    const context = createRequestContext({
      chatAbortControllers: new Map([
        [
          "run-old",
          {
            sessionKey,
            sessionId: "sess-concurrent-failure",
            controlUiVisible: true,
            projectSessionActive: true,
          },
        ],
      ]),
    });
    const firstRespond = vi.fn();
    const secondRespond = vi.fn();
    const invoke = (reqId: string, respond: ReturnType<typeof vi.fn>) =>
      expectDefined(
        sessionMessagingHandlers["sessions.steer"],
        'sessionMessagingHandlers["sessions.steer"] test invariant',
      )({
        req: { id: reqId } as never,
        params: {
          key: sessionKey,
          message: "replacement turn",
          idempotencyKey,
        },
        respond: respond as unknown as RespondFn,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

    const first = invoke("req-concurrent-failure-1", firstRespond);
    await abortEntered.promise;
    const second = invoke("req-concurrent-failure-2", secondRespond);
    await Promise.resolve();

    expect(secondRespond).not.toHaveBeenCalled();
    expect(handleChatAbortRequestWithLifecycleMock).toHaveBeenCalledTimes(1);

    releaseAbort.resolve(undefined);
    await Promise.all([first, second]);

    expect(firstRespond).toHaveBeenCalledWith(false, undefined, interruptError);
    expect(secondRespond).toHaveBeenCalledWith(false, undefined, interruptError, {
      cached: true,
    });
    expect(chatSendMock).not.toHaveBeenCalled();
  });

  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} passes selected-global agent scope through chat.send`, async () => {
      const cfg = { agents: { list: [{ id: "main", default: true }, { id: "work" }] } };
      loadSessionEntryMock.mockReturnValue({
        cfg,
        canonicalKey: "global",
        storePath: "/tmp/work/sessions.json",
        entry: { sessionId: "sess-work-global" },
      });
      loadGatewaySessionRowMock.mockReturnValue(null);
      chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
        respond(true, { runId: "run-work", status: "started" }, undefined, undefined);
      });

      const respondMock = vi.fn();
      const respond = respondMock as unknown as RespondFn;
      const context = createRequestContext({ getRuntimeConfig: () => cfg });

      await expectDefined(
        sessionMessagingHandlers[method],
        "sessionMessagingHandlers[method] test invariant",
      )({
        req: { id: "req-1" } as never,
        params: {
          key: "global",
          agentId: "work",
          message: "follow-up",
          idempotencyKey: "run-work",
        },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });

      expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
      const chatSendCall = chatSendMock.mock.calls.at(0)?.[0] as
        | { params?: Record<string, unknown> }
        | undefined;
      expect(chatSendCall?.params).toMatchObject({
        sessionKey: "global",
        agentId: "work",
        message: "follow-up",
      });
      expect(respondMock.mock.calls.at(0)?.[0]).toBe(true);
    });
  }
});
