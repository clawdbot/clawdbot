/**
 * Tests follow-up session send status transitions and broadcasts.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const readSessionMessageCountAsyncMock = vi.fn();
const loadGatewaySessionRowMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const chatSendMock = vi.fn();
const isEmbeddedAgentRunActiveMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const waitForEmbeddedAgentRunEndMock = vi.fn();

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

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
    loadGatewaySessionRow: (...args: unknown[]) => loadGatewaySessionRowMock(...args),
  };
});

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

vi.mock("../session-subagent-reactivation.runtime.js", () => ({
  replaceSubagentRunAfterSteer: (...args: unknown[]) => replaceSubagentRunAfterSteerMock(...args),
}));

vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": (...args: unknown[]) => chatSendMock(...args),
  },
}));

import { sessionsHandlers } from "./sessions.js";

describe("sessions.send completed subagent follow-up status", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(0);
    loadGatewaySessionRowMock.mockReset();
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    chatSendMock.mockReset();
    isEmbeddedAgentRunActiveMock.mockReset().mockReturnValue(false);
    abortEmbeddedAgentRunMock.mockReset();
    waitForEmbeddedAgentRunEndMock.mockReset().mockResolvedValue(true);
  });

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
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
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
    const context = {
      chatAbortControllers: new Map(),
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;

    await expectDefined(
      sessionsHandlers["sessions.send"],
      'sessionsHandlers["sessions.send"] test invariant',
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
        sessionsHandlers[method],
        "sessionsHandlers[method] test invariant",
      )({
        req: { id: "req-rebuilding" } as never,
        params: {
          key: sessionKey,
          message: "follow-up",
          idempotencyKey: "retry-safe-send",
        },
        respond: respondMock as unknown as RespondFn,
        context: {
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
        } as unknown as GatewayRequestContext,
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
      sessionsHandlers["sessions.steer"],
      'sessionsHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-steer" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-after-drain",
      },
      respond: respondMock as unknown as RespondFn,
      context: {
        chatAbortControllers: new Map(),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext,
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
      sessionsHandlers["sessions.steer"],
      'sessionsHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-raced" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-after-race",
      },
      respond: respondMock as unknown as RespondFn,
      context: {
        chatAbortControllers: new Map(),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext,
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
      sessionsHandlers["sessions.steer"],
      'sessionsHandlers["sessions.steer"] test invariant',
    )({
      req: { id: "req-rebuild-after-interrupt" } as never,
      params: {
        key: sessionKey,
        message: "replacement turn",
        idempotencyKey: "steer-after-rebuild",
      },
      respond: respondMock as unknown as RespondFn,
      context: {
        chatAbortControllers: new Map(),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext,
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
      const context = {
        chatAbortControllers: new Map(),
        broadcastToConnIds: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        getRuntimeConfig: () => cfg,
      } as unknown as GatewayRequestContext;

      await expectDefined(
        sessionsHandlers[method],
        "sessionsHandlers[method] test invariant",
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
