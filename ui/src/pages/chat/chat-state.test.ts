import { render, type ReactiveController, type ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { loadChatHistory, type ChatHistoryResult } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import {
  refreshChatMetadata,
  refreshChatModelCatalogOnDemand,
  refreshChatModelAuthStatus,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { resolveChatAvatarUrl, selectedChatSessionRow } from "./chat-state-route.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { renderAssistantAttachments } from "./components/chat-message-attachments.ts";
import { getChatSessionProjection, reduceChatSessionProjection } from "./history-merge.ts";
import { scheduleControlUiAfterPaint } from "./performance.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { activatePanel, openSlot } from "./sidebar-layout.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

beforeEach(() => {
  vi.spyOn(assistantIdentity, "loadLocalAssistantIdentity").mockReturnValue({
    avatar: "data:image/png;base64,bG9jYWw=",
  });
});

afterEach(() => {
  replaceSlashCommands(buildFallbackSlashCommands());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("canonical session message recovery", () => {
  function createSessionEventState(overrides: Partial<ChatPageHost> = {}) {
    const request = vi.fn().mockResolvedValue({
      messages: [],
      sessionId: "selected-session",
      thinkingLevel: null,
    });
    const requestUpdate = overrides.requestUpdate ?? vi.fn();
    const state = {
      ...makeChatHost(),
      client: { request } as unknown as GatewayBrowserClient,
      connectionEpoch: 1,
      sessionKey: "agent:main:main",
      currentSessionId: "selected-session",
      chatMessagesBySession: new Map(),
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatStreamStartedAt: null,
      sessions: {
        reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      renderLifecycle: { invalidate: requestUpdate },
      requestUpdate,
      ...overrides,
    } as unknown as ChatPageHost;
    return { request, state };
  }

  function renderedTranscript(state: ChatPageHost) {
    return buildChatItems({
      paneId: "test",
      sessionKey: state.sessionKey,
      runId: state.chatRunId,
      messages: state.chatMessages,
      toolMessages: state.chatToolMessages,
      streamSegments: state.chatStreamSegments,
      stream: state.chatStream,
      streamStartedAt: state.chatStreamStartedAt,
      showToolCalls: true,
    }).flatMap((item) => {
      if (item.kind === "group") {
        return item.messages.map(({ message }) => ({
          role: item.role,
          text: extractText(message),
        }));
      }
      return item.kind === "stream" ? [{ role: "assistant", text: item.text }] : [];
    });
  }

  it("rejects envelope-only sequence for an incomplete imported user identity", () => {
    const { state } = createSessionEventState({ connected: false });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        messageId: "conflicting-native-envelope",
        messageSeq: 90,
        message: {
          role: "user",
          content: [{ type: "text", text: "Incomplete imported prompt" }],
          __openclaw: { importedFrom: "claude-cli", externalId: "source-local-user" },
        },
      },
    });

    expect(state.chatMessages).toEqual([]);
  });

  it("keeps the persisted sequence for an incomplete imported user identity", () => {
    const { state } = createSessionEventState({ connected: false });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        messageId: "conflicting-native-envelope",
        messageSeq: 90,
        message: {
          role: "user",
          content: [{ type: "text", text: "Persisted imported prompt" }],
          __openclaw: { importedFrom: "claude-cli", externalId: "source-local-user", seq: 3 },
        },
      },
    });

    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toMatchObject({
      __openclaw: { importedFrom: "claude-cli", externalId: "source-local-user", seq: 3 },
    });
  });

  it.each(["active-run", undefined])(
    "retires durable mirrored commentary owned by %s",
    (ownerRunId) => {
      const runId = "active-run";
      const itemId = "commentary-1";
      const text = "Checking the workspace.";
      const { state } = createSessionEventState({
        connected: false,
        chatMessages: [],
        chatRunId: runId,
        chatStream: null,
        chatStreamSegments: [{ text, ts: 1, runId, itemId }],
        chatToolMessages: [],
      });

      applySessionMessagePayload(
        state,
        {
          sessionKey: state.sessionKey,
          messageId: "commentary-message-1",
          messageSeq: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            idempotencyKey: `codex-app-server:thread:turn:commentary:${itemId}`,
            __openclaw: {
              mirrorOrigin: "codex-app-server",
              ...(ownerRunId ? { runId: ownerRunId } : {}),
            },
            timestamp: 1,
            openclawStreamFallback: {
              replacementText: text,
              source: "segment",
              itemId,
            },
          },
        },
        true,
        { kind: "history-delta" },
      );

      expect(state.chatStreamSegments).toEqual([]);
      expect(renderedTranscript(state)).toEqual([{ role: "assistant", text }]);
    },
  );

  it("retires the complete transient projection when the durable terminal arrives", () => {
    const runId = "active-run";
    const siblingRunId = "sibling-run";
    const finalText = "The durable terminal reply.";
    const toolMessage = { role: "assistant", runId, toolCallId: "tool-1" };
    const siblingToolMessage = {
      role: "assistant",
      runId: siblingRunId,
      toolCallId: "tool-2",
    };
    const toolIdentity = buildToolStreamIdentity(runId, "tool-1");
    const siblingToolIdentity = buildToolStreamIdentity(siblingRunId, "tool-2");
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [],
      chatRunId: runId,
      chatStream: finalText,
      chatStreamStartedAt: 1,
      chatStreamSegments: [
        { text: "Commentary", ts: 1, runId, itemId: "commentary-1" },
        {
          text: "Sibling commentary",
          ts: 1,
          runId: siblingRunId,
          itemId: "commentary-2",
        },
      ],
      chatToolMessages: [toolMessage, siblingToolMessage],
      toolStreamById: new Map([
        [
          toolIdentity,
          {
            message: toolMessage,
            name: "exec",
            receivedAt: 1,
            runId,
            startedAt: 1,
            toolCallId: "tool-1",
          },
        ],
        [
          siblingToolIdentity,
          {
            message: siblingToolMessage,
            name: "read",
            receivedAt: 1,
            runId: siblingRunId,
            startedAt: 1,
            toolCallId: "tool-2",
          },
        ],
      ]),
      toolStreamOrder: [toolIdentity, siblingToolIdentity],
      activityEventSeqById: new Map([
        [`tool:${JSON.stringify([runId, "tool-1"])}:result`, 2],
        [`tool:${JSON.stringify([siblingRunId, "tool-2"])}:result`, 2],
      ]),
      knownAgentRunIds: new Set([runId, siblingRunId]),
      waitingApprovalStatuses: new Map([
        ["approval-1", { approvalId: "approval-1", toolCallId: "tool-1", runId }],
        ["approval-2", { approvalId: "approval-2", toolCallId: "tool-2", runId: siblingRunId }],
      ]),
    });

    applySessionMessagePayload(
      state,
      {
        sessionKey: state.sessionKey,
        runId,
        messageId: "terminal-message",
        messageSeq: 2,
        message: {
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: 2,
        },
      },
      false,
      { kind: "live", activeRunId: runId },
    );

    expect(state.chatMessages.filter((message) => extractText(message) === finalText)).toHaveLength(
      1,
    );
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamSegments).toEqual([
      {
        text: "Sibling commentary",
        ts: 1,
        runId: siblingRunId,
        itemId: "commentary-2",
      },
    ]);
    expect(state.chatToolMessages).toEqual([siblingToolMessage]);
    expect(state.toolStreamById.has(toolIdentity)).toBe(false);
    expect(state.toolStreamById.has(siblingToolIdentity)).toBe(true);
    expect(state.toolStreamOrder).toEqual([siblingToolIdentity]);
    expect(state.knownAgentRunIds).toEqual(new Set([siblingRunId]));
    expect([...state.waitingApprovalStatuses.keys()]).toEqual(["approval-2"]);
    expect([...(state.activityEventSeqById?.keys() ?? [])]).toEqual([
      `tool:${JSON.stringify([siblingRunId, "tool-2"])}:result`,
    ]);
  });

  it.each([
    { persistence: "before-stream", terminal: "final" },
    { persistence: "between-deltas", terminal: "final" },
    { persistence: "after-stream", terminal: "final" },
    { persistence: "after-tool", terminal: "final" },
    { persistence: "before-stream", terminal: "error" },
  ])(
    "renders one durable answer while finishing with persistence $persistence and $terminal",
    ({ persistence, terminal }) => {
      const runId = "finishing-run";
      const text = "The workspace changes are ready.";
      const partial = "The workspace";
      const { state, request } = createSessionEventState({
        chatRunId: runId,
        chatStream: null,
        chatStreamSegments: [],
        chatToolMessages: [],
      });
      let agentSeq = 0;
      const delta = (snapshot: string, deltaText: string) => {
        handlePageGatewayEvent(state, {
          type: "event",
          event: "agent",
          payload: {
            sessionKey: state.sessionKey,
            runId,
            seq: ++agentSeq,
            ts: 1,
            stream: "assistant",
            data: { text: snapshot, delta: deltaText },
          },
        });
        handlePageGatewayEvent(state, {
          type: "event",
          event: "chat",
          payload: {
            sessionKey: state.sessionKey,
            runId,
            state: "delta",
            deltaText,
            message: { role: "assistant", content: [{ type: "text", text: snapshot }] },
          },
        });
      };
      const persist = () =>
        handlePageGatewayEvent(state, {
          type: "event",
          event: "session.message",
          payload: {
            sessionKey: state.sessionKey,
            runId,
            hasActiveRun: true,
            messageId: "durable-answer",
            messageSeq: 2,
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              __openclaw: { id: "durable-answer", seq: 2, runId },
            },
          },
        });
      if (persistence === "before-stream") {
        persist();
      }
      delta(partial, partial);
      if (persistence === "between-deltas") {
        persist();
      }
      delta(text, text.slice(partial.length));
      if (persistence === "after-stream") {
        persist();
      }
      if (persistence === "after-tool") {
        handlePageGatewayEvent(state, {
          type: "event",
          event: "agent",
          payload: {
            sessionKey: state.sessionKey,
            runId,
            seq: ++agentSeq,
            ts: 2,
            stream: "tool",
            data: { phase: "result", toolCallId: "workspace-tool", name: "read" },
          },
        });
        persist();
      }
      handlePageGatewayEvent(state, {
        type: "event",
        event: "agent",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          seq: ++agentSeq,
          ts: 3,
          stream: "lifecycle",
          data: { phase: "finishing" },
        },
      });
      expect(renderedTranscript(state).filter((entry) => entry.text)).toEqual([
        { role: "assistant", text },
      ]);
      expect(state.chatRunId).toBe(runId);
      expect(request).not.toHaveBeenCalledWith("chat.history", expect.anything());

      // Replayed cumulative deltas must not revive the retired projection.
      delta(text, text.slice(partial.length));
      expect(renderedTranscript(state).filter((entry) => entry.text)).toEqual([
        { role: "assistant", text },
      ]);
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          state: terminal,
          ...(terminal === "error" ? { errorMessage: "Workspace reconciliation failed." } : {}),
          message: { role: "assistant", content: [{ type: "text", text }] },
        },
      });
      delta(text, text);
      expect(state.chatRunId).toBeNull();
      expect(renderedTranscript(state).filter((entry) => entry.text)).toEqual([
        { role: "assistant", text },
      ]);
      expect(state.chatMessages.filter((message) => extractText(message) === text)).toHaveLength(1);
      if (terminal === "error") {
        expect(state.chatRunError?.summary).toContain("Workspace reconciliation failed.");
      }
    },
  );

  it("preserves repeated commentary and distinct answers within the same active run", () => {
    const runId = "repeated-run";
    const text = "Checking the workspace.";
    const { state } = createSessionEventState({
      connected: false,
      chatRunId: runId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
    });
    for (const itemId of ["commentary-one", "commentary-two"]) {
      handlePageGatewayEvent(state, {
        type: "event",
        event: "agent",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          seq: 1,
          ts: 1,
          stream: "item",
          data: { kind: "preamble", itemId, progressText: text },
        },
      });
    }
    const stream = (snapshot: string) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          state: "delta",
          message: { role: "assistant", content: [{ type: "text", text: snapshot }] },
        },
      });
    const persist = (id: string, seq: number, itemId?: string) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          hasActiveRun: true,
          messageId: id,
          messageSeq: seq,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            ...(itemId
              ? { openclawStreamFallback: { itemId, source: "segment", replacementText: text } }
              : {}),
          },
        },
      });
    persist("durable-commentary", 1, "commentary-one");
    stream(text);
    expect(renderedTranscript(state).map((entry) => entry.text)).toEqual([text, text, text]);
    persist("first-answer", 2);
    expect(renderedTranscript(state).map((entry) => entry.text)).toEqual([text, text, text]);
    stream(`${text} ${text}`);
    expect(renderedTranscript(state).map((entry) => entry.text)).toEqual([text, text, text, text]);
    persist("second-answer", 3);
    expect(renderedTranscript(state).map((entry) => entry.text)).toEqual([text, text, text, text]);
    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatStreamSegments.filter((segment) => segment.itemId)).toHaveLength(1);
  });

  it("keeps cumulative assistant output split across an authoritative steer", () => {
    const activeRunId = "active-run";
    const steerRunId = "steer-request";
    const originalPrompt = {
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      timestamp: 100,
      __openclaw: {
        id: "original-user",
        idempotencyKey: `${activeRunId}:user`,
        seq: 1,
      },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [originalPrompt],
      chatRunId: activeRunId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "delta",
        deltaText: "Before steer.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Before steer." }],
        },
      },
    });
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: "Before steer." },
    ]);
    expect(state.chatRunId).toBe(activeRunId);
    expect(state.chatQueue).toEqual([]);
    reduceChatSessionProjection(state, {
      type: "sendPending",
      runId: steerRunId,
      message: {
        role: "user",
        content: [{ type: "text", text: "Steer prompt" }],
        timestamp: 50,
        __openclaw: { idempotencyKey: `${steerRunId}:user` },
      },
    });
    state.chatRunId = steerRunId;

    const steerEvent = {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: activeRunId,
        hasActiveRun: true,
        messageId: "persisted-steer-user",
        messageSeq: 2,
        message: {
          role: "user",
          content: [{ type: "text", text: "Steer prompt" }],
          timestamp: 50,
          __openclaw: {
            id: "persisted-steer-user",
            idempotencyKey: `${steerRunId}:user`,
            seq: 2,
            steerTargetRunId: activeRunId,
          },
        },
      },
    } satisfies Parameters<typeof handlePageGatewayEvent>[1];
    handlePageGatewayEvent(state, steerEvent);
    expect(state.chatRunId).toBe(activeRunId);
    const segmentsAfterRequestBoundary = state.chatStreamSegments;
    expect(segmentsAfterRequestBoundary.at(-1)?.boundaryRunId).toBe(steerRunId);
    expect(state.chatStreamSegments).toBe(segmentsAfterRequestBoundary);
    expect(
      state.chatMessages.filter((message) => extractText(message) === "Steer prompt"),
    ).toHaveLength(1);
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "delta",
        deltaText: " After steer.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Before steer. After steer." }],
        },
      },
    });

    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: "Before steer." },
      { role: "user", text: "Steer prompt" },
      { role: "assistant", text: "After steer." },
    ]);

    handlePageGatewayEvent(state, steerEvent);
    expect(state.chatStreamSegments).toBe(segmentsAfterRequestBoundary);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Before steer. After steer. Final unseen suffix." }],
        },
      },
    });
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: "Before steer." },
      { role: "user", text: "Steer prompt" },
      { role: "assistant", text: "After steer. Final unseen suffix." },
    ]);
  });

  it.each([
    {
      name: "the persisted reply lands after the terminal event",
      persistedFirst: false,
      producerOwned: false,
      runActive: false,
    },
    {
      name: "the persisted reply lands before the terminal event",
      persistedFirst: true,
      producerOwned: false,
      runActive: false,
    },
    {
      name: "the producer-owned persisted reply lands while its run is still active",
      persistedFirst: true,
      producerOwned: true,
      runActive: true,
    },
    {
      name: "the producer-owned persisted reply lands after its terminal event",
      persistedFirst: false,
      producerOwned: true,
      runActive: false,
    },
    {
      name: "the producer-owned persisted partial lands before its aborted terminal event",
      persistedFirst: true,
      producerOwned: true,
      runActive: true,
      aborted: true,
    },
  ])("renders one assistant reply when $name", async (scenario) => {
    const activeRunId = "active-run";
    const replyText = "Here is the answer.";
    const persistedReplyIdentity = { id: "persisted-reply", seq: 2 };
    const prompt = {
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      __openclaw: { id: "original-user", idempotencyKey: `${activeRunId}:user`, seq: 1 },
    };
    const persistedReply = {
      role: "assistant",
      content: [{ type: "text", text: replyText }],
      __openclaw: persistedReplyIdentity,
      ...(scenario.aborted
        ? {
            idempotencyKey: `${activeRunId}:assistant`,
            openclawAbort: { aborted: true, origin: "placement-abandon", runId: activeRunId },
          }
        : {}),
    };
    const { state } = createSessionEventState({
      chatMessages: [prompt],
      chatRunId: activeRunId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
      client: {
        request: vi.fn().mockResolvedValue({
          messages: [prompt, persistedReply],
          sessionId: "selected-session",
          sessionInfo: {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            hasActiveRun: false,
            activeRunIds: [],
            status: "done",
          },
        }),
      } as unknown as GatewayBrowserClient,
    });
    // The Gateway persists the reply and ends the run on independent lanes, so
    // the pane must reconcile the durable row with its own terminal projection
    // in either arrival order.
    const persistedEvent = {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        ...(scenario.producerOwned ? { runId: activeRunId } : {}),
        hasActiveRun: scenario.runActive,
        messageId: "persisted-reply",
        messageSeq: 2,
        message: persistedReply,
      },
    } satisfies Parameters<typeof handlePageGatewayEvent>[1];
    const terminalEvent = {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: scenario.aborted ? "aborted" : "final",
        message: { role: "assistant", content: [{ type: "text", text: replyText }] },
      },
    } satisfies Parameters<typeof handlePageGatewayEvent>[1];

    for (const event of scenario.persistedFirst
      ? [persistedEvent, terminalEvent]
      : [terminalEvent, persistedEvent]) {
      handlePageGatewayEvent(state, event);
    }
    await loadChatHistory(state as unknown as Parameters<typeof loadChatHistory>[0]);

    // Rendering collapses consecutive identical messages behind a count badge,
    // so the transcript itself has to hold exactly one copy of the reply.
    const canonicalReply = {
      ...persistedReply,
      __openclaw: {
        ...persistedReplyIdentity,
        ...(scenario.producerOwned ? { runId: activeRunId } : {}),
        ...(scenario.aborted ? { idempotencyKey: `${activeRunId}:assistant` } : {}),
      },
    };
    expect(state.chatMessages.filter((message) => extractText(message) === replyText)).toEqual([
      canonicalReply,
    ]);
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: replyText },
    ]);
  });

  it.each([
    { name: "omitted", terminalMessage: undefined, startsActive: true, pendingReload: false },
    { name: "null", terminalMessage: null, startsActive: true, pendingReload: false },
    {
      name: "omitted for an idle selected session",
      terminalMessage: undefined,
      startsActive: false,
      pendingReload: false,
    },
    {
      name: "omitted while a session-message reload is pending",
      terminalMessage: undefined,
      startsActive: true,
      pendingReload: true,
    },
  ])(
    "recovers the durable reply when the terminal message is $name",
    async ({ terminalMessage, startsActive, pendingReload }) => {
      const runId = "run-with-message-less-terminal";
      const replyText = "The durable reply must appear below Done.";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Finish the dashboard task" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const persistedReply = {
        role: "assistant",
        content: [{ type: "text", text: replyText }],
        stopReason: "stop",
        __openclaw: { id: "reply-1", runId, seq: 2 },
      };
      const request = vi.fn().mockResolvedValue({
        messages: [prompt, persistedReply],
        sessionId: "selected-session",
        sessionInfo: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        },
      });
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: startsActive ? runId : null,
        chatStream: null,
        chatStreamSegments: [],
        chatToolMessages: [],
        pendingSessionMessageReloadSessionKey: pendingReload ? "agent:main:main" : null,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          state: "final",
          message: terminalMessage,
        },
      });

      expect(state.chatRunId).toBeNull();
      expect(renderedTranscript(state)).toEqual([
        { role: "user", text: "Finish the dashboard task" },
      ]);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.history", {
          agentId: "main",
          sessionKey: state.sessionKey,
          limit: 100,
        }),
      );
      await vi.waitFor(() => expect(state.chatLoading).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(renderedTranscript(state)).toEqual([
          { role: "user", text: "Finish the dashboard task" },
          { role: "assistant", text: replyText },
        ]),
      );

      request.mockClear();
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId,
          state: "final",
          message: terminalMessage,
        },
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("stops terminal recovery after a media-only reply becomes durable", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-with-media-only-terminal";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Show the generated image" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const persistedReply = {
        role: "assistant",
        content: [{ type: "image", url: "data:image/png;base64,aW1hZ2U=" }],
        stopReason: "stop",
        __openclaw: { id: "reply-1", runId, seq: 2 },
      };
      const request = vi.fn().mockResolvedValue({
        messages: [prompt, persistedReply],
        sessionId: "selected-session",
        sessionInfo: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        },
      });
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { sessionKey: state.sessionKey, runId, state: "final" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(state.chatMessages).toContainEqual(persistedReply);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry terminal recovery after the selected session changes", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-before-session-switch";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Finish before I switch sessions" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const request = vi.fn().mockResolvedValue({
        messages: [prompt],
        sessionId: "selected-session",
        sessionInfo: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        },
      });
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { sessionKey: state.sessionKey, runId, state: "final" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      state.sessionKey = "agent:main:replacement";
      await vi.advanceTimersByTimeAsync(100);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry terminal recovery after the selected global agent changes", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-before-global-agent-switch";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Finish before I switch global agents" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const request = vi.fn().mockResolvedValue({
        messages: [prompt],
        sessionId: "selected-session",
        sessionInfo: {
          key: "global",
          kind: "global",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        },
      });
      const { state } = createSessionEventState({
        sessionKey: "global",
        assistantAgentId: "main",
        agentsSelectedId: "main",
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "global",
          agents: [{ id: "main" }, { id: "work" }],
        },
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { sessionKey: state.sessionKey, agentId: "main", runId, state: "final" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenLastCalledWith(
        "chat.history",
        expect.objectContaining({ sessionKey: "global", agentId: "main" }),
      );
      state.assistantAgentId = "work";
      state.agentsSelectedId = "work";
      await vi.advanceTimersByTimeAsync(100);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry terminal recovery after a replacement foreground run starts", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-before-replacement";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Finish before the next run starts" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const request = vi.fn().mockResolvedValue({
        messages: [prompt],
        sessionId: "selected-session",
        sessionInfo: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        },
      });
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { sessionKey: state.sessionKey, runId, state: "final" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      state.chatRunId = "replacement-run";
      await vi.advanceTimersByTimeAsync(100);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume terminal recovery after a replacement foreground run finishes", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-before-completed-replacement";
      const replacementRunId = "replacement-run-that-finishes";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Finish before the next run completes" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
      };
      const request = vi.fn().mockResolvedValue({
        messages: [prompt],
        sessionId: "selected-session",
        sessionInfo: {
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        },
      });
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { sessionKey: state.sessionKey, runId, state: "final" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      state.chatRunId = replacementRunId;
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: {
          sessionKey: state.sessionKey,
          runId: replacementRunId,
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Replacement finished." }],
            __openclaw: { id: "replacement-reply", runId: replacementRunId, seq: 2 },
          },
        },
      });
      expect(state.chatRunId).toBeNull();
      expect(
        getChatSessionProjection(state, state.chatMessages).runs[replacementRunId]?.status,
      ).toBe("completed");

      await vi.advanceTimersByTimeAsync(100);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues terminal recovery when history backfills another run", async () => {
    vi.useFakeTimers();
    try {
      const runId = "run-after-history-backfill";
      const historicalRunId = "older-run-from-history";
      const prompt = {
        role: "user",
        content: [{ type: "text", text: "Finish after loading older history" }],
        __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 2 },
      };
      const historicalReply = {
        role: "assistant",
        content: [{ type: "text", text: "An older durable reply." }],
        __openclaw: { id: "historical-reply", runId: historicalRunId, seq: 1 },
      };
      const persistedReply = {
        role: "assistant",
        content: [{ type: "text", text: "The current reply is now durable." }],
        __openclaw: { id: "current-reply", runId, seq: 3 },
      };
      const sessionInfo = {
        key: "agent:main:main",
        kind: "direct" as const,
        updatedAt: 3,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done" as const,
      };
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          messages: [historicalReply, prompt],
          sessionId: "selected-session",
          sessionInfo,
        })
        .mockResolvedValueOnce({
          messages: [historicalReply, prompt, persistedReply],
          sessionId: "selected-session",
          sessionInfo,
        });
      const { state } = createSessionEventState({
        chatMessages: [prompt],
        chatHistoryPagination: { hasMore: false },
        chatRunId: runId,
        client: { request } as unknown as GatewayBrowserClient,
      });

      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { sessionKey: state.sessionKey, runId, state: "final" },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(state.chatMessages).toContainEqual(historicalReply);
      await vi.advanceTimersByTimeAsync(100);
      expect(request).toHaveBeenCalledTimes(2);
      expect(state.chatMessages).toContainEqual(persistedReply);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "without a pending session-message reload", pendingReload: false },
    { name: "after a pending session-message reload", pendingReload: true },
  ])("starts a fresh history request $name", async ({ pendingReload }) => {
    const runId = "run-with-pre-final-history";
    const prompt = {
      role: "user",
      content: [{ type: "text", text: "Finish after the stale snapshot" }],
      __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const persistedReply = {
      role: "assistant",
      content: [{ type: "text", text: "The post-final snapshot contains this reply." }],
      stopReason: "stop",
      __openclaw: { id: "reply-1", runId, seq: 2 },
    };
    const staleHistory = createDeferred<ChatHistoryResult>();
    const freshHistory = createDeferred<ChatHistoryResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(staleHistory.promise)
      .mockReturnValueOnce(freshHistory.promise);
    const { state } = createSessionEventState({
      chatMessages: [prompt],
      chatHistoryPagination: { hasMore: false },
      chatRunId: runId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
      pendingSessionMessageReloadSessionKey: pendingReload ? "agent:main:main" : null,
      client: { request } as unknown as GatewayBrowserClient,
    });
    const sessionInfo = {
      key: state.sessionKey,
      kind: "direct" as const,
      updatedAt: 2,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done" as const,
    };

    const preFinalLoad = loadChatHistory(state);
    expect(request).toHaveBeenCalledTimes(1);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId,
        state: "final",
      },
    });

    expect(request).toHaveBeenCalledTimes(2);
    staleHistory.resolve({ messages: [prompt], sessionId: "selected-session", sessionInfo });
    await preFinalLoad;
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Finish after the stale snapshot" },
    ]);

    freshHistory.resolve({
      messages: [prompt, persistedReply],
      sessionId: "selected-session",
      sessionInfo,
    });
    await vi.waitFor(() => expect(state.chatLoading).toBe(false));
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Finish after the stale snapshot" },
      { role: "assistant", text: "The post-final snapshot contains this reply." },
    ]);
  });

  it("does not reload for a background run's message-less final", () => {
    const request = vi.fn();
    const { state } = createSessionEventState({
      chatRunId: "foreground-run",
      chatStream: "The foreground reply is still streaming.",
      chatStreamStartedAt: 123,
      client: { request } as unknown as GatewayBrowserClient,
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: "background-run",
        state: "final",
      },
    });

    expect(request).not.toHaveBeenCalled();
    expect(state.chatRunId).toBe("foreground-run");
    expect(state.chatStream).toBe("The foreground reply is still streaming.");
    expect(state.chatStreamStartedAt).toBe(123);
  });

  it("does not reload for a yielded message-less final", () => {
    const runId = "yielded-run";
    const request = vi.fn();
    const { state } = createSessionEventState({
      chatRunId: runId,
      client: { request } as unknown as GatewayBrowserClient,
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId,
        state: "final",
        yielded: true,
        stopReason: "end_turn",
      },
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the live final projection without an unnecessary history reload", () => {
    const runId = "run-with-live-terminal-message";
    const prompt = {
      role: "user",
      content: [{ type: "text", text: "Finish the dashboard task" }],
      __openclaw: { id: "prompt-1", idempotencyKey: `${runId}:user`, seq: 1 },
    };
    const request = vi.fn();
    const { state } = createSessionEventState({
      chatMessages: [prompt],
      chatRunId: runId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
      client: { request } as unknown as GatewayBrowserClient,
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The live reply is already projected." }],
        },
      },
    });

    expect(state.chatRunId).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Finish the dashboard task" },
      { role: "assistant", text: "The live reply is already projected." },
    ]);
  });

  it.each([
    { name: "an unowned legacy", runId: undefined },
    { name: "an exactly producer-owned", runId: "older-run" },
  ])("never lets $name delayed older assistant row displace a newer run's reply", ({ runId }) => {
    const olderReply = {
      role: "assistant",
      content: [{ type: "text", text: "Answer from the older run." }],
      __openclaw: { id: "older-reply", seq: 2 },
    };
    const { state } = createSessionEventState({
      chatMessages: [],
      chatRunId: "newer-run",
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: "newer-run",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer from the newer run." }],
        },
      },
    });
    expect(state.chatRunId).toBeNull();

    // The terminal tombstone outlives its run, so a late row carrying some
    // other reply must not borrow that run's ownership and replace it.
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        ...(runId ? { runId } : {}),
        hasActiveRun: false,
        messageId: "older-reply",
        messageSeq: 2,
        message: olderReply,
      },
    });

    expect(state.chatMessages.map((message) => extractText(message))).toEqual([
      "Answer from the newer run.",
    ]);
  });

  it("keeps an ordinary queued user after the active run assistant", () => {
    const activeRunId = "active-run";
    const originalPrompt = {
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      __openclaw: {
        id: "original-user",
        idempotencyKey: `${activeRunId}:user`,
        seq: 1,
      },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [originalPrompt],
      chatRunId: activeRunId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "delta",
        deltaText: "Active reply.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Active reply." }],
        },
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: "queued-run",
        hasActiveRun: true,
        messageId: "ordinary-queued-user",
        messageSeq: 2,
        message: {
          role: "user",
          content: [{ type: "text", text: "Queued follow-up" }],
          __openclaw: {
            id: "ordinary-queued-user",
            idempotencyKey: "queued-run:user",
            seq: 2,
          },
        },
      },
    });

    expect(state.chatStream).toBe("Active reply.");
    expect(state.chatStreamSegments).toEqual([]);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Active reply. Final suffix." }],
        },
      },
    });

    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: "Active reply. Final suffix." },
      { role: "user", text: "Queued follow-up" },
    ]);
    expect(getChatSessionProjection(state, state.chatMessages).messages).toEqual(
      state.chatMessages,
    );
  });

  it("does not rebind an unrelated run from a persisted steer", () => {
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [],
      chatRunId: "run-c",
      chatStream: "Run C",
      chatStreamSegments: [],
      chatToolMessages: [],
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: "run-b",
        hasActiveRun: true,
        messageId: "steer-b",
        messageSeq: 1,
        message: {
          role: "user",
          content: "Steer A",
          __openclaw: {
            id: "steer-b",
            idempotencyKey: "run-b:user",
            seq: 1,
            steerTargetRunId: "run-a",
          },
        },
      },
    });

    expect(state.chatRunId).toBe("run-c");
    expect(state.chatStream).toBe("Run C");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("keeps pre-steer output above an earlier ordinary queued user", () => {
    const activeRunId = "active-run";
    const originalPrompt = {
      role: "user",
      content: [{ type: "text", text: "Original prompt" }],
      timestamp: 100,
      __openclaw: {
        id: "original-user",
        idempotencyKey: `${activeRunId}:user`,
        seq: 1,
      },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [originalPrompt],
      chatRunId: activeRunId,
      chatStream: null,
      chatStreamSegments: [],
      chatToolMessages: [],
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "delta",
        deltaText: "Before steer.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Before steer." }],
        },
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: "queued-run",
        hasActiveRun: true,
        messageId: "ordinary-queued-user",
        messageSeq: 2,
        message: {
          role: "user",
          content: [{ type: "text", text: "Queued follow-up" }],
          timestamp: 200,
          __openclaw: {
            id: "ordinary-queued-user",
            idempotencyKey: "queued-run:user",
            seq: 2,
          },
        },
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: "steer-run",
        hasActiveRun: true,
        messageId: "persisted-steer-user",
        messageSeq: 3,
        message: {
          role: "user",
          content: [{ type: "text", text: "Steer prompt" }],
          timestamp: 300,
          __openclaw: {
            id: "persisted-steer-user",
            idempotencyKey: "steer-run:user",
            seq: 3,
            steerTargetRunId: activeRunId,
          },
        },
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: activeRunId,
        state: "delta",
        deltaText: " After steer.",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Before steer. After steer." }],
        },
      },
    });

    expect(renderedTranscript(state)).toEqual([
      { role: "user", text: "Original prompt" },
      { role: "assistant", text: "Before steer." },
      { role: "user", text: "Queued follow-up" },
      { role: "user", text: "Steer prompt" },
      { role: "assistant", text: "After steer." },
    ]);
  });

  it("keeps a previous run final before a newer active user turn", () => {
    const previousUser = {
      role: "user",
      content: [{ type: "text", text: "What are groups?" }],
      __openclaw: { id: "previous-user", idempotencyKey: "previous-run:user", seq: 1 },
    };
    const currentUser = {
      role: "user",
      content: [{ type: "text", text: "Why were my sessions missing?" }],
      __openclaw: { id: "current-user", idempotencyKey: "current-run:user", seq: 3 },
    };
    const persistedFinal = {
      role: "assistant",
      content: [{ type: "text", text: "Groups organize conversations." }],
      __openclaw: { id: "previous-final", seq: 2 },
    };
    const { state } = createSessionEventState({
      chatMessages: [previousUser, currentUser],
      chatRunId: "current-run",
      chatStream: "Checking external sessions...",
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: "previous-run",
        hasActiveRun: true,
        messageId: "previous-final",
        messageSeq: 2,
        message: persistedFinal,
      },
    });

    expect(state.chatMessages.map((message) => (message as { role?: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(state.chatMessages[1]).toMatchObject({
      content: persistedFinal.content,
      __openclaw: { id: "previous-final", seq: 2 },
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        sessionKey: state.sessionKey,
        runId: "previous-run",
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Groups organize conversations." }],
        },
      },
    });

    expect(state.chatMessages.map((message) => (message as { role?: string }).role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(state.chatRunId).toBe("current-run");
    expect(state.chatStream).toBe("Checking external sessions...");
  });

  it("leaves the active run assistant message on the terminal stream path", () => {
    const currentUser = {
      role: "user",
      content: [{ type: "text", text: "Current prompt" }],
      __openclaw: { id: "current-user", idempotencyKey: "current-run:user", seq: 1 },
    };
    const { state } = createSessionEventState({
      chatMessages: [currentUser],
      chatRunId: "current-run",
      chatStream: "Current partial reply",
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: state.sessionKey,
        clientRunId: "current-run",
        hasActiveRun: true,
        messageId: "current-final",
        messageSeq: 2,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Current final reply" }],
          __openclaw: { id: "current-final", seq: 2 },
        },
      },
    });

    expect(state.chatMessages).toEqual([currentUser]);
    expect(state.chatStream).toBe("Current partial reply");
  });

  it("coalesces distinct live peers into one frame and their stale history into one load", async () => {
    let renderFrame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      renderFrame = callback;
      return 1;
    });
    let resolveHistory!: (result: {
      messages: unknown[];
      sessionId: string;
      thinkingLevel: null;
    }) => void;
    const history = new Promise<{
      messages: unknown[];
      sessionId: string;
      thinkingLevel: null;
    }>((resolve) => {
      resolveHistory = resolve;
    });
    const { request, state } = createSessionEventState({ chatDisplayedLeafEntryId: undefined });
    request.mockReturnValue(history);

    for (const [index, client] of ["web", "tui"].entries()) {
      handlePageGatewayEvent(state, {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          messageId: `conflicting-${client}-envelope`,
          messageSeq: 100 + index,
          message: {
            role: "user",
            content: [{ type: "text", text: "shared prompt" }],
            __openclaw: {
              id: `canonical-${client}-same-text`,
              idempotencyKey: `${client}-same-text-run:user`,
              seq: index + 1,
            },
          },
        },
      });

      expect(state.chatMessages).toHaveLength(index + 1);
      expect(state.requestUpdate).not.toHaveBeenCalled();
    }
    renderFrame?.(0);
    expect(state.requestUpdate).toHaveBeenCalledOnce();

    expect(request).toHaveBeenCalledOnce();
    resolveHistory({
      messages: [],
      sessionId: "selected-session",
      thinkingLevel: null,
    });

    await vi.waitFor(() => expect(state.chatLoading).toBe(false));

    expect(request).toHaveBeenCalledOnce();
    expect(state.chatMessages).toMatchObject([
      { __openclaw: { id: "canonical-web-same-text", seq: 1 } },
      { __openclaw: { id: "canonical-tui-same-text", seq: 2 } },
    ]);
  });

  it("drops pre-reset live and pending messages before accepting a new session turn", () => {
    const retireSessionCompanion = vi.fn();
    const pendingUser = {
      role: "user",
      content: [{ type: "text", text: "Pending before reset" }],
      __openclaw: { idempotencyKey: "pre-reset-pending:user" },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [pendingUser],
    });
    (
      state as ChatPageHost & { retireSessionCompanion: typeof retireSessionCompanion }
    ).retireSessionCompanion = retireSessionCompanion;
    const deliverUser = (id: string, text: string) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          message: {
            role: "user",
            content: [{ type: "text", text }],
            __openclaw: { id, idempotencyKey: `${id}:user`, seq: 1 },
          },
        },
      });

    deliverUser("pre-reset-live", "Live before reset");
    expect(state.chatMessages).toHaveLength(2);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: state.sessionKey,
        agentId: "main",
        reason: "reset",
      },
    });
    expect(state.chatMessages).toEqual([]);
    expect(retireSessionCompanion).toHaveBeenCalledExactlyOnceWith(state.sessionKey, "main");

    deliverUser("post-reset-live", "Live after reset");
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toMatchObject({
      __openclaw: { id: "post-reset-live", seq: 1 },
    });
  });

  it("does not clear the selected transcript when another agent resets", () => {
    const retireSessionCompanion = vi.fn();
    const selectedUser = {
      role: "user",
      content: [{ type: "text", text: "Keep this agent's conversation" }],
      __openclaw: { id: "selected-user", seq: 1 },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [selectedUser],
    });
    (
      state as ChatPageHost & { retireSessionCompanion: typeof retireSessionCompanion }
    ).retireSessionCompanion = retireSessionCompanion;

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:other:main",
        agentId: "other",
        reason: "reset",
      },
    });

    expect(state.chatMessages).toEqual([selectedUser]);
    expect(retireSessionCompanion).toHaveBeenCalledExactlyOnceWith("agent:other:main", "other");
  });

  it("retires current checkout presentation for a structural event", () => {
    const listBranches = vi.fn(() => new Promise<never>(() => {}));
    const { state } = createSessionEventState({
      chatBranches: [
        {
          leafEntryId: "old-leaf",
          headline: "Old checkout",
          messageCount: 1,
          active: true,
        },
      ],
      chatBranchesConnectionEpoch: 1,
      chatBranchesSessionKey: "agent:main:main",
      sessions: {
        listBranches,
        reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
        refresh: vi.fn().mockResolvedValue(undefined),
      } as never,
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: state.sessionKey, agentId: "main", reason: "branch-switch" },
    });

    expect(state.chatBranches).toEqual([]);
    expect(state.chatBranchesSessionKey).toBeNull();
    expect(listBranches).toHaveBeenCalled();
  });

  it.each([
    { sessionKey: "agent:main:main", agentId: "main", reason: "send" },
    { sessionKey: "agent:other:main", agentId: "other", reason: "rewind" },
  ])("preserves checkout presentation for non-matching event $reason/$sessionKey", (payload) => {
    const oldBranches = [
      { leafEntryId: "old-leaf", headline: "Old checkout", messageCount: 1, active: true },
    ];
    const { state } = createSessionEventState({
      chatBranches: oldBranches,
      chatBranchesConnectionEpoch: 1,
      chatBranchesSessionKey: "agent:main:main",
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload,
    });

    expect(state.chatBranches).toBe(oldBranches);
    expect(state.chatBranchesSessionKey).toBe("agent:main:main");
  });

  it("keeps the routed row when a hidden pane observes its archive first", () => {
    const archivedKey = "agent:main:dashboard:archived";
    const sharedHost = makeChatHost({
      sessionKey: archivedKey,
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: archivedKey,
            kind: "direct",
            archived: false,
            derivedTitle: "Archived title",
            updatedAt: 1,
          },
        ],
      },
    });
    expect(sharedHost.sessions.state.result?.sessions).toHaveLength(1);
    const { state } = createSessionEventState({ sessions: sharedHost.sessions });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: { key: archivedKey, sessionKey: archivedKey, archived: true, reason: "update" },
    });

    expect(state.sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key: archivedKey,
        archived: true,
        derivedTitle: "Archived title",
      }),
    ]);
  });

  it("does not mistake identity-only message invalidation for a session reset", () => {
    const selectedUser = {
      role: "user",
      content: [{ type: "text", text: "Keep this pending transcript" }],
      __openclaw: { idempotencyKey: "still-pending:user" },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [selectedUser],
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: state.sessionKey,
        agentId: "main",
        phase: "message",
      },
    });

    expect(state.chatMessages).toEqual([selectedUser]);
  });

  it("reloads selected history for an identity-only persisted message invalidation", async () => {
    const { request, state } = createSessionEventState({ chatRunId: "active-run" });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: state.sessionKey,
        agentId: "main",
        phase: "message",
      },
    });

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("chat.history", {
        agentId: "main",
        sessionKey: state.sessionKey,
        limit: 100,
      });
    });
    expect(state.chatRunId).toBe("active-run");
  });

  it("does not reload another session for an identity-only message invalidation", async () => {
    const { request, state } = createSessionEventState();

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:other:main",
        agentId: "other",
        phase: "message",
      },
    });

    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not reload for an already identified session message", async () => {
    const { request, state } = createSessionEventState();

    handlePageGatewayEvent(state, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: state.sessionKey,
        agentId: "main",
        phase: "message",
        messageId: "already-authoritative-user",
        messageSeq: 3,
      },
    });

    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("defers branch hydration when a session reconciliation finishes after the pane hides", async () => {
    const refreshFinished = createDeferred();
    let presented = true;
    const listBranches = vi.fn().mockResolvedValue([]);
    const { request, state } = createSessionEventState({
      chatRunId: "run-1",
      chatStream: "Finishing",
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
      },
    });
    state.sessions = {
      ...state.sessions,
      listBranches,
      reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
      refresh: vi.fn(async () => {
        await refreshFinished.promise;
        state.sessionsResult = {
          ts: 2,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            {
              key: state.sessionKey,
              kind: "direct",
              hasActiveRun: false,
              status: "done",
              updatedAt: 2,
            },
          ],
        };
      }),
    };

    handlePageGatewayEvent(
      state,
      {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: state.sessionKey,
          runId: "run-1",
          messageId: "terminal-message",
          messageSeq: 2,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Finished" }],
            __openclaw: { id: "terminal-message", seq: 2 },
          },
        },
      },
      () => presented,
    );
    presented = false;
    refreshFinished.resolve();

    await vi.waitFor(() => expect(state.chatRunId).toBeNull());
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(listBranches).not.toHaveBeenCalled();
  });
});

