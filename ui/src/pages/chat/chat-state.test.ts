import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as assistantIdentity from "../../app/assistant-identity.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import {
  buildFallbackSlashCommands,
  replaceSlashCommands,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { applyRemoteSlashCommandsResult } from "./chat-commands.ts";
import {
  admitQueuedMessageForSession,
  removeQueuedMessage,
  subscribeChatOutboxProjection,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import { createInitialChatRealtimeState } from "./chat-realtime.ts";
import { ChatStateController } from "./chat-state-controller.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { invalidateChatMetadataCache, refreshChatMetadata } from "./chat-state-refresh.ts";
import {
  resetChatStateForRouteSession,
  retryChatComposerMemoryFallback,
  resolveChatAvatarUrl,
  selectedChatSessionRow,
} from "./chat-state-route.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  loadChatComposerCommittedDraftRevision,
  loadChatComposerDraftRevision,
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
import { scheduleControlUiAfterPaint } from "./performance.ts";
import { openSlot } from "./sidebar-layout.ts";

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
    const state = {
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      connectionEpoch: 1,
      sessionKey: "agent:main:main",
      currentSessionId: "selected-session",
      chatLoading: false,
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatThinkingLevel: null,
      chatVerboseLevel: null,
      chatSending: false,
      chatMessage: "",
      chatAttachments: [],
      chatQueue: [],
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
      lastError: null,
      hello: null,
      sessions: {
        reconcileChanged: vi.fn().mockReturnValue({ applied: false }),
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      requestUpdate: vi.fn(),
      ...overrides,
    } as unknown as ChatPageHost;
    return { request, state };
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

  it("renders distinct live peers immediately and coalesces their stale history", async () => {
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
      expect(state.requestUpdate).toHaveBeenCalledTimes(index + 1);
    }

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
    const pendingUser = {
      role: "user",
      content: [{ type: "text", text: "Pending before reset" }],
      __openclaw: { idempotencyKey: "pre-reset-pending:user" },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [pendingUser],
    });
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

    deliverUser("post-reset-live", "Live after reset");
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toMatchObject({
      __openclaw: { id: "post-reset-live", seq: 1 },
    });
  });

  it("does not clear the selected transcript when another agent resets", () => {
    const selectedUser = {
      role: "user",
      content: [{ type: "text", text: "Keep this agent's conversation" }],
      __openclaw: { id: "selected-user", seq: 1 },
    };
    const { state } = createSessionEventState({
      connected: false,
      chatMessages: [selectedUser],
    });

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
});

