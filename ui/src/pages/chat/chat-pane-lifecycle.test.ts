/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-lifecycle.test/"} */

// The non-isolated runner resets modules between files but preserves customElements.
// A dedicated jsdom context keeps the registered pane class on this file's module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionSuggestion,
  SessionSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createChatAttachmentHandoff } from "../../app/chat-attachment-handoff.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { createTestChatPane, type TestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { applySelectedChatAgent } from "./chat-state-refresh.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./components/chat-message.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import { prepareInitialUserMessageHandoff } from "./initial-turn-handoff.ts";

const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const confirmationOwners = new Set<HTMLElement>();

describe("chat pane composer prefill attention", () => {
  function createComposerAttentionFixture() {
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const input = document.createElement("div");
    input.className = "agent-chat__input";
    const textarea = document.createElement("textarea");
    input.append(textarea);
    document.body.append(input);
    vi.spyOn(pane, "querySelector").mockReturnValue(textarea);
    const lifecycle = pane as TestChatPane & {
      focusComposer: boolean;
      updated: (changedProperties?: Map<PropertyKey, unknown>) => void;
    };
    lifecycle.focusComposer = true;
    return { input, lifecycle, textarea };
  }

  it("focuses and clears the one-shot composer cue for an explicit route hint", () => {
    vi.useFakeTimers();
    const { input, lifecycle, textarea } = createComposerAttentionFixture();

    lifecycle.updated(new Map([["focusComposer", false]]));

    expect(document.activeElement).toBe(textarea);
    expect(input.classList.contains("agent-chat__input--prefill-attention")).toBe(true);
    vi.advanceTimersByTime(599);
    expect(input.classList.contains("agent-chat__input--prefill-attention")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(input.classList.contains("agent-chat__input--prefill-attention")).toBe(false);
    input.remove();
  });

  it("restarts the cue without letting the prior timer clear it", () => {
    vi.useFakeTimers();
    const { input, lifecycle } = createComposerAttentionFixture();

    lifecycle.updated(new Map([["focusComposer", false]]));
    vi.advanceTimersByTime(300);
    lifecycle.updated(new Map([["focusComposer", false]]));
    vi.advanceTimersByTime(599);

    expect(input.classList.contains("agent-chat__input--prefill-attention")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(input.classList.contains("agent-chat__input--prefill-attention")).toBe(false);
    input.remove();
  });
});

describe("chat pane first-turn attachment lifecycle", () => {
  it("claims the connected client's first message before attaching the pane", () => {
    const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
    const targetSessionKey = "agent:main:created-session";
    const client = {
      addEventListener: vi.fn(() => vi.fn()),
      request: vi.fn(),
    } as unknown as GatewayBrowserClient;
    const context = {
      basePath: "",
      gateway: {
        snapshot: { client, hello: null },
        subscribe: vi.fn(() => vi.fn()),
        subscribeEvents: vi.fn(() => vi.fn()),
      },
      config: {
        current: {
          assistantIdentity: {
            agentId: null,
            name: "Assistant",
            avatar: null,
            avatarSource: null,
            avatarStatus: null,
            avatarReason: null,
          },
          serverVersion: null,
          localMediaPreviewRoots: [],
          embedSandboxMode: "strict",
          allowExternalEmbedUrls: false,
          terminalEnabled: false,
        },
      },
      agentSelection: { state: { selectedId: "main" } },
      agents: { state: { agentsList: null } },
      initialUserMessage: createInitialUserMessageHandoff(),
      chatAttachmentHandoff: createChatAttachmentHandoff(),
      sessions: {},
    } as unknown as ApplicationContext;
    prepareInitialUserMessageHandoff(
      context.initialUserMessage,
      targetSessionKey,
      { attachments: [], createdAt: 1, text: "keep the first prompt visible" },
      client,
      { runId: "initial-run" },
    );
    pane.sessionKey = targetSessionKey;
    pane.chatMessagesBySession = new Map();
    pane.context = context;
    const stopAfterAttach = new Error("stop after attach");
    let attachedState: ChatPageHost | undefined;
    vi.spyOn(pane.chatState, "attach").mockImplementation((state) => {
      attachedState = state;
      throw stopAfterAttach;
    });

    try {
      expect(() => pane.connectedCallback()).toThrow(stopAfterAttach);
      expect(attachedState?.client).toBe(client);
      expect(attachedState?.chatMessages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({ type: "text", text: "keep the first prompt visible" }),
          ],
        }),
      ]);
    } finally {
      pane.disconnectedCallback();
    }
  });
});