describe("ChatStateController render lifecycle", () => {
  function createObserverState(overrides: Partial<Record<keyof ChatPageHost, unknown>> = {}) {
    const requestUpdate = (overrides.requestUpdate ?? vi.fn()) as ReturnType<typeof vi.fn>;
    return {
      sessionKey: "agent:main:current",
      assistantAgentId: "main",
      agentsList: { defaultId: "main" },
      chatRunId: null,
      observerDigest: null,
      renderLifecycle: { invalidate: requestUpdate },
      requestUpdate,
      ...overrides,
    } as unknown as ChatPageHost;
  }

  function createControllerHost(overrides: Partial<ReactiveControllerHost> = {}) {
    return {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
      ...overrides,
    } satisfies ReactiveControllerHost;
  }

  function createInputHistoryState(
    renderLifecycle: NonNullable<ChatPageHost["renderLifecycle"]>,
    navigateHistory: ReturnType<typeof vi.fn>,
  ) {
    return {
      settings: undefined,
      assistantAgentId: null,
      agentsList: null,
      hello: null,
      sessionKey: "agent:main:current",
      chatLoading: false,
      chatMessages: [],
      chatQueue: [],
      renderLifecycle,
      handleSendChat: vi.fn().mockResolvedValue(undefined),
      handleChatDraftChange: vi.fn(),
      handleChatInputHistoryKey: navigateHistory,
    } as unknown as ChatPageHost;
  }

  function createInputHistoryKey(
    selectionStart: number,
    selectionEnd: number,
    valueLength: number,
  ) {
    return {
      key: "ArrowUp" as const,
      selectionStart,
      selectionEnd,
      valueLength,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    };
  }

  function createStreamEventState(overrides: Partial<ChatPageHost> = {}) {
    const requestUpdate = overrides.requestUpdate ?? vi.fn();
    return {
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatRunId: "run-1",
      chatStream: null,
      chatStreamRenderFrame: null,
      chatStreamStartedAt: 1,
      lastError: null,
      pendingSessionMessageReloadSessionKey: null,
      renderLifecycle: { invalidate: requestUpdate },
      requestUpdate,
      sessionKey: "main",
      ...overrides,
    } as unknown as ChatPageHost;
  }

  function createPageContext() {
    return {
      agents: {
        state: { agentsList: null },
        ensureList: vi.fn(async () => null),
      },
      agentSelection: { state: { selectedId: "main" } },
      basePath: "",
      config: {
        current: {
          allowExternalEmbedUrls: false,
          assistantIdentity: { name: "Assistant" },
          embedSandboxMode: "scripts",
          localMediaPreviewRoots: [],
        },
      },
      initialUserMessage: createInitialUserMessageHandoff(),
      sessions: {},
    } as unknown as ApplicationContext;
  }

  it("owns attachment views in Files without replacing Detail content", () => {
    const state = createPageState(
      createPageContext(),
      { invalidate: vi.fn(), afterCommit: () => () => {} },
      {
        getBoundingClientRect: () => new DOMRect(0, 0, 1_440, 0),
        querySelector: () => null,
      },
    );
    const detailContent = {
      kind: "markdown" as const,
      content: "Existing review",
      rawText: "Existing review",
    };
    state.sidebarContent = detailContent;
    state.sidebarLayout = openSlot(state.sidebarLayout, "detail");

    state.handleOpenSidebar({
      kind: "attachment",
      attachmentKind: "document",
      title: "report.pdf",
      src: "/media/report.pdf",
    });

    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["detail", "workspace"]);
    expect(state.attachmentSidebarContent?.kind).toBe("attachment");
    expect(state.sidebarContent).toBe(detailContent);

    state.sidebarLayout = activatePanel(state.sidebarLayout, "detail");
    state.handleCloseSidebar("detail");

    expect(
      state.sidebarLayout.columns.flatMap((column) => column.panels.map((panel) => panel.slot)),
    ).toEqual(["workspace"]);
    expect(state.attachmentSidebarContent?.kind).toBe("attachment");
    expect(state.sidebarContent).toBe(detailContent);

    state.handleCloseSidebar("workspace");

    expect(state.sidebarLayout.columns.flatMap((column) => column.panels)).toHaveLength(0);
    expect(state.attachmentSidebarContent).toBeNull();
    expect(state.sidebarContent).toBe(detailContent);
  });

  it("keeps the active observer digest when another run streams in the same session", () => {
    const projectedDigest = {
      sessionKey: "agent:main:current",
      runId: "run-1",
      revision: 1,
      updatedAt: 1_000,
      headline: "The active run's status",
      health: "on-track" as const,
    };
    const state = createObserverState({
      sessionKey: projectedDigest.sessionKey,
      chatRunId: "run-1",
      observerDigest: projectedDigest,
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        state: "delta",
        runId: "run-2",
        sessionKey: projectedDigest.sessionKey,
      },
    });

    expect(state.observerDigest).toBe(projectedDigest);
  });

  it("rejects a run-less observer digest during an identified active run", () => {
    const projectedDigest = {
      sessionKey: "agent:main:current",
      runId: "run-1",
      revision: 1,
      updatedAt: 1_000,
      headline: "Projected current status",
      health: "on-track" as const,
    };
    const requestUpdate = vi.fn();
    const state = createObserverState({
      sessionKey: projectedDigest.sessionKey,
      chatRunId: "run-1",
      observerDigest: projectedDigest,
      requestUpdate,
    });

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.observer",
      payload: {
        sessionKey: projectedDigest.sessionKey,
        revision: 2,
        updatedAt: 2_000,
        headline: "Run-less live status",
        health: "stuck",
      },
    });

    expect(state.observerDigest).toBe(projectedDigest);
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("accepts only the row-active observer run when attaching mid-run", () => {
    const projectedDigest = {
      sessionKey: "agent:main:current",
      runId: "r1",
      revision: 1,
      updatedAt: 1_000,
      headline: "Projected current status",
      health: "on-track" as const,
    };
    const requestUpdate = vi.fn();
    const state = createObserverState({
      sessionKey: projectedDigest.sessionKey,
      observerDigest: projectedDigest,
      sessionsResult: {
        sessions: [
          {
            key: projectedDigest.sessionKey,
            hasActiveRun: true,
            activeRunIds: ["r1"],
          },
        ],
      },
      requestUpdate,
    });
    const observerEvent = (runId?: string) =>
      ({
        type: "event" as const,
        event: "session.observer",
        payload: {
          sessionKey: projectedDigest.sessionKey,
          ...(runId ? { runId } : {}),
          revision: 2,
          updatedAt: 2_000,
          headline: `Live status ${runId ?? "without run"}`,
          health: "grinding",
        },
      }) satisfies Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(state, observerEvent());
    handlePageGatewayEvent(state, observerEvent("r2"));
    expect(state.observerDigest).toBe(projectedDigest);
    expect(requestUpdate).not.toHaveBeenCalled();

    handlePageGatewayEvent(state, observerEvent("r1"));
    expect(state.observerDigest?.headline).toBe("Live status r1");
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("accepts global observer digests only from the selected agent", () => {
    const requestUpdate = vi.fn();
    const state = createObserverState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", scope: "global" },
      chatRunId: "run-work",
      requestUpdate,
    });
    const observerEvent = (agentId: string) =>
      ({
        type: "event" as const,
        event: "session.observer",
        payload: {
          sessionKey: "global",
          agentId,
          runId: "run-work",
          revision: 1,
          updatedAt: 1_000,
          headline: `${agentId} status`,
          health: "on-track",
        },
      }) satisfies Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(state, observerEvent("main"));
    expect(state.observerDigest).toBeNull();
    expect(requestUpdate).not.toHaveBeenCalled();

    handlePageGatewayEvent(state, observerEvent("work"));
    expect(state.observerDigest?.headline).toBe("work status");
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("keeps a fresher selected-agent digest when reconnect replays stale global events", () => {
    const requestUpdate = vi.fn();
    const state = createObserverState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", scope: "global" },
      chatRunId: "run-work",
      observerDigest: {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: 4,
        updatedAt: 4_000,
        headline: "Current work status",
        health: "grinding" as const,
      },
      requestUpdate,
    });

    for (const payload of [
      {
        sessionKey: "global",
        agentId: "main",
        runId: "run-work",
        revision: 8,
        updatedAt: 8_000,
        headline: "Other agent status",
        health: "done" as const,
      },
      {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: 3,
        updatedAt: 9_000,
        headline: "Replayed work status",
        health: "on-track" as const,
      },
    ]) {
      handlePageGatewayEvent(state, {
        type: "event",
        event: "session.observer",
        payload,
      });
    }

    expect(state.observerDigest?.headline).toBe("Current work status");
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("reconciles a selected global alias with its scoped canonical row after reconnect", () => {
    const requestUpdate = vi.fn();
    const state = createObserverState({
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
      hello: {
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "global",
          },
        },
      },
      chatRunId: null,
      observerDigest: {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: 1,
        updatedAt: 1_000,
        headline: "Stale status",
        health: "on-track",
      },
      sessionsResultAgentId: "work",
      sessionsResult: {
        sessions: [
          {
            key: "global",
            hasActiveRun: true,
            activeRunIds: ["run-work"],
            observerDigest: {
              agentId: "work",
              runId: "run-work",
              revision: 2,
              updatedAt: 2_000,
              headline: "Projected status",
              health: "grinding",
            },
          },
        ],
      },
      requestUpdate,
    });

    expect(selectedChatSessionRow(state)?.key).toBe("global");
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.observer",
      payload: {
        sessionKey: "global",
        agentId: "work",
        runId: "run-work",
        revision: 3,
        updatedAt: 3_000,
        headline: "Reconnected live status",
        health: "on-track",
      },
    });

    expect(state.observerDigest?.headline).toBe("Reconnected live status");
    expect(requestUpdate).toHaveBeenCalledOnce();

    const projectedRow = state.sessionsResult?.sessions[0];
    if (projectedRow?.observerDigest) {
      projectedRow.observerDigest.agentId = "main";
    }
    const sanitized = selectedChatSessionRow(state);
    expect(sanitized?.key).toBe("global");
    expect(sanitized?.activeRunIds).toEqual(["run-work"]);
    expect(sanitized?.observerDigest).toBeUndefined();

    state.sessionsResultAgentId = "main";
    expect(selectedChatSessionRow(state)).toBeUndefined();
  });

  it.each([
    {
      name: "prefers an exact direct row over a preceding stray global row",
      rows: [{ key: "global" }, { key: "agent:work:main", displayName: "Exact work session" }],
      expectedKey: "agent:work:main",
    },
    {
      name: "ignores a lone global row outside configured-global scope",
      rows: [{ key: "global" }],
      expectedKey: undefined,
    },
  ])("$name", ({ rows, expectedKey }) => {
    const state = createObserverState({
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      sessionsResultAgentId: "work",
      sessionsResult: { sessions: rows },
    });

    expect(selectedChatSessionRow(state)?.key).toBe(expectedKey);
  });

  it("tracks waiting approval only for the selected session until resolution", () => {
    const requestUpdate = vi.fn();
    const state = {
      sessionKey: "agent:main:current",
      assistantAgentId: "main",
      agentsList: { defaultId: "main" },
      chatRunId: "client-run-1",
      chatStream: null,
      chatStreamStartedAt: 1,
      chatStreamSegments: [],
      chatToolMessages: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      toolStreamSyncTimer: null,
      waitingApprovalStatuses: new Map(),
      sessions: { refreshReplacement: vi.fn(async () => undefined) },
      chatStreamRenderFrame: null,
      renderLifecycle: { invalidate: requestUpdate },
      requestUpdate,
    } as unknown as ChatPageHost;
    const lifecycleEvent = (
      phase: "waiting-approval" | "approval-resolved",
      sessionKey: string,
      approvalId = "approval-1",
    ) =>
      ({
        type: "event" as const,
        event: "agent",
        payload: {
          runId: "engine-run-1",
          seq: 1,
          stream: "lifecycle",
          ts: Date.now(),
          sessionKey,
          agentId: "main",
          data: { phase, approvalId, toolCallId: `tool-${approvalId}` },
        },
      }) satisfies Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(state, lifecycleEvent("waiting-approval", "agent:main:other"));
    expect(state.waitingApprovalStatuses.size).toBe(0);

    handlePageGatewayEvent(state, lifecycleEvent("waiting-approval", state.sessionKey));
    expect(state.waitingApprovalStatuses.get("approval-1")).toEqual({
      approvalId: "approval-1",
      toolCallId: "tool-approval-1",
      runId: "engine-run-1",
    });

    handlePageGatewayEvent(state, lifecycleEvent("approval-resolved", "agent:main:other"));
    expect(state.waitingApprovalStatuses.has("approval-1")).toBe(true);

    handlePageGatewayEvent(
      state,
      lifecycleEvent("waiting-approval", state.sessionKey, "approval-2"),
    );
    handlePageGatewayEvent(state, lifecycleEvent("approval-resolved", state.sessionKey));
    expect([...state.waitingApprovalStatuses.keys()]).toEqual(["approval-2"]);

    handlePageGatewayEvent(
      state,
      lifecycleEvent("approval-resolved", state.sessionKey, "approval-2"),
    );
    expect(state.waitingApprovalStatuses.size).toBe(0);
  });

  it("skips no-op assistant invalidation while tool changes render on the next frame", () => {
    const requestAnimationFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 1);
    const requestUpdate = vi.fn();
    const state = createStreamEventState({
      requestUpdate,
      chatStreamSegments: [],
      chatToolMessages: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      toolStreamSyncTimer: null,
      sessions: { refreshReplacement: vi.fn(async () => undefined) } as never,
    });
    const emitAgent = (seq: number, stream: string, data: Record<string, unknown>) =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "agent",
        payload: { runId: "run-1", seq, stream, ts: seq, sessionKey: "main", data },
      });

    emitAgent(1, "assistant", { text: "Hello", delta: "Hello" });
    expect(requestUpdate).not.toHaveBeenCalled();

    emitAgent(2, "tool", { phase: "start", name: "read", toolCallId: "tool-1" });
    emitAgent(3, "tool", { phase: "update", name: "read", toolCallId: "tool-1" });
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("coalesces stream invalidations into one animation frame", () => {
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const requestUpdate = vi.fn();
    const state = createStreamEventState({
      requestUpdate,
    });

    for (const deltaText of ["A", "B", "C"]) {
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { state: "delta", runId: "run-1", sessionKey: "main", deltaText },
      });
    }

    expect(frames.size).toBe(1);
    expect(requestUpdate).not.toHaveBeenCalled();
    const firstFrame = frames.get(1);
    frames.delete(1);
    firstFrame?.(0);
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(state.chatStreamRenderFrame).toBeNull();

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: { state: "delta", runId: "run-1", sessionKey: "main", deltaText: "D" },
    });
    const staleFrame = frames.get(2);
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.operation",
      payload: {},
    });
    expect(frames.size).toBe(1);
    expect(requestUpdate).toHaveBeenCalledOnce();
    staleFrame?.(0);

    expect(cancelFrame).not.toHaveBeenCalledWith(2);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    expect(state.chatStreamRenderFrame).toBeNull();
  });

  it("projects hidden Gateway state without scheduling animation frames", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const requestAnimationFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation(() => 1);
    const requestUpdate = vi.fn();
    const state = createStreamEventState({ requestUpdate });

    for (const deltaText of ["A", "B", "C"]) {
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { state: "delta", runId: "run-1", sessionKey: "main", deltaText },
      });
    }

    expect(state.chatStream).toBe("ABC");
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(requestUpdate).toHaveBeenCalledTimes(3);

    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.observer",
      payload: {
        sessionKey: "main",
        runId: "run-1",
        revision: 1,
        updatedAt: 1_000,
        headline: "Waiting for a tool",
        health: "grinding",
      },
    });
    handlePageGatewayEvent(state, {
      type: "event",
      event: "session.operation",
      payload: {},
    });

    expect(state.observerDigest?.headline).toBe("Waiting for a tool");
    expect(requestUpdate).toHaveBeenCalledTimes(5);
  });

  it("keeps every chat delta while batching their render", () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    const requestUpdate = vi.fn();
    const state = createStreamEventState({
      requestUpdate,
    });

    for (const deltaText of ["A", "B", "C"]) {
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { state: "delta", runId: "run-1", sessionKey: "main", deltaText },
      });
    }

    expect(state.chatStream).toBe("ABC");
    expect(requestUpdate).not.toHaveBeenCalled();
    scheduledFrame?.(0);
    expect(requestUpdate).toHaveBeenCalledOnce();
  });

  it("forces one PR-chips refresh per PR link seen in the live stream", () => {
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
    const refreshSessionPullRequests = vi.fn(() => Promise.resolve());
    const state = createStreamEventState({
      refreshSessionPullRequests,
    });
    const delta = (deltaText: string, runId = "run-1") =>
      handlePageGatewayEvent(state, {
        type: "event",
        event: "chat",
        payload: { state: "delta", runId, sessionKey: "main", deltaText },
      });

    delta("working on it ");
    expect(refreshSessionPullRequests).not.toHaveBeenCalled();

    // Issue links never carry chips.
    delta("see https://github.com/openclaw/openclaw/issues/42 ");
    expect(refreshSessionPullRequests).not.toHaveBeenCalled();

    delta("opened https://github.com/openclaw/openclaw/pull/113840 for review ");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(1);
    expect(refreshSessionPullRequests).toHaveBeenCalledWith({ refresh: true });

    // One refresh reloads all of the branch's PRs; further links in the same
    // run must not spend more GitHub quota.
    delta("also https://github.com/openclaw/openclaw/pull/113900 ");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(1);

    // Streaming may split a URL across chunks; the rolling tail rejoins it.
    delta("continuing https://github.com/openclaw/openclaw/pu", "run-2");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(1);
    delta("ll/113901 done", "run-2");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(2);

    // A later run announcing the same PR (e.g. its merge) refreshes again.
    delta("merged https://github.com/openclaw/openclaw/pull/113840 at last", "run-3");
    expect(refreshSessionPullRequests).toHaveBeenCalledTimes(3);
  });

  it("requests a render before selecting the commit promise", async () => {
    let resolveCommit: (value: boolean) => void = () => {};
    const nextCommit = new Promise<boolean>((resolve) => {
      resolveCommit = resolve;
    });
    let completion = Promise.resolve(true);
    const controllers: ReactiveController[] = [];
    const requestUpdate = vi.fn(() => {
      completion = nextCommit;
    });
    const host = {
      addController: (controller: ReactiveController) => controllers.push(controller),
      removeController: () => undefined,
      requestUpdate,
      get updateComplete() {
        return completion;
      },
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const effect = vi.fn();

    renderLifecycle.afterCommit(effect);
    await Promise.resolve();

    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    resolveCommit(true);
    await nextCommit;
    expect(effect).toHaveBeenCalledOnce();
    expect(controllers).toContain(controller);
  });

  it("cancels pending commit effects on disconnect", async () => {
    let resolveCommit: (value: boolean) => void = () => {};
    const completion = new Promise<boolean>((resolve) => {
      resolveCommit = resolve;
    });
    const host = createControllerHost({
      updateComplete: completion,
    });
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const effect = vi.fn();

    renderLifecycle.afterCommit(effect);
    controller.hostDisconnected();
    resolveCommit(true);
    await completion;

    expect(effect).not.toHaveBeenCalled();
  });

  it("fully tears down realtime Talk when its state owner disconnects", () => {
    const host = createControllerHost();
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const state = createPageState(createPageContext(), renderLifecycle, {
      querySelector: () => null,
    });
    const stop = vi.fn(() => {
      expect(state.realtimeTalkSession).toBeNull();
    });
    state.realtimeTalkSession = { stop } as unknown as ChatPageHost["realtimeTalkSession"];
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "listening";
    state.realtimeTalkDetail = "live";
    state.realtimeTalkInputLevel.set(0.8);
    state.realtimeTalkConversation = [
      { id: "utterance", role: "user", text: "stale", isStreaming: true },
    ];
    state.realtimeTalkVideoStream = {} as MediaStream;
    state.realtimeTalkCameraDevices = [{ deviceId: "camera", label: "Camera" }];
    state.realtimeTalkVideoCapable = true;
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = true;
    controller.attach(state);

    controller.hostDisconnected();

    expect(stop).toHaveBeenCalledOnce();
    expect(state.realtimeTalkActive).toBe(false);
    expect(state.realtimeTalkStatus).toBe("idle");
    expect(state.realtimeTalkDetail).toBeNull();
    expect(state.realtimeTalkInputLevel.value).toBe(0);
    expect(state.realtimeTalkConversation).toEqual([]);
    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(state.realtimeTalkCameraDevices).toEqual([]);
    expect(state.realtimeTalkVideoCapable).toBe(false);
    expect(state.realtimeTalkVideoPending).toBe(false);
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("aborts attachment reads when a chat pane disconnects", () => {
    const host = createControllerHost();
    const controller = new ChatStateController<ChatPageHost>(host);
    const previousSignal = controller.attachmentReads.readSignal;

    controller.attachmentReads.updatePending(previousSignal, 1);
    controller.hostDisconnected();

    expect(previousSignal.aborted).toBe(true);
    expect(controller.attachmentReads.pendingReads).toBe(0);
    expect(controller.attachmentReads.readSignal).not.toBe(previousSignal);
    controller.attachmentReads.updatePending(previousSignal, -1);
    expect(controller.attachmentReads.pendingReads).toBe(0);
  });

  it("rejects lifecycle work from detached and replaced state epochs", async () => {
    const requestUpdate = vi.fn();
    const host = createControllerHost({ requestUpdate });
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const first = controller.createRenderLifecycle();
    const replacement = controller.createRenderLifecycle();
    const staleEffect = vi.fn();
    const staleCancel = vi.fn();

    first.invalidate();
    first.afterCommit(staleEffect, staleCancel);

    expect(requestUpdate).not.toHaveBeenCalled();
    expect(staleEffect).not.toHaveBeenCalled();
    expect(staleCancel).toHaveBeenCalledOnce();

    controller.hostDisconnected();
    replacement.invalidate();
    replacement.afterCommit(staleEffect, staleCancel);

    expect(requestUpdate).not.toHaveBeenCalled();
    expect(staleEffect).not.toHaveBeenCalled();
    expect(staleCancel).toHaveBeenCalledTimes(2);

    controller.hostConnected();
    const current = controller.createRenderLifecycle();
    const currentEffect = vi.fn();
    current.afterCommit(currentEffect);
    await Promise.resolve();

    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(currentEffect).toHaveBeenCalledOnce();
  });

  it("cancels post-commit paint frames on disconnect", async () => {
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    const host = createControllerHost({
      requestUpdate: vi.fn(),
    });
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const painted = vi.fn();

    scheduleControlUiAfterPaint({ renderLifecycle }, painted);
    await Promise.resolve();

    const firstFrame = frames.get(1);
    expect(firstFrame).toBeDefined();
    frames.delete(1);
    firstFrame?.(0);
    const secondFrame = frames.get(2);
    expect(secondFrame).toBeDefined();

    controller.hostDisconnected();
    secondFrame?.(0);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(painted).not.toHaveBeenCalled();
  });

  it("invalidates the render lifecycle when input history recall mutates the draft", () => {
    const requestUpdate = vi.fn();
    const host = createControllerHost({ requestUpdate });
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();

    const navigateHistory = vi.fn().mockReturnValue({
      handled: true,
      preventDefault: true,
      restoreCaret: "up" as const,
      decision: "handled:history-up" as const,
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: true,
      selectionStart: 0,
      selectionEnd: 0,
      valueLength: 10,
    });

    const state = createInputHistoryState(renderLifecycle, navigateHistory);

    controller.attach(state);

    const input = createInputHistoryKey(0, 0, 0);
    const result = state.handleChatInputHistoryKey!(input);

    expect(result.handled).toBe(true);
    expect(navigateHistory).toHaveBeenCalledWith(input);
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("does not invalidate the render lifecycle when input history key is not handled", () => {
    const requestUpdate = vi.fn();
    const host = createControllerHost({ requestUpdate });
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();

    const navigateHistory = vi.fn().mockReturnValue({
      handled: false,
      preventDefault: false,
      restoreCaret: null,
      decision: "blocked:modifier-or-composition" as const,
      historyNavigationActiveBefore: false,
      historyNavigationActiveAfter: false,
      selectionStart: 0,
      selectionEnd: 0,
      valueLength: 10,
    });

    const state = createInputHistoryState(renderLifecycle, navigateHistory);

    controller.attach(state);

    const input = createInputHistoryKey(5, 5, 10);
    const result = state.handleChatInputHistoryKey!(input);

    expect(result.handled).toBe(false);
    expect(navigateHistory).toHaveBeenCalledWith(input);
    expect(requestUpdate).not.toHaveBeenCalled();
  });
});

describe("session pull request refresh", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function createFinalReplyState(refreshSessionPullRequests: ReturnType<typeof vi.fn>) {
    return {
      ...makeChatHost(),
      chatMessagesBySession: new Map(),
      chatStreamRenderFrame: null,
      pendingSessionMessageReloadSessionKey: null,
      refreshSessionPullRequests,
      requestUpdate: vi.fn(),
      sessionKey: "main",
      sessions: { reconcileRunTerminal: vi.fn() },
      settings: {},
    } as unknown as ChatPageHost;
  }

  it.each([
    {
      name: "requests an authoritative refresh after a final assistant PR link",
      text: "Opened `https://github.com/openclaw/openclaw/pull/111532`.",
      refresh: true,
    },
    {
      name: "refreshes for a visible same-session final from another run",
      text: "Opened https://github.com/openclaw/openclaw/pull/111532",
      activeRunId: "active-run",
      runId: "announcement-run",
      refresh: true,
    },
    {
      name: "does not inspect the active stream for another run's final",
      text: "Finished the background task.",
      activeRunId: "active-run",
      runId: "announcement-run",
      stream: "Opened https://github.com/openclaw/openclaw/pull/111532",
      refresh: false,
    },
    {
      name: "does not refresh for an issue link",
      text: "Tracked in https://github.com/openclaw/openclaw/issues/111532.",
      refresh: false,
    },
    {
      name: "does not refresh for another session's PR announcement",
      text: "Opened https://github.com/openclaw/openclaw/pull/111532",
      sessionKey: "agent:main:other",
      refresh: false,
    },
  ])("$name", ({ text, activeRunId, runId, stream, sessionKey, refresh }) => {
    vi.useFakeTimers();
    const refreshSessionPullRequests = vi.fn(async () => undefined);
    const state = createFinalReplyState(refreshSessionPullRequests);
    if (activeRunId) {
      state.chatRunId = activeRunId;
    }
    if (stream) {
      state.chatStream = stream;
    }

    handlePageGatewayEvent(state, {
      type: "event",
      event: "chat",
      payload: {
        state: "final",
        ...(runId ? { runId } : {}),
        sessionKey: sessionKey ?? "main",
        message: { role: "assistant", content: [{ type: "text", text }] },
      },
    });

    if (refresh) {
      expect(refreshSessionPullRequests).toHaveBeenCalledWith({ refresh: true });
    } else {
      expect(refreshSessionPullRequests).not.toHaveBeenCalled();
    }
  });
});

describe("image lightbox lifecycle", () => {
  it("accepts only matching base64 video at the page boundary", () => {
    const context = {
      agents: { state: { agentsList: null }, ensureList: vi.fn(async () => null) },
      agentSelection: { state: { selectedId: "main" } },
      basePath: "",
      config: {
        current: {
          allowExternalEmbedUrls: false,
          assistantIdentity: { name: "Assistant" },
          embedSandboxMode: "scripts",
          localMediaPreviewRoots: [],
        },
      },
      initialUserMessage: createInitialUserMessageHandoff(),
      sessions: {},
    } as unknown as ApplicationContext;
    const state = createPageState(
      context,
      { invalidate: vi.fn(), afterCommit: () => () => {} },
      { querySelector: () => null },
    );

    const source = "data:video/mp4;base64,AAAA";
    const container = document.body.appendChild(document.createElement("div"));
    render(
      renderAssistantAttachments(
        [
          {
            type: "attachment",
            attachment: { kind: "video", label: "Clip", mimeType: "video/mp4", url: source },
          },
        ],
        { onOpenImage: state.handleOpenImage },
      ),
      container,
    );
    const player = container.querySelector("openclaw-chat-video-player") as HTMLElement & {
      onExpand: (src: string) => void;
    };
    player.onExpand(source);
    expect(state.imageLightbox?.src).toBe("data:video/mp4;base64,AAAA");

    state.handleOpenImage({ kind: "video", src: "data:audio/mp3;base64,AAAA", title: "Audio" });
    expect(state.imageLightbox).toBeNull();
    container.remove();
  });

  it("invalidates immediately when beginning a deferred image open", () => {
    const invalidate = vi.fn();
    const context = {
      agents: {
        state: { agentsList: null },
        ensureList: vi.fn(async () => null),
      },
      agentSelection: { state: { selectedId: "main" } },
      basePath: "",
      config: {
        current: {
          allowExternalEmbedUrls: false,
          assistantIdentity: { name: "Assistant" },
          embedSandboxMode: "scripts",
          localMediaPreviewRoots: [],
        },
      },
      initialUserMessage: createInitialUserMessageHandoff(),
      sessions: {},
    } as unknown as ApplicationContext;
    const state = createPageState(
      context,
      {
        invalidate,
        afterCommit: () => () => {},
      },
      { querySelector: () => null },
    );
    const release = vi.fn();
    state.imageLightbox = {
      src: "blob:managed-image",
      title: "Generated image",
      release,
    };

    const requestVersion = state.beginImageOpen();

    expect(requestVersion).toBe(1);
    expect(state.imageLightbox).toBeNull();
    expect(release).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledOnce();
  });
});

describe("resolveChatAvatarUrl", () => {
  it("prefers the authenticated avatar blob over persisted and protected URLs", () => {
    const state = {
      sessionKey: "agent:main:main",
      chatAvatarUrl: "blob:authenticated-avatar",
      assistantAvatar: "/avatar/main",
      assistantAgentId: "main",
    } as unknown as ChatPageHost;

    expect(resolveChatAvatarUrl(state)).toBe("blob:authenticated-avatar");
  });
});

describe("loadPageAssistantIdentity", () => {
  it("memoizes identity by agent while fetching a cross-agent switch", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
      name: params?.agentId === "other" ? "Other Agent" : "Main Agent",
      agentId: params?.agentId ?? "main",
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    const context = {
      agents: { state: { agentsList: null }, ensureList: vi.fn(async () => null) },
      agentSelection: { state: { selectedId: "main" } },
      basePath: "",
      config: {
        current: {
          allowExternalEmbedUrls: false,
          assistantIdentity: { name: "Assistant" },
          chatMessageMaxWidth: null,
          embedSandboxMode: "scripts",
          localMediaPreviewRoots: [],
        },
      },
      gateway: { snapshot: { client, connected: true, hello: null } },
      initialUserMessage: createInitialUserMessageHandoff(),
      sessions: {},
    } as unknown as ApplicationContext;
    const state = createPageState(
      context,
      { invalidate: vi.fn(), afterCommit: () => () => {} },
      { querySelector: () => null },
    );
    state.client = client;
    state.connected = true;
    state.assistantName = "Initial";
    state.sessionKey = "agent:main:first";

    await state.loadAssistantIdentity();
    state.sessionKey = "agent:main:second";
    await state.loadAssistantIdentity();

    expect(request).toHaveBeenCalledWith("agent.identity.get", {
      agentId: "main",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.assistantName).toBe("Main Agent");

    state.sessionKey = "agent:other:main";
    await state.loadAssistantIdentity();
    expect(request).toHaveBeenLastCalledWith("agent.identity.get", { agentId: "other" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.assistantName).toBe("Other Agent");

    now.mockReturnValue(61_001);
    state.sessionKey = "agent:main:third";
    await state.loadAssistantIdentity();
    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenLastCalledWith("agent.identity.get", { agentId: "main" });
  });
});

describe("refreshChatMetadata", () => {
  function createMetadataState(
    request: ReturnType<typeof vi.fn>,
    overrides: Partial<Omit<ChatPageHost, "hello">> & {
      hello?: { features: { methods: string[] } };
    } = {},
  ): ChatPageHost {
    return {
      ...makeChatHost(),
      agentsList: null,
      assistantAgentId: "main",
      client: { request },
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
      ...overrides,
    } as unknown as ChatPageHost;
  }

  it.each([
    {
      label: "warm",
      existingModels: [{ id: "cached-model", name: "Cached Model", provider: "openai" }],
    },
    { label: "cold", existingModels: [] },
  ])(
    "refreshes $label session metadata after full model discovery completes",
    async ({ existingModels }) => {
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      const discovery = createDeferred<{
        models: Array<{ id: string; name: string; provider: string; reasoning: boolean }>;
      }>();
      const request = vi.fn((method: string, params?: unknown) => {
        expect(method).toBe("models.list");
        expect(params).toEqual({ view: "configured", agentId: "work", refresh: true });
        return discovery.promise;
      });
      const state = createMetadataState(request, {
        chatModelCatalog: existingModels,
        sessions: { refresh: refreshSessions } as never,
      });

      const refresh = refreshChatModelCatalogOnDemand(state);
      expect(state.chatModelCatalog).toEqual(existingModels);
      expect(state.chatModelsLoading).toBe(existingModels.length === 0);
      discovery.resolve({
        models: [{ id: "reasoner", name: "Reasoner", provider: "dynamic-router", reasoning: true }],
      });
      await refresh;

      expect(state.chatModelCatalog).toEqual([
        {
          id: "reasoner",
          name: "Reasoner",
          provider: "dynamic-router",
          reasoning: true,
        },
      ]);
      expect(refreshSessions).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "work", force: true }),
      );
      expect(state.chatModelCatalogError).toBeNull();
    },
  );

  it("applies agent-scoped metadata after a same-agent session switch", async () => {
    let resolveMetadata:
      | ((value: {
          commands: never[];
          models: Array<{
            id: string;
            name: string;
            provider: string;
            available: boolean;
          }>;
        }) => void)
      | undefined;
    const metadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string; available: boolean }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("chat.metadata");
      expect(params).toEqual({ agentId: "work" });
      return await metadata;
    });
    const state = createMetadataState(request);

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:work:another";
    resolveMetadata?.({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai", available: true }],
    });
    await refresh;

    expect(state.chatModelCatalog).toEqual([
      { id: "work-model", name: "Work Model", provider: "openai", available: true },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reuses same-agent metadata and fetches a cross-agent catalog", async () => {
    const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
      commands: [],
      models: [
        {
          id: `${params?.agentId}-model`,
          name: `${params?.agentId} Model`,
          provider: "openai",
        },
      ],
    }));
    const state = createMetadataState(request);

    await refreshChatMetadata(state);
    state.sessionKey = "agent:work:second";
    await refreshChatMetadata(state);
    expect(request).toHaveBeenCalledTimes(1);

    state.sessionKey = "agent:other:main";
    await refreshChatMetadata(state);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith("chat.metadata", { agentId: "other" });
  });

  it("ignores metadata after switching to a different agent", async () => {
    let resolveMetadata:
      | ((value: {
          commands: never[];
          models: Array<{ id: string; name: string; provider: string }>;
        }) => void)
      | undefined;
    const metadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn(async () => await metadata);
    const existingCatalog = [
      { id: "work-model", name: "Work Model", provider: "openai", available: true },
    ];
    const state = createMetadataState(request, { chatModelCatalog: existingCatalog });

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    resolveMetadata?.({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await refresh;

    expect(state.chatModelCatalog).toBe(existingCatalog);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps loading owned by the newest agent metadata request", async () => {
    let resolveWork: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    let resolveOther: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const workMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveWork = resolve;
    });
    const otherMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveOther = resolve;
    });
    const request = vi.fn(
      async (_method: string, params?: { agentId?: string }) =>
        await (params?.agentId === "work" ? workMetadata : otherMetadata),
    );
    const state = createMetadataState(request);

    const workRefresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    const otherRefresh = refreshChatMetadata(state);
    resolveWork({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai" }],
    });
    await workRefresh;

    expect(state.chatModelsLoading).toBe(true);
    resolveOther({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await otherRefresh;

    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalog).toEqual([
      { id: "other-model", name: "Other Model", provider: "openai" },
    ]);
  });

  it("does not publish metadata after the pane retires its request owner", async () => {
    let resolveMetadata: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const pending = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn().mockReturnValue(pending);
    const existingCatalog = [{ id: "existing-model", name: "Existing Model", provider: "openai" }];
    const state = createMetadataState(request, { chatModelCatalog: existingCatalog });

    const refresh = refreshChatMetadata(state);
    retireChatMetadataRequests(state);
    resolveMetadata({
      commands: [],
      models: [{ id: "late-model", name: "Late Model", provider: "openai" }],
    });
    await refresh;

    expect(state.chatModelCatalog).toBe(existingCatalog);
  });

  it("keeps the seeded catalog and reports chat metadata failures without model fallback", async () => {
    const seededCatalog = [
      { id: "seeded-model", name: "Seeded Model", provider: "openai", available: true },
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "chat.metadata") {
        throw new Error("metadata unavailable");
      }
      if (method === "models.list") {
        return { models: [{ id: "substitute-model", name: "Substitute Model" }] };
      }
      return { commands: [] };
    });
    const state = createMetadataState(request, { chatModelCatalog: seededCatalog });

    await refreshChatMetadata(state);

    expect(state.chatModelCatalog).toBe(seededCatalog);
    expect(state.chatModelCatalogError).toBe("metadata unavailable");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.metadata"]);
  });

  it("keeps fallback slash commands when chat metadata omits commands", async () => {
    replaceSlashCommands(buildFallbackSlashCommands());
    const request = vi.fn(async (method: string) => {
      if (method === "chat.metadata") {
        return {
          models: [{ id: "metadata-model", name: "Metadata Model", provider: "openai" }],
        };
      }
      return {
        commands: [
          {
            name: "remote-command",
            textAliases: ["/remote-command"],
            description: "Loaded through commands.list.",
            source: "plugin",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      };
    });
    const state = createMetadataState(request);

    await refreshChatMetadata(state);

    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.metadata"]);
    expect(SLASH_COMMANDS.some((command) => command.name === "help")).toBe(true);
    expect(SLASH_COMMANDS.some((command) => command.name === "remote-command")).toBe(false);
  });
});

