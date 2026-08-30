/**
 * Tests follow-up session send status transitions and broadcasts.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const loadGatewaySessionEntryReadOnlyMock = vi.fn();
const readSessionMessageCountAsyncMock = vi.fn();
const loadGatewaySessionRowMock =
  vi.fn<typeof import("../session-utils.js").loadGatewaySessionRow>();
const resolveDeletedAgentIdFromSessionKeyMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();
const chatSendWithAdmissionOwnedMock = vi.fn();

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
    loadGatewaySessionEntryReadOnlyMock(...args),
  loadGatewaySessionRow: (...args: Parameters<typeof loadGatewaySessionRowMock>) =>
    loadGatewaySessionRowMock(...args),
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

vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >("../../agents/subagents/registry/subagent-registry-read.js");
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
  };
});

vi.mock("../../agents/subagents/registry/subagent-registry-runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

vi.mock("./chat-send-external-entry.js", () => ({
  handleDirectExternalChatSend: (...args: unknown[]) => chatSendWithAdmissionOwnedMock(...args),
}));

import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
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
  afterEach(() => flushPendingSessionsChangedEvents());

  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadGatewaySessionEntryReadOnlyMock.mockReset();
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(0);
    loadGatewaySessionRowMock.mockReset();
    resolveDeletedAgentIdFromSessionKeyMock.mockReset().mockReturnValue(null);
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
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
      key: childSessionKey,
      kind: "direct",
      updatedAt: 123,
      sessionId: "sess-followup",
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
      status: "running",
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
      expect(chatSendMock).not.toHaveBeenCalled();
    });
  }

  it("sessions.steer delegates interrupt mode and refreshes the pending sequence after admission", async () => {
    const sessionKey = "agent:main:main";
    loadSessionEntryMock.mockReturnValue({
      cfg: {},
      canonicalKey: sessionKey,
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-active" },
    });
    readSessionMessageCountAsyncMock.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    chatSendMock.mockImplementation(
      async ({ params, respond }: { params: unknown; respond: RespondFn }) => {
        expect(params).toMatchObject({
          sessionKey,
          message: "replacement turn",
          idempotencyKey: "steer-after-drain",
          queueMode: "interrupt",
        });
        respond(
          true,
          { runId: "run-steered", status: "started", interruptedActiveRun: true },
          undefined,
          undefined,
        );
      },
    );

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
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(
        true,
        { runId: "run-after-rebuild", status: "started", interruptedActiveRun: true },
        undefined,
        undefined,
      );
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
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(
        true,
        { runId: "steer-fresh", status: "started", interruptedActiveRun: true },
        undefined,
        undefined,
      );
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

    expect(chatSendMock.mock.calls.at(0)?.[0]?.params).toMatchObject({
      queueMode: "interrupt",
      idempotencyKey: "steer-fresh",
    });
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

    expect(readSessionMessageCountAsyncMock).toHaveBeenCalledTimes(1);
    expect(respondMock.mock.calls.at(0)?.[3]).toMatchObject({ cached: true });
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