describe("ChatStateController render lifecycle", () => {
  it("keeps the active observer digest when another run streams in the same session", () => {
    const projectedDigest = {
      sessionKey: "agent:main:current",
      runId: "run-1",
      revision: 1,
      updatedAt: 1_000,
      headline: "The active run's status",
      health: "on-track" as const,
    };
    const state = {
      sessionKey: projectedDigest.sessionKey,
      assistantAgentId: "main",
      agentsList: { defaultId: "main" },
      chatRunId: "run-1",
      observerDigest: projectedDigest,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;

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
    const state = {
      sessionKey: projectedDigest.sessionKey,
      assistantAgentId: "main",
      agentsList: { defaultId: "main" },
      chatRunId: "run-1",
      observerDigest: projectedDigest,
      requestUpdate,
    } as unknown as ChatPageHost;

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
    const state = {
      sessionKey: projectedDigest.sessionKey,
      assistantAgentId: "main",
      agentsList: { defaultId: "main" },
      chatRunId: null,
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
    } as unknown as ChatPageHost;
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
    const state = {
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", scope: "global" },
      chatRunId: "run-work",
      observerDigest: null,
      requestUpdate,
    } as unknown as ChatPageHost;
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
    const state = {
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
    } as unknown as ChatPageHost;

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
    const state = {
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
    } as unknown as ChatPageHost;

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
    const state = {
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      sessionsResultAgentId: "work",
      sessionsResult: { sessions: rows },
    } as unknown as ChatPageHost;

    expect(selectedChatSessionRow(state)?.key).toBe(expectedKey);
  });

  it("tracks waiting approval only for the selected session until resolution", () => {
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
      sessions: { setModelOverride: vi.fn() },
      chatStreamRenderFrame: null,
      requestUpdate: vi.fn(),
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
    const state = {
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatRunId: "run-1",
      chatStream: null,
      chatStreamRenderFrame: null,
      chatStreamStartedAt: 1,
      lastError: null,
      pendingSessionMessageReloadSessionKey: null,
      requestUpdate,
      sessionKey: "main",
    } as unknown as ChatPageHost;

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
    staleFrame?.(0);

    expect(cancelFrame).toHaveBeenCalledWith(2);
    expect(requestUpdate).toHaveBeenCalledTimes(2);
    expect(state.chatStreamRenderFrame).toBeNull();
  });

  it("keeps every chat delta while batching their render", () => {
    let scheduledFrame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    const requestUpdate = vi.fn();
    const state = {
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatRunId: "run-1",
      chatStream: null,
      chatStreamRenderFrame: null,
      chatStreamStartedAt: 1,
      lastError: null,
      pendingSessionMessageReloadSessionKey: null,
      requestUpdate,
      sessionKey: "main",
    } as unknown as ChatPageHost;

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
    const state = {
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatRunId: "run-1",
      chatStream: null,
      chatStreamRenderFrame: null,
      chatStreamStartedAt: 1,
      lastError: null,
      pendingSessionMessageReloadSessionKey: null,
      refreshSessionPullRequests,
      requestUpdate: vi.fn(),
      sessionKey: "main",
    } as unknown as ChatPageHost;
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
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: completion,
    } satisfies ReactiveControllerHost;
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
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const context = {
      agents: {
        state: { agentsList: null },
        adoptList: vi.fn(),
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
    const state = createPageState(context, renderLifecycle, { querySelector: () => null });
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

  it("aborts attachment reads when a pane adopts a different session", () => {
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    const previousSignal = controller.attachmentReads.readSignal;

    controller.attachmentReads.updatePending(previousSignal, 1);
    expect(controller.attachmentReads.pendingReads).toBe(1);

    controller.adoptComposerRoute();

    expect(previousSignal.aborted).toBe(true);
    expect(controller.attachmentReads.pendingReads).toBe(0);
    expect(controller.attachmentReads.readSignal).not.toBe(previousSignal);
    controller.attachmentReads.updatePending(previousSignal, 1);
    expect(controller.attachmentReads.pendingReads).toBe(0);
  });

  it("aborts attachment reads when a chat pane disconnects", () => {
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
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
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
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
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
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
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
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

    const state = {
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

    controller.attach(state);

    const input = {
      key: "ArrowUp" as const,
      selectionStart: 0,
      selectionEnd: 0,
      valueLength: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    };
    const result = state.handleChatInputHistoryKey!(input);

    expect(result.handled).toBe(true);
    expect(navigateHistory).toHaveBeenCalledWith(input);
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("does not invalidate the render lifecycle when input history key is not handled", () => {
    const requestUpdate = vi.fn();
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
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

    const state = {
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

    controller.attach(state);

    const input = {
      key: "ArrowUp" as const,
      selectionStart: 5,
      selectionEnd: 5,
      valueLength: 10,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
    };
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
      chatComposerFallbackByScope: {},
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatQueue: [],
      chatQueueByScope: {},
      chatRunId: null,
      chatStream: null,
      chatStreamRenderFrame: null,
      chatStreamSegments: [],
      chatToolMessages: [],
      lastError: null,
      pendingSessionMessageReloadSessionKey: null,
      refreshSessionPullRequests,
      requestUpdate: vi.fn(),
      sessionKey: "main",
      sessions: { reconcileRunTerminal: vi.fn() },
      settings: {},
      toolStreamById: new Map(),
      toolStreamOrder: [],
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
  it("invalidates immediately when beginning a deferred image open", () => {
    const invalidate = vi.fn();
    const context = {
      agents: {
        state: { agentsList: null },
        adoptList: vi.fn(),
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

describe("route composer fallback", () => {
  function createRouteState(chatMessage: string) {
    const resetChatInputHistoryNavigation = vi.fn();
    const resetChatScroll = vi.fn();
    const state = {
      settings: { gatewayUrl: "ws://gateway.test/control" },
      assistantAgentId: "main",
      agentsList: { defaultId: "main", mainKey: "main" },
      hello: null,
      initialUserMessage: createInitialUserMessageHandoff(),
      sessionKey: "agent:main:first",
      chatMessage,
      chatComposerFallbackByScope: {},
      chatQueue: [],
      chatQueueByScope: {},
      chatMessages: [],
      chatMessagesBySession: new Map(),
      imageLightbox: null,
      imageLightboxRequestVersion: 0,
      chatAttachments: [
        {
          id: "staged-image",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AAA",
        },
      ],
      chatToolMessages: [],
      chatStreamSegments: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      sessionsResult: null,
      ...createInitialChatRealtimeState(),
      resetChatInputHistoryNavigation,
      resetChatScroll,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    return { resetChatInputHistoryNavigation, resetChatScroll, state };
  }

  it("releases the active image lightbox on a route switch", () => {
    const { state } = createRouteState("");
    const release = vi.fn();
    state.imageLightbox = {
      src: "blob:managed-image",
      title: "Generated image",
      release,
    };

    resetChatStateForRouteSession(state, "agent:main:second");

    expect(release).toHaveBeenCalledTimes(1);
    expect(state.imageLightbox).toBeNull();
  });

  it("retires realtime Talk before adopting the next route", () => {
    const { state } = createRouteState("");
    const previousSessionKey = state.sessionKey;
    const stop = vi.fn(() => {
      expect(state.realtimeTalkSession).toBeNull();
      expect(state.sessionKey).toBe(previousSessionKey);
    });
    state.realtimeTalkSession = { stop } as unknown as ChatPageHost["realtimeTalkSession"];
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "listening";
    state.realtimeTalkDetail = "live";
    state.realtimeTalkInputLevel.set(0.6);
    state.realtimeTalkConversation = [
      { id: "utterance", role: "assistant", text: "stale", isStreaming: true },
    ];
    state.realtimeTalkVideoStream = {} as MediaStream;
    state.realtimeTalkCameraDevices = [{ deviceId: "camera", label: "Camera" }];
    state.realtimeTalkVideoCapable = true;
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = true;

    resetChatStateForRouteSession(state, "agent:main:second");

    expect(stop).toHaveBeenCalledOnce();
    expect(state.sessionKey).toBe("agent:main:second");
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

  it("clears transient detail content on a route switch", () => {
    const { state } = createRouteState("");
    state.sidebarContent = { kind: "markdown", content: "First session detail" };
    state.sidebarLayout = openSlot({ columns: [] }, "detail");

    resetChatStateForRouteSession(state, "agent:main:second");

    expect(state.sidebarContent).toBeNull();
  });

  it("restores one atomic history snapshot when returning to a session", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    state.chatMessages = [{ role: "assistant", content: "first session" }];
    state.chatHistoryPagination = { hasMore: true, nextOffset: 400, totalMessages: 718 };
    state.currentSessionId = "session-first";
    state.chatDisplayedLeafEntryId = "leaf-first";

    resetChatStateForRouteSession(state, "agent:main:second");
    state.chatMessages = [{ role: "assistant", content: "second session" }];
    state.chatHistoryPagination = { hasMore: false, totalMessages: 1 };
    state.currentSessionId = "session-second";
    state.chatDisplayedLeafEntryId = "leaf-second";

    resetChatStateForRouteSession(state, "agent:main:first");

    expect(state.chatMessages).toEqual([{ role: "assistant", content: "first session" }]);
    expect(state.chatHistoryPagination).toEqual({
      hasMore: true,
      nextOffset: 400,
      totalMessages: 718,
    });
    expect(state.currentSessionId).toBe("session-first");
    expect(state.chatDisplayedLeafEntryId).toBe("leaf-first");
  });

  it("reapplies a live send projection when a subscribed pane switches into its scope", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: owner } = createRouteState("");
    const { state: switchingPane } = createRouteState("");
    switchingPane.sessionKey = "agent:main:second";
    const item = {
      id: "route-switch-live-send",
      text: "send remains owned by the first pane",
      createdAt: 1,
      sessionKey: owner.sessionKey,
    };
    owner.chatQueue = [item];
    const stopSwitchingPane = subscribeChatOutboxProjection(switchingPane);

    try {
      expect(admitQueuedMessageForSession(owner, owner.sessionKey, item)).toBe(true);
      expect(
        updateQueuedMessageForSession(owner, owner.sessionKey, item.id, (entry) => ({
          ...entry,
          sendAttempts: 1,
          sendRunId: "route-switch-live-run",
          sendState: "sending",
        })),
      ).toMatchObject({ sendState: "sending" });
      expect(loadChatComposerSnapshot(owner, owner.sessionKey)?.queue[0]?.sendState).toBe(
        "waiting-reconnect",
      );
      expect(switchingPane.chatQueue).toStrictEqual([]);

      resetChatStateForRouteSession(switchingPane, owner.sessionKey);

      expect(switchingPane.chatQueue).toEqual([
        expect.objectContaining({ id: item.id, sendState: "sending" }),
      ]);
    } finally {
      removeQueuedMessage(owner, item.id);
      stopSwitchingPane();
    }
  });

  it("hydrates a live target without persisting through the previous route owner", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: owner } = createRouteState("stored target draft");
    owner.chatAttachments = [];
    const item = {
      id: "route-switch-persistence-owner",
      text: "keep target projection live",
      createdAt: 1,
      sessionKey: owner.sessionKey,
    };
    expect(persistChatComposerState(owner)).toBe(true);
    owner.chatQueue = [item];
    expect(admitQueuedMessageForSession(owner, owner.sessionKey, item)).toBe(true);
    expect(
      updateQueuedMessageForSession(owner, owner.sessionKey, item.id, (entry) => ({
        ...entry,
        sendAttempts: 1,
        sendRunId: "route-switch-persistence-run",
        sendState: "sending",
      })),
    ).toMatchObject({ sendState: "sending" });

    const { state: peer } = createRouteState("stored target draft");
    peer.chatAttachments = [];
    const peerPersistence = new ChatComposerPersistence(() => peer);
    peerPersistence.start();
    peer.chatMessage = "newer pending peer draft";
    peerPersistence.schedule();

    const { state: switchingPane } = createRouteState("");
    switchingPane.chatAttachments = [];
    switchingPane.sessionKey = "agent:main:second";
    const previousRoutePersistence = new ChatComposerPersistence(() => switchingPane);
    previousRoutePersistence.start();
    const requestUpdate = vi.fn(() => previousRoutePersistence.persistChangedState());
    switchingPane.requestUpdate = requestUpdate;
    const stopSwitchingPane = subscribeChatOutboxProjection(switchingPane);

    try {
      resetChatStateForRouteSession(switchingPane, owner.sessionKey);

      expect(requestUpdate).not.toHaveBeenCalled();
      expect(switchingPane.chatQueue[0]?.sendState).toBe("sending");
      peerPersistence.persistChangedState();
      expect(loadChatComposerSnapshot(owner, owner.sessionKey)?.draft).toBe(
        "newer pending peer draft",
      );
    } finally {
      removeQueuedMessage(owner, item.id);
      stopSwitchingPane();
    }
  });

  it("reapplies a running command projection when a subscribed pane switches into its scope", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: owner } = createRouteState("");
    const { state: switchingPane } = createRouteState("");
    switchingPane.sessionKey = "agent:main:second";
    const item = {
      id: "route-switch-live-command",
      text: "/compact",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "compact",
      sessionKey: owner.sessionKey,
    };
    owner.chatQueue = [item];
    const stopSwitchingPane = subscribeChatOutboxProjection(switchingPane);

    try {
      expect(admitQueuedMessageForSession(owner, owner.sessionKey, item)).toBe(true);
      expect(
        updateQueuedMessageForSession(owner, owner.sessionKey, item.id, (entry) => ({
          ...entry,
          sendState: "executing-command",
        })),
      ).toMatchObject({ sendState: "executing-command" });
      expect(loadChatComposerSnapshot(owner, owner.sessionKey)?.queue[0]?.sendState).toBe(
        "unconfirmed",
      );
      expect(switchingPane.chatQueue).toStrictEqual([]);

      resetChatStateForRouteSession(switchingPane, owner.sessionKey);

      expect(switchingPane.chatQueue).toEqual([
        expect.objectContaining({ id: item.id, sendState: "executing-command" }),
      ]);
    } finally {
      removeQueuedMessage(owner, item.id);
      stopSwitchingPane();
    }
  });

  it("keeps a draft in its pane when browser persistence fails across a route switch", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { resetChatInputHistoryNavigation, resetChatScroll, state } =
      createRouteState("memory-only draft");

    expect(
      resetChatStateForRouteSession(state, "agent:main:second", {
        retainPreviousComposerInMemory: true,
        previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
      }),
    ).toEqual({ restoredFallback: false, restoredStorageFailure: false });
    expect(state.chatMessage).toBe("");
    expect(state.chatAttachments).toEqual([]);

    expect(resetChatStateForRouteSession(state, "agent:main:first")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });
    expect(state.chatMessage).toBe("memory-only draft");
    expect(state.chatAttachments).toEqual([
      {
        id: "staged-image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AAA",
      },
    ]);
    expect(state.chatError).toContain("remains available in this tab");
    expect(resetChatInputHistoryNavigation).toHaveBeenCalledTimes(2);
    expect(resetChatScroll).toHaveBeenCalledTimes(2);
  });

  it("adopts an unresolved bare-main fallback when the default agent becomes known", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("unresolved memory draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "main";

    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    const unresolvedScopeKey = storedChatOutboxScopeKey({ sessionKey: "main" });
    expect(state.chatComposerFallbackByScope[unresolvedScopeKey]?.message).toBe(
      "unresolved memory draft",
    );

    state.assistantAgentId = "work";
    state.agentsList = { agents: [], defaultId: "work", mainKey: "main", scope: "global" };
    expect(resetChatStateForRouteSession(state, "main")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });

    const resolvedScopeKey = storedChatOutboxScopeKey(resolveStoredChatOutboxScope(state, "main"));
    expect(state.chatMessage).toBe("unresolved memory draft");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatComposerFallbackByScope[resolvedScopeKey]?.message).toBe(
      "unresolved memory draft",
    );
    expect(state.chatComposerFallbackByScope[unresolvedScopeKey]).toBeUndefined();
  });

  it("keeps unresolved bare-main and raw-global fallbacks with their resolved owners", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    const unresolvedMainScopeKey = storedChatOutboxScopeKey({ sessionKey: "main" });
    const unresolvedGlobalScopeKey = storedChatOutboxScopeKey({ sessionKey: "global" });
    state.chatComposerFallbackByScope = {
      [unresolvedMainScopeKey]: {
        message: "default-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 1,
      },
      [unresolvedGlobalScopeKey]: {
        message: "selected-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 2,
      },
    };
    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "main",
      scope: "global",
    };

    resetChatStateForRouteSession(state, "main");
    expect(state.chatMessage).toBe("default-agent fallback");
    expect(state.chatComposerFallbackByScope[unresolvedGlobalScopeKey]?.message).toBe(
      "selected-agent fallback",
    );

    resetChatStateForRouteSession(state, "agent:work:other");
    resetChatStateForRouteSession(state, "global");
    expect(state.chatMessage).toBe("selected-agent fallback");
  });

  it("adopts a failed custom-main fallback when defaults identify the alias", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("custom alias memory draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "workspace";

    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    const customAliasScopeKey = storedChatOutboxScopeKey({ sessionKey: "workspace" });
    expect(state.chatComposerFallbackByScope[customAliasScopeKey]?.message).toBe(
      "custom alias memory draft",
    );

    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };
    expect(resetChatStateForRouteSession(state, "agent:work:workspace")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });

    const resolvedScopeKey = storedChatOutboxScopeKey({ agentId: "work", sessionKey: "global" });
    expect(state.chatMessage).toBe("custom alias memory draft");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatComposerFallbackByScope[customAliasScopeKey]).toBeUndefined();
    expect(state.chatComposerFallbackByScope[resolvedScopeKey]?.message).toBe(
      "custom alias memory draft",
    );
    expect(retryChatComposerMemoryFallback(state, "agent:work:workspace")).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:work:workspace")?.draft).toBe(
      "custom alias memory draft",
    );
  });

  it("adopts a qualified custom-main fallback when defaults identify the alias", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("qualified alias memory draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "agent:work:workspace";

    resetChatStateForRouteSession(state, "agent:alpha:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    const qualifiedScopeKey = storedChatOutboxScopeKey({
      agentId: "work",
      sessionKey: "agent:work:workspace",
    });
    expect(state.chatComposerFallbackByScope[qualifiedScopeKey]?.message).toBe(
      "qualified alias memory draft",
    );

    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };
    expect(resetChatStateForRouteSession(state, "agent:work:workspace")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });

    const resolvedScopeKey = storedChatOutboxScopeKey({ agentId: "work", sessionKey: "global" });
    expect(state.chatMessage).toBe("qualified alias memory draft");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatComposerFallbackByScope[qualifiedScopeKey]).toBeUndefined();
    expect(state.chatComposerFallbackByScope[resolvedScopeKey]?.message).toBe(
      "qualified alias memory draft",
    );
    expect(retryChatComposerMemoryFallback(state, "agent:work:workspace")).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:work:workspace")?.draft).toBe(
      "qualified alias memory draft",
    );
  });

  it("keeps custom and unresolved fallbacks with their distinct agents", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    const customAliasScopeKey = storedChatOutboxScopeKey({ sessionKey: "workspace" });
    const unresolvedScopeKey = storedChatOutboxScopeKey({ sessionKey: "global" });
    state.chatComposerFallbackByScope = {
      [customAliasScopeKey]: {
        message: "default-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 1,
      },
      [unresolvedScopeKey]: {
        message: "selected-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 2,
      },
    };
    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };

    resetChatStateForRouteSession(state, "agent:work:workspace");
    expect(state.chatMessage).toBe("default-agent fallback");
    expect(state.chatComposerFallbackByScope[unresolvedScopeKey]?.message).toBe(
      "selected-agent fallback",
    );

    resetChatStateForRouteSession(state, "agent:work:other");
    resetChatStateForRouteSession(state, "global");
    expect(state.chatMessage).toBe("selected-agent fallback");
  });

  it("keeps only the newest failed fallback when aliases converge", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("older unresolved draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.chatAttachments = [];
    state.sessionKey = "main";
    resetChatStateForRouteSession(state, "workspace", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    state.chatMessage = "newer custom-alias draft";
    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 2 },
    });
    state.assistantAgentId = "work";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };

    expect(resetChatStateForRouteSession(state, "global")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });
    expect(state.chatMessage).toBe("newer custom-alias draft");
    expect(retryChatComposerMemoryFallback(state, "global")).toBe(true);
    expect(state.chatComposerFallbackByScope).toEqual({});

    resetChatStateForRouteSession(state, "agent:work:other");
    resetChatStateForRouteSession(state, "global");
    expect(state.chatMessage).toBe("newer custom-alias draft");
  });

  it("keeps only the newest attachment fallback when aliases converge", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "main";
    resetChatStateForRouteSession(state, "workspace", {
      retainPreviousComposerInMemory: true,
    });

    state.chatAttachments = [
      {
        id: "newer-custom-attachment",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,BBB",
      },
    ];
    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
    });
    state.assistantAgentId = "work";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };

    expect(resetChatStateForRouteSession(state, "global")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: false,
    });
    expect(state.chatAttachments).toEqual([
      {
        id: "newer-custom-attachment",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,BBB",
      },
    ]);
    const resolvedScopeKey = storedChatOutboxScopeKey({ agentId: "work", sessionKey: "global" });
    expect(Object.keys(state.chatComposerFallbackByScope)).toEqual([resolvedScopeKey]);
  });

  it("rebases a newer unresolved draft retry onto the selected agent revision", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: resolved } = createRouteState("prior work draft");
    resolved.assistantAgentId = "work";
    resolved.agentsList = { agents: [], defaultId: "work", mainKey: "main", scope: "global" };
    resolved.sessionKey = "main";
    resolved.chatAttachments = [];
    expect(persistChatComposerState(resolved)).toBe(true);
    const committedRevision = loadChatComposerCommittedDraftRevision(resolved, "main");

    const { state } = createRouteState("new unresolved draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "main";
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: {
        expectedDraftRevision: 0,
        draftRevision: committedRevision + 1,
      },
    });

    state.assistantAgentId = "work";
    state.agentsList = { agents: [], defaultId: "work", mainKey: "main", scope: "global" };
    resetChatStateForRouteSession(state, "main");

    expect(retryChatComposerMemoryFallback(state, "main")).toBe(true);
    expect(loadChatComposerSnapshot(state, "main")?.draft).toBe("new unresolved draft");
    expect(state.chatComposerFallbackByScope).toEqual({});
  });

  it("keeps staged attachments in the pane without reporting a storage failure", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");

    expect(
      resetChatStateForRouteSession(state, "agent:main:second", {
        retainPreviousComposerInMemory: true,
      }),
    ).toEqual({ restoredFallback: false, restoredStorageFailure: false });
    expect(state.chatError).toBeNull();

    expect(resetChatStateForRouteSession(state, "agent:main:first")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: false,
    });
    expect(state.chatMessage).toBe("");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatError).toBeNull();
  });

  it("retries a failed draft after storage recovers", () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let storageAvailable = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (!storageAvailable) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const { state } = createRouteState("retry this draft");
    state.chatAttachments = [];
    expect(
      persistChatComposerState(state, "agent:main:first", {
        draft: state.chatMessage,
        expectedDraftRevision: 0,
        draftRevision: 1,
      }),
    ).toBe(false);

    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    resetChatStateForRouteSession(state, "agent:main:first");
    storageAvailable = true;

    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:main:first")?.draft).toBe("retry this draft");
    expect(state.chatComposerFallbackByScope).toEqual({});
    expect(state.chatError).toBeNull();
  });

  it("does not overwrite a newer split-pane draft while retrying", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")?.draft).toBe("newer pane B draft");
    expect(state.chatMessage).toBe("pane A draft");
    expect(state.chatError).toContain("remains available in this tab");
  });

  it("keeps a stale-revision conflict pane-local instead of retrying it as storage failure", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("older pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")?.draft).toBe("newer pane B draft");
    expect(state.chatMessage).toBe("older pane A draft");
    expect(state.chatError).toBeNull();
  });

  it("does not resurrect a stale fallback after a newer pane clears the draft", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("stale pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    peer.chatMessage = "";
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    expect(loadChatComposerSnapshot(peer, "agent:main:first")).toBeNull();

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")).toBeNull();
    expect(state.chatMessage).toBe("stale pane A draft");
  });

  it("does not resurrect a stale fallback after its clear tombstone is pruned", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    const { state } = createRouteState("stale pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    peer.chatMessage = "";
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    const clearRevision = loadChatComposerDraftRevision(peer, "agent:main:first");

    const queued = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `agent:main:queued-${index}`;
      const item = {
        id: `queued-${index}`,
        text: `queued message ${index}`,
        createdAt: index,
        sendAttempts: 0,
        sendRunId: `queued-run-${index}`,
        sendState: "waiting-reconnect" as const,
        sessionKey,
        agentId: "main",
      };
      const { state: queueState } = createRouteState("");
      queueState.chatAttachments = [];
      queueState.sessionKey = sessionKey;
      expect(admitStoredChatComposerQueueItem(queueState, sessionKey, item)).toBe(true);
      return { item, queueState, sessionKey };
    });

    expect(loadChatComposerSnapshot(peer, "agent:main:first")).toBeNull();
    expect(loadChatComposerDraftRevision(peer, "agent:main:first")).toBe(clearRevision);

    for (let index = 0; index < 20; index += 1) {
      const { state: clearState } = createRouteState("");
      clearState.chatAttachments = [];
      clearState.sessionKey = `agent:main:clear-fence-${index}`;
      expect(persistChatComposerState(clearState)).toBe(true);
    }
    const storageKey = sessionStorage.key(0);
    expect(storageKey).not.toBeNull();
    expect(sessionStorage.getItem(storageKey!)).not.toContain("agent:main:first");

    for (const { item, queueState, sessionKey } of queued) {
      expect(removeStoredChatComposerQueueItem(queueState, sessionKey, item.id, item)).toBe(true);
    }

    expect(loadChatComposerSnapshot(peer, "agent:main:first")).toBeNull();
    expect(loadChatComposerDraftRevision(peer, "agent:main:first")).toBe(clearRevision);
    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")).toBeNull();
    expect(state.chatMessage).toBe("stale pane A draft");
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
      agents: { state: { agentsList: null }, adoptList: vi.fn() },
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
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
      ...overrides,
    } as unknown as ChatPageHost;
  }

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

  it("does not let an older same-agent response overwrite the newest catalog", async () => {
    let resolveFirst: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    let resolveSecond: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const firstMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveSecond = resolve;
    });
    let requestCount = 0;
    const request = vi.fn(async () => {
      requestCount += 1;
      return await (requestCount === 1 ? firstMetadata : secondMetadata);
    });
    const state = createMetadataState(request);

    const firstRefresh = refreshChatMetadata(state);
    invalidateChatMetadataCache(state);
    const secondRefresh = refreshChatMetadata(state);
    resolveSecond({
      commands: [],
      models: [{ id: "new-model", name: "New Model", provider: "openai" }],
    });
    await secondRefresh;
    resolveFirst({
      commands: [],
      models: [{ id: "old-model", name: "Old Model", provider: "openai" }],
    });
    await firstRefresh;

    expect(state.chatModelCatalog).toEqual([
      { id: "new-model", name: "New Model", provider: "openai" },
    ]);
  });

  it("loads compatibility models when the gateway does not advertise chat metadata", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "models.list") {
        expect(params).toEqual({ view: "configured" });
        return {
          models: [{ id: "compat-model", name: "Compat Model", provider: "openai" }],
        };
      }
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const state = createMetadataState(request, {
      chatMetadataRequestVersion: 2,
      chatModelCatalog: [{ id: "stale-model", name: "Stale Model", provider: "openai" }],
      chatModelsLoading: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:main:main",
    });

    await refreshChatMetadata(state);

    expect(state.chatMetadataRequestVersion).toBe(3);
    expect(state.chatModelCatalog).toEqual([
      { id: "compat-model", name: "Compat Model", provider: "openai" },
    ]);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves startup models when the gateway does not advertise chat metadata", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const startupCatalog = [
      { id: "startup-model", name: "Startup Model", provider: "openai", available: true },
    ];
    const state = createMetadataState(request, {
      chatMetadataRequestVersion: 4,
      chatModelCatalog: startupCatalog,
      chatModelsLoading: true,
      hello: { features: { methods: ["chat.startup"] } },
    });

    await refreshChatMetadata(state, { preserveModelCatalogOnFallback: true });

    expect(state.chatMetadataRequestVersion).toBe(5);
    expect(state.chatModelCatalog).toBe(startupCatalog);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not load unscoped compatibility models for a non-default agent", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const state = createMetadataState(request, {
      agentsList: { defaultId: "main" } as ChatPageHost["agentsList"],
      chatModelCatalog: [{ id: "stale-model", name: "Stale Model", provider: "openai" }],
      hello: { features: { methods: [] } },
    });

    await refreshChatMetadata(state);

    expect(state.chatModelCatalog).toEqual([]);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not apply compatibility commands after switching agents", async () => {
    let resolveCommands: (value: {
      commands: Array<{
        name: string;
        textAliases: string[];
        description: string;
        source: string;
        scope: string;
        acceptsArgs: boolean;
      }>;
    }) => void = () => {};
    const commands = new Promise<{
      commands: Array<{
        name: string;
        textAliases: string[];
        description: string;
        source: string;
        scope: string;
        acceptsArgs: boolean;
      }>;
    }>((resolve) => {
      resolveCommands = resolve;
    });
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return await commands;
    });
    applyRemoteSlashCommandsResult({
      client: null,
      agentId: "other",
      result: {
        commands: [
          {
            name: "other-command",
            textAliases: ["/other-command"],
            description: "Command for the newly selected agent.",
            source: "plugin",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      },
    });
    const state = createMetadataState(request, {
      agentsList: { defaultId: "main" } as ChatPageHost["agentsList"],
      hello: { features: { methods: [] } },
    });

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    resolveCommands({
      commands: [
        {
          name: "work-command",
          textAliases: ["/work-command"],
          description: "Stale command for the previous agent.",
          source: "plugin",
          scope: "text",
          acceptsArgs: false,
        },
      ],
    });
    await refresh;

    expect(SLASH_COMMANDS.some((command) => command.name === "other-command")).toBe(true);
    expect(SLASH_COMMANDS.some((command) => command.name === "work-command")).toBe(false);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
