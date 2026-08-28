/** Covers the injection-start admission fence and steer finalize audit honesty. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import { replyMessageInjectionTargetOperation } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import {
  createChatSendMessageInjectionStarter,
  finalizeAcceptedChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../auto-reply/reply/dispatch-from-config.audit.js", () => ({
  emitInboundMessageAuditTerminal: vi.fn(),
}));
vi.mock("../../auto-reply/reply/reply-run-registry.js", () => ({
  beginReplyMessageInjectionTarget: vi.fn(),
  finalizeReplyMessageInjectionAttempt: vi.fn(),
}));
vi.mock("../../auto-reply/reply/message-received-hooks.js", () => ({
  emitMessageReceivedHooks: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(() => null),
  updateSessionEntry: vi.fn(async () => undefined),
}));
vi.mock("../../logging/diagnostic.js", () => ({
  logMessageProcessed: vi.fn(),
  logMessageReceived: vi.fn(),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => undefined),
}));
vi.mock("./chat-broadcast.js", () => ({
  broadcastChatFinal: vi.fn(),
}));
vi.mock("../agent-turn/agent-job.js", () => ({
  setGatewayDedupeEntry: vi.fn(),
}));
vi.mock("../../auto-reply/reply/queue/settings-runtime.js", () => ({
  resolveQueueSettings: vi.fn(() => ({})),
}));
vi.mock("../../auto-reply/command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ senderIsOwner: true })),
}));
vi.mock("../../auto-reply/reply/reply-tool-authority.js", () => ({
  resolveInboundReplyToolAuthorityOverlay: vi.fn(() => ({})),
}));

function makeParams() {
  const context = {
    logGateway: { warn: vi.fn() },
    chatRunState: { hasAbortMarker: () => true },
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
  return {
    context,
    ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
    attempt: {},
    persistUserTurnTranscriptBestEffort: vi.fn(async () => undefined),
    session: {
      agentId: "main",
      cfg: {},
      clientRunId: "run-1",
      entry: undefined,
      sessionKey: "agent:main:dashboard:s",
      storePath: "/tmp/nowhere.json",
    },
    startedAt: Date.now(),
    target: {} as ReplyMessageInjectionTarget,
  } as unknown as Parameters<typeof finalizeAcceptedChatSendMessageInjection>[0];
}

function makeFailClosedEntry() {
  return {
    sessionId: "session-1",
    status: "running",
    restartRecoveryDeliveryRunId: "recovery-1",
    restartRecoveryDeliverySourceRunId: "source-1",
    restartRecoveryDeliveryReceiptState: "terminal-pending",
    restartRecoveryDeliveryToolCallId: "message-call-1",
    updatedAt: 1,
  } as never;
}

function makeStarterParams(params?: { entry?: unknown; loadLatest?: unknown }) {
  return {
    target: { runId: "run-1" } as ReplyMessageInjectionTarget,
    request: {
      p: {},
      rawMessage: "steer",
      supportsTaskSuggestions: false,
    },
    session: {
      cfg: {},
      clientRunId: "run-1",
      entry: params?.entry as never,
      sessionKey: "agent:main:dashboard:s",
      storePath: "/tmp/nowhere.json",
    },
    turn: {
      ctx: { Provider: "dashboard", From: "user", To: "user", Body: "steer" },
      isInternalTextSlashCommandTurn: false,
      replyOptionImages: [],
      replyOptionMedia: [],
    },
    imageOrder: [],
    userTurnTranscriptRecorder: {},
    logGateway: { warn: vi.fn() },
  } as unknown as Parameters<typeof createChatSendMessageInjectionStarter>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("finalizeAcceptedChatSendMessageInjection", () => {
  it("audits a confirmed steer as completed active_run_injected", async () => {
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: { status: "accepted" },
      targetRunId: "run-1",
      aborted: false,
    });
    await finalizeAcceptedChatSendMessageInjection(makeParams());

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed", reason: "active_run_injected" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "completed", options: { reason: "active_run_injected" } },
      }),
    );
    expect(updateSessionEntry).toHaveBeenCalledOnce();
  });

  it("audits an unconfirmed-transcript steer abort as skipped, not completed", async () => {
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "accepted",
      outcome: {
        status: "accepted",
        result: { transcriptCommit: "unconfirmed", errorMessage: "commit timeout" },
      },
      targetRunId: "run-1",
      aborted: true,
    });
    await finalizeAcceptedChatSendMessageInjection(makeParams());

    expect(logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "skipped", reason: "reply_operation_aborted" }),
    );
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: { outcome: "skipped", options: { reason: "reply_operation_aborted" } },
      }),
    );
  });
});

describe("createChatSendMessageInjectionStarter admission fence", () => {
  it("rejects the injection before queueing when the latest persisted entry fail-closes terminal delivery", () => {
    // A terminal receipt committed after prepareChatSendSession captured its
    // dispatch snapshot. The fence must revalidate at the injection-start
    // boundary — before beginReplyMessageInjectionTarget synchronously queues
    // the steer with the target runtime — so nothing is enqueued and the
    // inbound falls back to follow-up dispatch (#128971).
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "delivered-terminal",
      updatedAt: 2,
    } as never);
    const params = makeStarterParams();
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(loadSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ readConsistency: "latest" }),
    );
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });

  it("rejects before queueing when the captured entry itself fail-closes terminal delivery", () => {
    // No reload needed: the entry captured during prepareChatSendSession
    // already records the terminal receipt.
    const params = makeStarterParams({ entry: makeFailClosedEntry() });
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });

  it("follows the latest persisted entry over the stale captured snapshot", () => {
    // The captured snapshot fail-closed after dispatch, but the latest
    // persisted entry is startable again (terminal intent cancelled): the
    // fence must follow the latest state and allow the steer.
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      updatedAt: 2,
    } as never);
    const queuedAttempt = {
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    } as ReplyMessageInjectionAttempt;
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce(queuedAttempt);
    const params = makeStarterParams({ entry: makeFailClosedEntry() });
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBe(queuedAttempt);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
  });

  it("falls back to the captured entry when the latest reload fails", () => {
    vi.mocked(loadSessionEntry).mockImplementationOnce(() => {
      throw new Error("store busy");
    });
    const params = makeStarterParams({ entry: makeFailClosedEntry() });
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });

  it("queues the steer when the latest persisted entry is startable", () => {
    const queuedAttempt = {
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    } as ReplyMessageInjectionAttempt;
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce(queuedAttempt);
    const params = makeStarterParams();
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBe(queuedAttempt);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
  });

  it("queues the steer when the latest persisted entry holds only an unrelated historical tombstone", () => {
    // Terminal run ids are accumulated session history; a tombstone from a
    // prior source must not fence the active source into follow-up mode.
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryTerminalRunIds: ["source-old"],
      updatedAt: 2,
    } as never);
    const queuedAttempt = {
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    } as ReplyMessageInjectionAttempt;
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce(queuedAttempt);
    const params = makeStarterParams({
      entry: { sessionId: "session-1", status: "running", updatedAt: 1 } as never,
    });
    params.target = {
      [replyMessageInjectionTargetOperation]: {} as unknown as ReplyOperation,
      runId: "run-1",
      sourceTurnId: "source-1",
    };
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBe(queuedAttempt);
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
  });

  it("rejects before queueing when the latest persisted entry tombstones the active source turn", () => {
    // The active source turn itself is tombstoned: the steered terminal send
    // would resolve to already-delivered, so the fence must reject.
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryTerminalRunIds: ["source-1"],
      updatedAt: 2,
    } as never);
    const params = makeStarterParams();
    params.target = {
      [replyMessageInjectionTargetOperation]: {} as unknown as ReplyOperation,
      runId: "run-1",
      sourceTurnId: "source-1",
    };
    const begin = createChatSendMessageInjectionStarter(params);

    const attempt = begin();

    expect(attempt).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(params.logGateway.warn).toHaveBeenCalled();
  });
});

describe("gateway steer contract after the injection-start fence", () => {
  it("routes a fail-closed inbound to follow-up dispatch exactly once, with no steer enqueued", () => {
    // Mock-gateway contract: the pre-ACK path creates the starter, invokes
    // it synchronously, and hands the inbound to follow-up dispatch whenever
    // no injection attempt exists. A terminal receipt present at the
    // injection-start boundary must yield exactly one delivery path — the
    // follow-up dispatch — and zero runtime queueMessage calls, instead of
    // the old post-enqueue rejection (steer already queued + fallback
    // second dispatch = inbound double delivery).
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      sessionId: "session-1",
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryToolCallId: "message-call-1",
      updatedAt: 2,
    } as never);
    const dispatchFollowup = vi.fn();
    const begin = createChatSendMessageInjectionStarter(makeStarterParams());

    const attempt = begin();
    if (attempt) {
      throw new Error("unexpected injection attempt for a fail-closed session");
    }
    dispatchFollowup();

    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
    expect(dispatchFollowup).toHaveBeenCalledOnce();
  });
});
