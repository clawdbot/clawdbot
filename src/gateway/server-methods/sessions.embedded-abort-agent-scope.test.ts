/**
 * Caller-path regression: abort / interrupt / lifecycle drain must not cancel
 * an embedded run that only shares a colliding sessionId with another agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { testing as runsTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { interruptSessionRunIfActive } from "./session-run-interruption.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import { prepareSessionLifecycleDrain } from "./sessions-lifecycle-drain.js";
import { createContext } from "./sessions.abort-agent-scope.test-support.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const chatAbortMock = vi.fn();
const loadSessionEntryMock = vi.fn();

vi.mock("./chat-abort-handler.js", () => ({
  handleChatAbortRequestWithLifecycle: (...args: unknown[]) => chatAbortMock(...args),
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
    loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
      loadSessionEntryMock(...(args as [string, { agentId?: string }?])),
  };
});

function createRespond(): RespondFn {
  return vi.fn() as unknown as RespondFn;
}

function mockChatSuccess(): void {
  chatAbortMock.mockImplementationOnce(
    (
      { respond }: { respond: RespondFn },
      lifecycle?: { onAuthorizedAfterQueuedAbort?: () => boolean },
    ) => {
      const additionalAborted = lifecycle?.onAuthorizedAfterQueuedAbort?.() ?? false;
      respond(
        true,
        additionalAborted
          ? { ok: true, aborted: true, runIds: [] }
          : { ok: true, aborted: false, runIds: [] },
      );
    },
  );
}

function createHandle(abort = vi.fn()): EmbeddedAgentQueueHandle {
  return {
    runId: "run-ops-colliding",
    abort,
    isAborted: () => false,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
}

describe("embedded abort agent scope (colliding sessionId)", () => {
  const collidingSessionId = "shared-unknown-session-id";
  const opsKey = "agent:ops:telegram:direct:ops-user";
  const researchKey = "agent:research:telegram:direct:research-user";
  let handle: EmbeddedAgentQueueHandle;
  let abortSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    chatAbortMock.mockReset();
    loadSessionEntryMock.mockReset();
    runsTesting.resetActiveEmbeddedRuns();
    abortSpy = vi.fn();
    handle = createHandle(abortSpy);
    setActiveEmbeddedRun(collidingSessionId, handle, opsKey, undefined, "ops");
  });

  afterEach(() => {
    clearActiveEmbeddedRun(collidingSessionId, handle, opsKey);
    runsTesting.resetActiveEmbeddedRuns();
  });

  it("sessions.abort for another agent leaves the colliding embedded run alive", async () => {
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: collidingSessionId },
    }));
    mockChatSuccess();
    const respond = createRespond();
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "ops" }, { id: "research" }],
      extra: { getSessionEventSubscriberConnIds: () => new Set() },
    });

    await sessionAbortHandlers["sessions.abort"]!({
      req: { type: "req", id: "req-foreign-abort", method: "sessions.abort" },
      params: { key: researchKey, agentId: "research" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortSpy).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunActive(collidingSessionId, { agentId: "ops" })).toBe(true);
    expect(isEmbeddedAgentRunActive(collidingSessionId, { agentId: "research" })).toBe(false);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
      undefined,
    );
  });

  it("interruptSessionRunIfActive for another agent does not abort the colliding run", async () => {
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "ops" }, { id: "research" }],
    }) as GatewayRequestContext;

    const result = await interruptSessionRunIfActive({
      req: { type: "req", id: "req-foreign-interrupt", method: "sessions.compact" } as never,
      context,
      client: null,
      isWebchatConnect: () => false,
      requestedKey: researchKey,
      canonicalKey: researchKey,
      agentId: "research",
      sessionId: collidingSessionId,
    });

    expect(result).toEqual({ interrupted: false });
    expect(abortSpy).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunActive(collidingSessionId, { agentId: "ops" })).toBe(true);
  });

  it("prepareSessionLifecycleDrain for another agent does not abort the colliding run", async () => {
    const context = {
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      cancelRunBoundApprovals: vi.fn(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      chatRunState: { resolveBuffer: () => ({ text: "" }) } as never,
      dedupe: new Map(),
      getRuntimeConfig: () => ({
        agents: { list: [{ id: "main", default: true }, { id: "ops" }, { id: "research" }] },
      }),
      logGateway: { warn: vi.fn() },
      nodeSendToSession: vi.fn(),
      removeChatRun: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set(),
    } as unknown as GatewayRequestContext;

    const drain = await prepareSessionLifecycleDrain({
      action: "delete",
      context,
      storePath: "/tmp/openclaw-research-sessions.json",
      sessionKeys: [researchKey],
      sessionId: collidingSessionId,
      agentId: "research",
      defaultAgentId: "main",
      sessionKey: researchKey,
      lifecycleIdentities: [researchKey, collidingSessionId],
    });

    expect(abortSpy).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunActive(collidingSessionId, { agentId: "ops" })).toBe(true);
    expect(drain.hasAuthoritativeWork()).toBe(false);
    drain.release();
  });

  it("sessions.abort for the owning agent still aborts the colliding sessionId run", async () => {
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      canonicalKey: sessionKey,
      entry: { sessionId: collidingSessionId },
    }));
    mockChatSuccess();
    const respond = createRespond();
    const context = createContext({
      agents: [{ id: "main", default: true }, { id: "ops" }, { id: "research" }],
      extra: { getSessionEventSubscriberConnIds: () => new Set() },
    });

    await sessionAbortHandlers["sessions.abort"]!({
      req: { type: "req", id: "req-owner-abort", method: "sessions.abort" },
      params: { key: opsKey, agentId: "ops" },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(abortSpy).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, status: "aborted" }),
      undefined,
      undefined,
    );
  });
});
