/** Covers steer finalize audit honesty: aborted unconfirmed commits must not audit as completed. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.js";
import {
  recordSessionParticipant,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
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
  updateSessionEntry: vi.fn(async () => undefined),
  recordSessionParticipant: vi.fn(),
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
  broadcastChatError: vi.fn(),
}));
vi.mock("../agent-turn/agent-job.js", () => ({
  setGatewayDedupeEntry: vi.fn(),
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
    const params = makeParams();
    prepareSessionParticipantInput(params.ctx, { type: "profile", id: "profile-steerer" }, 42);
    await finalizeAcceptedChatSendMessageInjection(params);
    expect(recordSessionParticipant).toHaveBeenCalledOnce();
    expect(recordSessionParticipant).toHaveBeenCalledWith(expect.anything(), {
      identity: { type: "profile", id: "profile-steerer" },
      promptedAt: 42,
      sessionAgentId: "main",
    });

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

  it("reports indeterminate question input without claiming success or falling back", async () => {
    const errorMessage = "Could not confirm the question response; do not replay it.";
    vi.mocked(finalizeReplyMessageInjectionAttempt).mockResolvedValueOnce({
      status: "indeterminate",
      outcome: { status: "indeterminate", errorMessage },
      targetRunId: "backing-run",
      adoptionError: undefined,
    });
    const params = makeParams();
    params.context.chatRunState.hasAbortMarker = () => false;
    await expect(finalizeAcceptedChatSendMessageInjection(params)).resolves.toBe(true);
    expect(broadcastChatError).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", errorMessage }),
    );
    expect(broadcastChatFinal).not.toHaveBeenCalled();
    expect(emitInboundMessageAuditTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: {
          outcome: "error",
          options: { reason: "question_response_indeterminate", error: errorMessage },
        },
      }),
    );
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

describe("createChatSendMessageInjectionStarter", () => {
  function makeStarterParams(params?: {
    body?: string;
    rawMessage?: string;
    documentContextText?: string;
    isInternalTextSlashCommandTurn?: boolean;
  }) {
    return {
      target: {} as ReplyMessageInjectionTarget,
      request: {
        p: {},
        rawMessage: params?.rawMessage ?? "raw steer",
        supportsTaskSuggestions: false,
      },
      session: { cfg: {}, entry: undefined },
      turn: {
        ctx: { Provider: "dashboard", Body: params?.body },
        isInternalTextSlashCommandTurn: params?.isInternalTextSlashCommandTurn ?? false,
        replyOptionImages: [],
        replyOptionMedia: [],
      },
      imageOrder: [],
      ...(params?.documentContextText ? { documentContextText: params.documentContextText } : {}),
      userTurnTranscriptRecorder: vi.fn(),
    } as unknown as Parameters<typeof createChatSendMessageInjectionStarter>[0];
  }

  it("appends document context to the injected steer text", () => {
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce({} as never);
    createChatSendMessageInjectionStarter(
      makeStarterParams({
        body: "see attached",
        documentContextText: '<file name="note.txt" mime="text/plain">doc body</file>',
      }),
    )();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      'see attached\n\n<file name="note.txt" mime="text/plain">doc body</file>',
      expect.objectContaining({ isInboundUserMessage: true }),
    );
  });

  it("keeps the base text untouched when no document context was rendered", () => {
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce({} as never);
    createChatSendMessageInjectionStarter(makeStarterParams({ body: "plain steer" }))();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "plain steer",
      expect.anything(),
    );
  });

  it("injects document context alone when the steer carries no text", () => {
    vi.mocked(beginReplyMessageInjectionTarget).mockReturnValueOnce({} as never);
    createChatSendMessageInjectionStarter(
      makeStarterParams({
        rawMessage: "",
        documentContextText: '<file name="note.txt" mime="text/plain">x</file>',
      }),
    )();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      '<file name="note.txt" mime="text/plain">x</file>',
      expect.anything(),
    );
  });

  it("returns undefined for internal slash-command turns even with a target", () => {
    expect(
      createChatSendMessageInjectionStarter(
        makeStarterParams({ isInternalTextSlashCommandTurn: true }),
      )(),
    ).toBeUndefined();
    expect(beginReplyMessageInjectionTarget).not.toHaveBeenCalled();
  });
});