describe("refreshChatModelAuthStatus", () => {
  it("scopes auth status to the selected session agent", async () => {
    const request = vi.fn(async () => ({ ts: 1, providers: [] }));
    const state = {
      client: { request },
      connected: true,
      connectionEpoch: 1,
      sessionKey: "agent:work:dashboard:current",
      assistantAgentId: "main",
      modelAuthStatusResult: null,
      modelAuthStatusError: null,
    } as unknown as ChatPageHost;

    await refreshChatModelAuthStatus(state);

    expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "work" });
  });

  it.each(["success", "failure"] as const)(
    "ignores a stale auth status %s after reconnecting the same client",
    async (outcome) => {
      let resolveStatus!: (value: { ts: number; providers: never[] }) => void;
      let rejectStatus!: (error: unknown) => void;
      const response = new Promise<{ ts: number; providers: never[] }>((resolve, reject) => {
        resolveStatus = resolve;
        rejectStatus = reject;
      });
      const request = vi.fn(() => response);
      const currentStatus = { ts: 2, providers: [] };
      const state = {
        client: { request },
        connected: true,
        connectionEpoch: 1,
        modelAuthStatusResult: currentStatus,
        modelAuthStatusError: null,
      } as unknown as ChatPageHost;

      const refresh = refreshChatModelAuthStatus(state);
      state.connected = false;
      state.connectionEpoch += 1;
      state.connected = true;
      state.connectionEpoch += 1;

      if (outcome === "success") {
        resolveStatus({ ts: 1, providers: [] });
      } else {
        rejectStatus(new Error("stale connection auth status"));
      }
      await refresh;

      expect(state.modelAuthStatusResult).toBe(currentStatus);
      expect(state.modelAuthStatusError).toBeNull();
      expect(request).toHaveBeenCalledOnce();
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