describe("chat pane session suggestion lifecycle", () => {
  it("does not let a stale add completion clear a newer session operation", async () => {
    const first = createDeferred<{ suggestion: SessionSuggestion }>();
    const second = createDeferred<{ suggestion: SessionSuggestion }>();
    const client = {
      request: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.chatAttachments = [];
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    const row = (id: string, text: string): SessionSuggestion => ({
      id,
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text,
      createdAt: 1,
      state: "pending",
    });

    state.chatMessage = "first";
    const firstPending = pane.addCurrentSessionSuggestion();
    pane.resetSessionSuggestions();
    state.chatMessage = "second";
    const secondPending = pane.addCurrentSessionSuggestion();

    first.resolve({ suggestion: row("first", "first") });
    await firstPending;
    expect(pane.sessionSuggestionAddOperation).toBeDefined();
    expect(pane.sessionSuggestions.some((suggestion) => suggestion.id === "first")).toBe(false);
    second.resolve({ suggestion: row("second", "second") });
    await secondPending;
    expect(pane.sessionSuggestionAddOperation).toBeUndefined();
  });

  it("rejects suggestion submission while attachments remain", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    state.chatMessage = "text only";
    state.chatAttachments = [{ id: "attachment" } as never];

    await pane.addCurrentSessionSuggestion();
    expect(request).not.toHaveBeenCalled();
    expect(state.chatError).toContain("Remove attachments");
  });

  it("coalesces overlapping refreshes and applies the event-invalidated follow-up", async () => {
    const firstList = createDeferred<SessionSuggestionsListResult>();
    const secondList = createDeferred<SessionSuggestionsListResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockReturnValueOnce(secondList.promise);
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: 1,
          visibility: "suggest",
          sharingRole: "viewer",
        },
      ],
    } as never;
    const eventSuggestion: SessionSuggestion = {
      id: "event",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "new event",
      createdAt: 1,
      state: "pending",
    };
    const existingSuggestion: SessionSuggestion = {
      ...eventSuggestion,
      id: "existing",
      text: "already queued",
      createdAt: 0,
    };

    const pending = pane.refreshSessionSuggestions();
    const overlapping = pane.refreshSessionSuggestions();
    expect(request).toHaveBeenCalledTimes(1);
    pane.handleSessionSuggestionEvent({ action: "added", suggestion: eventSuggestion });
    firstList.resolve({ suggestions: [existingSuggestion], role: "viewer" });
    await Promise.all([pending, overlapping]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    secondList.resolve({ suggestions: [existingSuggestion, eventSuggestion], role: "viewer" });
    await vi.waitFor(() =>
      expect(pane.sessionSuggestions).toEqual([existingSuggestion, eventSuggestion]),
    );
    expect(pane.sessionSuggestionRole).toBe("viewer");
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("clears cached suggestions until a rotated session instance list resolves", async () => {
    const listed = createDeferred<SessionSuggestionsListResult>();
    const request = vi.fn(() => listed.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    const row = (sessionId: string): GatewaySessionRow =>
      ({
        key: state.sessionKey,
        kind: "direct",
        sessionId,
        updatedAt: 1,
        visibility: "suggest",
        sharingRole: "owner",
      }) as GatewaySessionRow;
    const stale: SessionSuggestion = {
      id: "stale-instance",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "old instance",
      createdAt: 1,
      state: "pending",
    };
    const fresh: SessionSuggestion = {
      ...stale,
      id: "fresh-instance",
      text: "new instance",
    };

    pane.syncSessionSuggestionTarget("main", row("session-a"));
    await pane.refreshSessionSuggestions();
    pane.sessionSuggestions = [stale];
    state.sessionsResultAgentId = "main";
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [row("session-b")],
    } as never;

    pane.syncSessionSuggestionTarget("main", row("session-b"));

    expect(pane.sessionSuggestions).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    listed.resolve({ suggestions: [fresh], role: "owner" });
    await vi.waitFor(() => expect(pane.sessionSuggestions).toEqual([fresh]));
  });

  it("clears displayed typing actors when the session instance rotates", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    const row = (sessionId: string): GatewaySessionRow =>
      ({
        key: state.sessionKey,
        kind: "direct",
        sessionId,
        updatedAt: 1,
        visibility: "suggest",
        sharingRole: "owner",
      }) as GatewaySessionRow;
    const sessionA = row("session-a");
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [sessionA],
    } as never;
    pane.syncSessionSuggestionTarget("main", sessionA);
    pane.handleSessionTypingEvent({
      sessionKey: state.sessionKey,
      sessionId: "session-a",
      agentId: "main",
      actor: { type: "human", id: "alice", label: "Alice" },
      typing: true,
      ts: 1,
    });
    expect(pane.typingActors.size).toBe(1);

    const sessionB = row("session-b");
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [sessionB],
    } as never;
    pane.syncSessionSuggestionTarget("main", sessionB);

    expect(pane.typingActors.size).toBe(0);
  });

  it("preserves an author's resolved event while its role is still loading", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    pane.context.gateway.snapshot.selfUser = { id: "alice" } as never;
    const pending: SessionSuggestion = {
      id: "mine",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "my suggestion",
      createdAt: 1,
      state: "pending",
    };
    pane.sessionSuggestions = [pending];

    pane.handleSessionSuggestionEvent({
      action: "resolved",
      suggestion: { ...pending, state: "accepted" },
    });
    expect(pane.sessionSuggestions).toEqual([{ ...pending, state: "accepted" }]);
  });

  it("keeps an owner's self-authored resolved suggestion through the following list", async () => {
    const listed = createDeferred<SessionSuggestionsListResult>();
    const resolvedResponse = createDeferred<{ suggestion: SessionSuggestion }>();
    const request = vi.fn((method: string) => {
      if (method === "session.suggestions.resolve") {
        return resolvedResponse.promise;
      }
      if (method === "session.suggestions.list") {
        return listed.promise;
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    pane.presencePayload = {
      presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
    };
    pane.context.gateway.snapshot.selfUser = { id: "owner" } as never;
    state.sessionsResult = {
      count: 1,
      path: "",
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          updatedAt: 1,
          visibility: "suggest",
          sharingRole: "owner",
        },
      ],
    } as never;
    const pending: SessionSuggestion = {
      id: "owner-suggestion",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "owner", label: "Owner" },
      text: "my resolved suggestion",
      createdAt: 1,
      state: "pending",
    };
    const resolved = { ...pending, state: "accepted" as const };
    pane.sessionSuggestionRole = "owner";
    pane.sessionSuggestions = [pending];

    const resolving = pane.resolveCurrentSessionSuggestion(pending, "queue");
    expect(request).toHaveBeenCalledTimes(1);
    pane.handleSessionSuggestionEvent({ action: "resolved", suggestion: resolved });
    expect(pane.sessionSuggestions).toEqual([resolved]);
    expect(request).toHaveBeenCalledTimes(2);

    listed.resolve({ suggestions: [resolved], role: "owner" });
    await vi.waitFor(() => expect(pane.sessionSuggestions).toEqual([resolved]));
    resolvedResponse.resolve({ suggestion: resolved });
    await resolving;

    expect(pane.sessionSuggestions).toEqual([resolved]);
    expect(pane.sessionSuggestionRole).toBe("owner");
  });

  it("drops a resolve completion after the same session key rotates instances", async () => {
    const response = createDeferred<{ suggestion: SessionSuggestion }>();
    const client = {
      request: vi.fn(() => response.promise),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const session = (sessionId: string): GatewaySessionRow =>
      ({
        key: state.sessionKey,
        kind: "direct",
        sessionId,
        updatedAt: 1,
        visibility: "suggest",
        sharingRole: "owner",
      }) as GatewaySessionRow;
    const suggestion: SessionSuggestion = {
      id: "old-instance-resolution",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "owner", label: "Owner" },
      text: "old instance suggestion",
      createdAt: 1,
      state: "pending",
    };
    pane.context.gateway.snapshot.selfUser = { id: "owner" } as never;
    pane.syncSessionSuggestionTarget("main", session("session-a"));
    pane.sessionSuggestions = [suggestion];

    const resolving = pane.resolveCurrentSessionSuggestion(suggestion, "queue");
    pane.syncSessionSuggestionTarget("main", session("session-b"));
    response.resolve({ suggestion: { ...suggestion, state: "accepted" } });
    await resolving;

    expect(pane.sessionSuggestions).toEqual([]);
    expect(state.chatError).toBeNull();
  });

  it.each(["draft", "shared"] as const)(
    "loads an owner's pending suggestions after visibility changes to %s",
    async (visibility) => {
      const pending: SessionSuggestion = {
        id: `pending-${visibility}`,
        sessionKey: "agent:main:current",
        agentId: "main",
        author: { type: "human", id: "alice", label: "Alice" },
        text: "still needs review",
        createdAt: 1,
        state: "pending",
      };
      const request = vi.fn(async () => ({ suggestions: [pending], role: "owner" as const }));
      const client = { request } as unknown as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({
        client,
        sessions: {} as SessionCapability,
      });
      pane.presencePayload = {
        presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
      };
      state.sessionsResult = {
        count: 1,
        path: "",
        sessions: [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 1,
            visibility,
            sharingRole: "owner",
          },
        ],
      } as never;

      await pane.refreshSessionSuggestions();

      expect(request).toHaveBeenCalledWith(
        "session.suggestions.list",
        expect.objectContaining({ sessionKey: state.sessionKey }),
      );
      expect(pane.sessionSuggestions).toEqual([pending]);
      expect(pane.sessionSuggestionRole).toBe("owner");
    },
  );

  it("does not apply an edit failure after the same session key rotates instances", async () => {
    const deferred = createDeferred<never>();
    const client = {
      request: vi.fn(() => deferred.promise),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion: SessionSuggestion = {
      id: "edit",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "suggested text",
      createdAt: 1,
      state: "pending",
    };
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
    pane.sessionSuggestionTargetSignature = "main\0agent:main:current\0session-a";
    state.chatMessage = "original";
    const pending = pane.resolveCurrentSessionSuggestion(suggestion, "edit");
    pane.sessionSuggestionTargetSignature = "main\0agent:main:current\0session-b";
    pane.resetSessionSuggestions();
    state.chatMessage = "new session draft";
    deferred.reject(new Error("old request failed"));

    await pending;
    expect(state.chatMessage).toBe("new session draft");
    expect(state.chatError).not.toBe("old request failed");
  });

  it("keeps suggested text after an ambiguous edit failure", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new Error("response lost");
      }),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion: SessionSuggestion = {
      id: "edit-ambiguous",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "preserve this suggestion",
      createdAt: 1,
      state: "pending",
    };
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
    state.chatMessage = "owner draft";

    await pane.resolveCurrentSessionSuggestion(suggestion, "edit");

    expect(state.chatMessage).toBe("preserve this suggestion");
    expect(state.chatError).toBe("response lost");
  });

  it("restores an untouched owner draft after a definite edit rejection", async () => {
    const client = {
      request: vi.fn(async () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "suggestion already resolved",
        });
      }),
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion: SessionSuggestion = {
      id: "edit-rejected",
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text: "rejected suggestion",
      createdAt: 1,
      state: "pending",
    };
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
    state.chatMessage = "owner draft";

    await pane.resolveCurrentSessionSuggestion(suggestion, "edit");

    expect(state.chatMessage).toBe("owner draft");
    expect(state.chatError).toBe("suggestion already resolved");
  });

  it("serializes edit resolutions so rejected suggestions cannot snapshot each other", async () => {
    const first = createDeferred<never>();
    const second = createDeferred<never>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });
    const suggestion = (id: string, text: string): SessionSuggestion => ({
      id,
      sessionKey: state.sessionKey,
      agentId: "main",
      author: { type: "human", id: "alice", label: "Alice" },
      text,
      createdAt: 1,
      state: "pending",
    });
    state.handleChatDraftChange = (next) => {
      state.chatMessage = next;
    };
    state.chatMessage = "owner draft";

    const firstPending = pane.resolveCurrentSessionSuggestion(suggestion("first", "first"), "edit");
    await pane.resolveCurrentSessionSuggestion(suggestion("second", "second"), "edit");
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.chatMessage).toBe("first");

    first.reject(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "first was rejected" }),
    );
    await firstPending;
    expect(state.chatMessage).toBe("owner draft");

    const secondPending = pane.resolveCurrentSessionSuggestion(
      suggestion("second", "second"),
      "edit",
    );
    second.reject(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "second was rejected" }),
    );
    await secondPending;
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessage).toBe("owner draft");
  });
});

