/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-lifecycle.test/"} */

// The non-isolated runner resets modules between files but preserves customElements.
// A dedicated jsdom context keeps the registered pane class on this file's module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionSuggestion,
  SessionSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state.ts";
import {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./components/chat-message.ts";
import * as chatThread from "./components/chat-thread.ts";

const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const confirmationOwners = new Set<HTMLElement>();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

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
  owner.className = "chat-delete-wrap";
  const trigger = document.createElement("button");
  owner.appendChild(trigger);
  document.body.appendChild(owner);
  confirmationOwners.add(owner);
  openChatRewindConfirmation(trigger, vi.fn());
  return owner;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const owner of confirmationOwners) {
    dismissConfirmedActionPopovers(owner);
    owner.remove();
  }
  confirmationOwners.clear();
  chatThread.resetChatThreadPresentationState();
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

    pane.appendChild(paneConfirmation);
    pane.disconnectedCallback();

    expect(pane.querySelector(".chat-delete-confirm")).toBeNull();
    expect(siblingConfirmation.querySelector(".chat-delete-confirm")).not.toBeNull();
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

  it("dismisses the previous session confirmation before switching in place", () => {
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
    const owner = createConfirmationOwner();

    try {
      for (const callback of frameCallbacks.splice(0)) {
        callback(0);
      }
      const captureClickListener = addDocumentListener.mock.calls.find(
        ([type, listener, options]) => type === "click" && options === true && listener,
      )?.[1];
      const captureKeydownListener = addWindowListener.mock.calls.find(
        ([type, listener, options]) => type === "keydown" && options === true && listener,
      )?.[1];
      expect(captureClickListener).toBeDefined();
      expect(captureKeydownListener).toBeDefined();
      pane.appendChild(owner);

      const stopAfterReset = new Error("stop after thread presentation reset");
      vi.spyOn(pane, "cancelHeaderRename").mockImplementation(() => {
        throw stopAfterReset;
      });

      expect(() => pane.switchPaneSession("agent:main:next")).toThrow(stopAfterReset);
      expect(owner.querySelector(".chat-delete-confirm")).toBeNull();
      expect(removeDocumentListener).toHaveBeenCalledWith("click", captureClickListener, true);
      expect(removeWindowListener).toHaveBeenCalledWith("keydown", captureKeydownListener, true);
    } finally {
      dismissConfirmedActionPopovers(owner);
      owner.remove();
    }
  });
});

describe("chat pane connection lifecycle", () => {
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
