/** Covers steer finalize audit honesty: aborted unconfirmed commits must not audit as completed. */
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { emitInboundMessageAuditTerminal } from "../../auto-reply/reply/dispatch-from-config.audit.js";
import {
  beginReplyMessageInjectionTarget,
  createReplyOperation,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
  type ReplyMessageInjectionTarget,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { RuntimeMsgContext } from "../../auto-reply/templating.js";
import {
  recordSessionParticipant,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { logMessageProcessed } from "../../logging/diagnostic.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import type { ChatImageContent } from "../chat-attachments.js";
import { broadcastChatError, broadcastChatFinal } from "./chat-broadcast.js";
import {
  createChatSendMessageInjectionStarter,
  finalizeAcceptedChatSendMessageInjection,
} from "./chat-send-message-injection.js";
import type { GatewayRequestContext } from "./types.js";

vi.mock("../../auto-reply/reply/dispatch-from-config.audit.js", () => ({
  emitInboundMessageAuditTerminal: vi.fn(),
}));
vi.mock(import("../../auto-reply/reply/reply-run-registry.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    beginReplyMessageInjectionTarget: vi.fn<typeof actual.beginReplyMessageInjectionTarget>(),
    finalizeReplyMessageInjectionAttempt:
      vi.fn<typeof actual.finalizeReplyMessageInjectionAttempt>(),
  };
});
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
  beforeEach(() => {
    vi.mocked(beginReplyMessageInjectionTarget).mockImplementation((target) => ({
      targetRunId: target.runId,
      acceptance: Promise.resolve(true),
      outcome: Promise.resolve({ status: "accepted" }),
    }));
  });

  function makeStarterParams(params?: {
    body?: string;
    rawMessage?: string;
    media?: RuntimeMsgContext["media"];
    documentContext?: Parameters<
      typeof createChatSendMessageInjectionStarter
    >[0]["documentContext"];
    replyOptionImages?: ChatImageContent[];
    isInternalTextSlashCommandTurn?: boolean;
  }): Parameters<typeof createChatSendMessageInjectionStarter>[0] {
    const sessionKey = "agent:main:steer-test";
    const sessionId = "steer-test-session";
    const rawMessage = params?.rawMessage ?? params?.body ?? "raw steer";
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    onTestFinished(() => operation.complete());
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: "active-run",
      supportsQueueMessageImages: true,
      cancel: vi.fn(),
      messageInjection: {
        isAvailable: () => true,
        queueMessage: vi.fn(async () => {}),
      },
    });
    const target = expectDefined(
      replyRunRegistry.resolveCurrentMessageInjectionTarget(sessionKey),
      "Expected the running test operation to accept steering",
    );

    return {
      target,
      request: {
        p: { sessionKey, message: rawMessage, idempotencyKey: "steer-input" },
        rawMessage,
        supportsTaskSuggestions: false,
      },
      session: { cfg: {}, entry: undefined },
      turn: {
        discardUnreferencedMedia: async () => {},
        accountId: undefined,
        ctx: { Provider: "dashboard", Body: params?.body, media: params?.media },
        isInternalTextSlashCommandTurn: params?.isInternalTextSlashCommandTurn ?? false,
        queuedFollowupOwnerKey: undefined,
        pluginBoundMediaPromise: Promise.resolve([]),
        replyOptionImages: params?.replyOptionImages ?? [],
        replyOptionMedia: [],
      },
      imageOrder: [],
      documentContext: params?.documentContext,
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text: params?.body ?? rawMessage, media: params?.media },
        target: createTestUserTurnTranscriptTarget({ sessionKey, sessionId }),
      }),
    };
  }

  it.each([
    {
      caption: "see attached",
      label: "captioned",
      expectedText:
        '[media attached: media://inbound/note.txt (text/plain) "note.txt"]\n\nsee attached\n\n<file name="note.txt" mime="text/plain">doc body</file>',
    },
    {
      caption: "",
      label: "blank-caption",
      expectedText:
        '[media attached: media://inbound/note.txt (text/plain) "note.txt"]\n\n<file name="note.txt" mime="text/plain">doc body</file>',
    },
  ])("retains marker and document text for a $label steer", ({ caption, expectedText }) => {
    const documentText = '<file name="note.txt" mime="text/plain">doc body</file>';
    const params = makeStarterParams({
      body: caption,
      rawMessage: caption,
      media: [
        {
          path: "media://inbound/note.txt",
          contentType: "text/plain",
          kind: "document",
          fileName: "note.txt",
        },
      ],
      documentContext: { status: "rendered", text: documentText, images: [] },
    });
    const durableContext = structuredClone(params.turn.ctx);

    createChatSendMessageInjectionStarter(params)();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledOnce();
    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      params.target,
      expectedText,
      expect.objectContaining({ isInboundUserMessage: true }),
    );
    expect(params.turn.ctx).toEqual(durableContext);
  });

  it("keeps the attachment note when document rendering fails", () => {
    const params = makeStarterParams({
      body: "read the attachment",
      media: [{ path: "media://inbound/note.txt", contentType: "text/plain" }],
      documentContext: { status: "failed" },
    });
    const originalContext = structuredClone(params.turn.ctx);

    createChatSendMessageInjectionStarter(params)();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      params.target,
      "[media attached: media://inbound/note.txt (text/plain)]\n\nread the attachment",
      expect.objectContaining({ isInboundUserMessage: true }),
    );
    expect(params.turn.ctx).toEqual(originalContext);
  });

  it("keeps the base text untouched when no document context was rendered", () => {
    createChatSendMessageInjectionStarter(makeStarterParams({ body: "plain steer" }))();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "plain steer",
      expect.anything(),
    );
  });

  it("merges extracted page images after the prepared inbound images", () => {
    const params = makeStarterParams({
      body: "see attached",
      media: [
        { path: "media://inbound/photo.png", contentType: "image/png" },
        {
          path: "media://inbound/scan.pdf",
          contentType: "application/pdf",
          kind: "document",
        },
      ],
      replyOptionImages: [
        { type: "image", data: "inbound-photo", mimeType: "image/png", sourceIndex: 0 },
      ],
      documentContext: {
        status: "rendered",
        text: "[PDF content rendered to images]",
        images: [
          { type: "image", data: "page-1", mimeType: "image/png", attachmentIndex: 1 },
          { type: "image", data: "page-2", mimeType: "image/png", attachmentIndex: 1 },
        ],
      },
    });
    const durableContext = structuredClone(params.turn.ctx);

    createChatSendMessageInjectionStarter(params)();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "[media attached: 2 files]\n" +
        "[media attached 1/2: media://inbound/photo.png (image/png)]\n" +
        "[media attached 2/2: media://inbound/scan.pdf (application/pdf)]\n\n" +
        "see attached\n\n[PDF content rendered to images]",
      expect.objectContaining({
        images: [
          { type: "image", data: "inbound-photo", mimeType: "image/png", sourceIndex: 0 },
          { type: "image", data: "page-1", mimeType: "image/png", sourceIndex: 1 },
          { type: "image", data: "page-2", mimeType: "image/png", sourceIndex: 1 },
        ],
      }),
    );
    expect(params.turn.ctx).toEqual(durableContext);
  });

  it("injects extracted page images when the steer carries no inbound images", () => {
    createChatSendMessageInjectionStarter(
      makeStarterParams({
        body: "scan attached",
        documentContext: {
          status: "rendered",
          text: "[PDF content rendered to images]",
          images: [{ type: "image", data: "page-1", mimeType: "image/png", attachmentIndex: 0 }],
        },
      }),
    )();

    expect(beginReplyMessageInjectionTarget).toHaveBeenCalledWith(
      expect.anything(),
      "scan attached\n\n[PDF content rendered to images]",
      expect.objectContaining({
        images: [{ type: "image", data: "page-1", mimeType: "image/png", sourceIndex: 0 }],
      }),
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