function createConfirmationOwner() {
  const owner = document.createElement("span");
  owner.className = "chat-confirm-wrap";
  const trigger = document.createElement("button");
  owner.appendChild(trigger);
  document.body.appendChild(owner);
  confirmationOwners.add(owner);
  openChatRewindConfirmation(trigger, vi.fn());
  const popover = [...document.querySelectorAll<HTMLElement>(".chat-confirm-popover")].at(-1);
  expect(popover).toBeInstanceOf(HTMLElement);
  return { owner, popover: popover! };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const owner of confirmationOwners) {
    dismissConfirmedActionPopovers(owner);
    owner.remove();
  }
  confirmationOwners.clear();
  chatThread.resetThreadPresentation();
  window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
  vi.unstubAllGlobals();
});

describe("chat pane presentation teardown", () => {
  it("dismisses only confirmations owned by the disconnected pane", () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const addDocumentListener = vi.spyOn(document, "addEventListener");
    const removeDocumentListener = vi.spyOn(document, "removeEventListener");
    const addWindowListener = vi.spyOn(window, "addEventListener");
    const removeWindowListener = vi.spyOn(window, "removeEventListener");
    const { pane } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    window.localStorage.removeItem(SKIP_REWIND_CONFIRM_PREFERENCE);
    const paneConfirmation = createConfirmationOwner();
    const siblingConfirmation = createConfirmationOwner();

    for (const callback of frameCallbacks.splice(0)) {
      callback(0);
    }
    const captureClickListeners = addDocumentListener.mock.calls.flatMap(
      ([type, listener, options]) =>
        type === "click" && options === true && listener ? [listener] : [],
    );
    const captureKeydownListeners = addWindowListener.mock.calls.flatMap(
      ([type, listener, options]) =>
        type === "keydown" && options === true && listener ? [listener] : [],
    );
    expect(captureClickListeners).toHaveLength(2);
    expect(captureKeydownListeners).toHaveLength(2);

    pane.appendChild(paneConfirmation.owner);
    pane.disconnectedCallback();

    expect(paneConfirmation.popover.isConnected).toBe(false);
    expect(siblingConfirmation.popover.isConnected).toBe(true);
    expect(removeDocumentListener).toHaveBeenCalledWith("click", captureClickListeners[0], true);
    expect(removeDocumentListener).not.toHaveBeenCalledWith(
      "click",
      captureClickListeners[1],
      true,
    );
    expect(removeWindowListener).toHaveBeenCalledWith("keydown", captureKeydownListeners[0], true);
    expect(removeWindowListener).not.toHaveBeenCalledWith(
      "keydown",
      captureKeydownListeners[1],
      true,
    );
  });
});

describe("chat pane connection lifecycle", () => {
  it("renders once while initially hidden, then reconciles hidden invalidations", async () => {
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const { pane, requestUpdate, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const lifecycle = pane as TestChatPane & {
      performUpdate: () => void;
      hasUpdated: boolean;
      render: () => unknown;
      requestUpdate: () => void;
    };
    lifecycle.render = () => null;
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await vi.waitFor(() => expect(lifecycle.hasUpdated).toBe(true), { interval: 1, timeout: 50 });
    await lifecycle.updateComplete;
    const performUpdate = vi.spyOn(lifecycle, "performUpdate");
    const cancelAnimationFrame = vi.spyOn(globalThis, "cancelAnimationFrame");

    state.chatStreamRenderFrame = 7;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(state.chatStreamRenderFrame).toBeNull();
    expect(requestUpdate).toHaveBeenCalledOnce();
    lifecycle.requestUpdate();
    lifecycle.requestUpdate();
    await Promise.resolve();
    expect(performUpdate).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await lifecycle.updateComplete;
    expect(performUpdate).toHaveBeenCalledOnce();

    const addVisibilityListener = vi.spyOn(document, "addEventListener");
    const removeVisibilityListener = vi.spyOn(document, "removeEventListener");
    visibilityState = "hidden";
    lifecycle.requestUpdate();
    await Promise.resolve();
    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
    expect(removeVisibilityListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: true });
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await Promise.resolve();
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await lifecycle.updateComplete;
    expect(performUpdate).toHaveBeenCalledTimes(2);

    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
    addVisibilityListener.mockClear();
    lifecycle.requestUpdate();
    await lifecycle.updateComplete;
    expect(addVisibilityListener).not.toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("fully tears down realtime Talk when the gateway disconnects", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const stop = vi.fn(() => {
      expect(state.realtimeTalkSession).toBeNull();
    });
    state.realtimeTalkSession = { stop } as unknown as ChatPageHost["realtimeTalkSession"];
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "listening";
    state.realtimeTalkDetail = "live";
    state.realtimeTalkInputLevel.set(0.7);
    state.realtimeTalkConversation = [
      { id: "utterance", role: "user", text: "stale", isStreaming: true },
    ];
    state.realtimeTalkVideoStream = {} as MediaStream;
    state.realtimeTalkCameraDevices = [{ deviceId: "camera", label: "Camera" }];
    state.realtimeTalkVideoCapable = true;
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = true;

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });

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

  it("advances session ownership once per same-client connection transition", async () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const initialGeneration = pane.connectionGeneration;
    const snapshot = { ...pane.context.gateway.snapshot, client };

    state.chatLoading = true;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });

    expect(pane.connectionGeneration).toBe(initialGeneration + 1);
    expect(state.connectionEpoch).toBe(initialGeneration + 1);
    expect(state.chatLoading).toBe(false);

    state.chatLoading = true;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });

    expect(pane.connectionGeneration).toBe(initialGeneration + 1);
    expect(state.connectionEpoch).toBe(initialGeneration + 1);
    expect(state.chatLoading).toBe(true);

    pane.connectedClient = client;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });

    expect(pane.connectionGeneration).toBe(initialGeneration + 2);
    expect(state.connectionEpoch).toBe(initialGeneration + 2);
    await vi.waitFor(() => expect(state.chatLoading).toBe(false));

    state.chatLoading = true;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });

    expect(pane.connectionGeneration).toBe(initialGeneration + 2);
    expect(state.connectionEpoch).toBe(initialGeneration + 2);
    expect(state.chatLoading).toBe(true);
  });

  it("cancels scroll work owned by the prior Gateway connection", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const cancelCommit = vi.fn();
    const initialScrollGeneration = state.chatScrollGeneration;
    state.chatScrollCommitCleanup = cancelCommit;

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(cancelCommit).toHaveBeenCalledOnce();
    expect(state.chatScrollCommitCleanup).toBeNull();
    expect(state.chatScrollGeneration).toBe(initialScrollGeneration + 1);
  });

  it("retires pending model selection state when the Gateway owner changes", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const retireModelOverride = vi.fn();
    const sessions = { retireModelOverride } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "global";
    state.chatModelSwitchPromises = {
      global: new Promise<boolean>(() => {}),
    };

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.chatModelSwitchPromises).toEqual({});
    expect(retireModelOverride).toHaveBeenCalledWith("global");
  });

  it("discards Guardian and system notices when Gateway ownership changes", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.guardianNotices = [
      {
        key: "guardian:old-run:review:denied",
        runId: "old-run",
        timestamp: 1,
        kind: "denied",
        command: "private command",
      },
    ];

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.guardianNotices).toEqual([]);
  });

  it("releases sending state when the Gateway owner changes", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    state.chatSending = true;
    state.chatSendingScopeKey = "agent:main";

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.chatSending).toBe(false);
    expect(state.chatSendingScopeKey).toBeNull();
  });

  it.each([
    { sessionKey: "agent:work:main", mainKey: "main" },
    { sessionKey: "agent:work:home", mainKey: "home" },
  ])(
    "retires pending global model selection state when the selected agent changes for $sessionKey",
    ({ sessionKey, mainKey }) => {
      const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
      const retireModelOverride = vi.fn();
      const sessions = { retireModelOverride } as unknown as SessionCapability;
      const { state } = createTestChatPane({ client, sessions });
      state.sessionKey = sessionKey;
      state.agentsList = { defaultId: "main", mainKey, scope: "global", agents: [] };
      state.assistantAgentId = "work";
      state.chatModelSwitchPromises = {
        global: new Promise<boolean>(() => {}),
      };

      applySelectedChatAgent(state, "main");

      expect(state.chatModelSwitchPromises).toEqual({});
      expect(state.assistantAgentId).toBe("main");
      expect(retireModelOverride).toHaveBeenCalledWith(sessionKey);
      expect(retireModelOverride).toHaveBeenCalledWith("global");
    },
  );

  it("refreshes the transcript before secondary hydration after a same-client reconnect", () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const deferHydration = vi.spyOn(pane, "deferSessionHydrationUntilTranscript");
    state.connected = false;
    pane.connectedClient = client;

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "connected",
    });

    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      expect.objectContaining({ limit: 100, sessionKey: state.sessionKey }),
    );
    expect(deferHydration).toHaveBeenCalledWith(state.sessionKey, expect.any(Promise));
  });

  it("replays a pending exact-run stop when the gateway reconnects", async () => {
    const request = vi.fn((method: string) =>
      method === "chat.abort" ? Promise.resolve({ aborted: true }) : new Promise<never>(() => {}),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const sessionKey = "agent:main";
    pane.context = {
      ...pane.context,
      config: {
        current: {
          assistantIdentity: { name: "Assistant" },
          terminalEnabled: false,
        },
      },
    } as unknown as ApplicationContext;
    state.loadAssistantIdentity = vi.fn(async () => {});
    state.realtimeTalkInputLevel = {
      set: vi.fn(),
    } as unknown as ChatPageHost["realtimeTalkInputLevel"];
    state.resetToolStream = vi.fn();
    const snapshot = {
      ...pane.context.gateway.snapshot,
      client,
      assistantAgentId: "main",
    };

    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    state.pendingAbort = { sourceClient: client, runId: "run-main", sessionKey };

    pane.applyGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["chat.abort"] },
      },
    });

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey,
        runId: "run-main",
      }),
    );
    expect(state.pendingAbort).toBeNull();

    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    expect(request.mock.calls.filter(([method]) => method === "chat.abort")).toHaveLength(1);
  });
});
