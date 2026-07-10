/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { UiSettings } from "../../app/settings.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
  resetChatAttachmentPayloadStoreForTest,
} from "./attachment-payload-store.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import type { executeSlashCommand } from "./chat-command-executor.ts";
import type { ChatHost } from "./chat-send.ts";
import {
  buildChatSessionListOptions,
  getPendingChatPickerPatch,
  switchChatFastMode,
  switchChatThinkingLevel,
  trackPendingChatPickerPatch,
} from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import { readChatMessagesFromCache } from "./session-message-cache.ts";

type ExecuteSlashCommand = typeof executeSlashCommand;
type TestChatHost = Omit<ChatHost, "settings"> & {
  basePath: string;
  chatAvatarUrl: string | null;
  chatAvatarSource?: string | null;
  chatAvatarStatus?: "none" | "local" | "remote" | "data" | null;
  chatAvatarReason?: string | null;
  sessionsError?: string | null;
  sessionsResultAgentId?: string | null;
  sessionsShowArchived?: boolean;
  password?: string;
  pendingSettingsPatches?: Record<string, Promise<boolean>>;
  settings?: Partial<UiSettings>;
};

const { executeSlashCommandMock, setLastActiveSessionKeyMock } = vi.hoisted(() => ({
  executeSlashCommandMock: vi.fn(),
  setLastActiveSessionKeyMock: vi.fn(),
}));

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

vi.mock("../../app/settings.ts", () => ({
  normalizeChatAutoScrollMode: (value: unknown) =>
    value === "always" || value === "off" ? value : "near-bottom",
  setLastActiveSessionKey: (...args: unknown[]) => setLastActiveSessionKeyMock(...args),
}));

vi.mock("./chat-command-executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-command-executor.ts")>();
  return {
    ...actual,
    executeSlashCommand: (...args: Parameters<ExecuteSlashCommand>) => {
      const implementation = executeSlashCommandMock.getMockImplementation() as
        | ExecuteSlashCommand
        | undefined;
      return implementation
        ? executeSlashCommandMock(...args)
        : actual.executeSlashCommand(...args);
    },
  };
});

let handleSendChat: typeof import("./chat-send.ts").handleSendChat;
let steerQueuedChatMessage: typeof import("./chat-send.ts").steerQueuedChatMessage;
let navigateChatInputHistory: typeof import("./chat-send.ts").navigateChatInputHistory;
let handleAbortChat: typeof import("./run-lifecycle.ts").handleAbortChat;
let hasAbortableSessionRun: typeof import("./run-lifecycle.ts").hasAbortableSessionRun;
let refreshChat: (
  host: TestChatHost,
  options?: Parameters<typeof import("./chat-state.ts").refreshChat>[1],
) => Promise<void>;
let handlePageGatewayEvent: typeof import("./chat-state.ts").handlePageGatewayEvent;
let clearPendingQueueItemsForRun: typeof import("./chat-queue.ts").clearPendingQueueItemsForRun;
let admitQueuedMessageForSession: typeof import("./chat-queue.ts").admitQueuedMessageForSession;
let removeQueuedMessage: typeof import("./chat-queue.ts").removeQueuedMessage;
let removeDeliveredQueuedChatSendForRun: typeof import("./chat-queue.ts").removeDeliveredQueuedChatSendForRun;
let removeVisibleOrScopedQueuedMessageWithoutReleasing: typeof import("./chat-queue.ts").removeVisibleOrScopedQueuedMessageWithoutReleasing;
let markQueuedChatSendsWaitingForReconnect: typeof import("./chat-queue.ts").markQueuedChatSendsWaitingForReconnect;
let subscribeChatOutboxProjection: typeof import("./chat-queue.ts").subscribeChatOutboxProjection;
let syncChatQueueFromStoredOutbox: typeof import("./chat-queue.ts").syncChatQueueFromStoredOutbox;
let flushChatQueueForEvent: typeof import("./chat-send.ts").flushChatQueueForEvent;
let retryReconnectableQueuedChatSends: typeof import("./chat-send.ts").retryReconnectableQueuedChatSends;
let retryQueuedChatMessage: typeof import("./chat-send.ts").retryQueuedChatMessage;
let recordChatSendServerTiming: typeof import("./chat-send-timing.ts").recordChatSendServerTiming;
let recordFirstAssistantChatTiming: typeof import("./chat-send-timing.ts").recordFirstAssistantChatTiming;

async function loadChatHelpers(): Promise<void> {
  ({
    handleSendChat,
    steerQueuedChatMessage,
    navigateChatInputHistory,
    flushChatQueueForEvent,
    retryReconnectableQueuedChatSends,
    retryQueuedChatMessage,
  } = await import("./chat-send.ts"));
  ({ recordChatSendServerTiming, recordFirstAssistantChatTiming } =
    await import("./chat-send-timing.ts"));
  const chatState = await import("./chat-state.ts");
  refreshChat = (host, options) => chatState.refreshChat(host as unknown as ChatPageHost, options);
  handlePageGatewayEvent = chatState.handlePageGatewayEvent;
  ({ handleAbortChat, hasAbortableSessionRun } = await import("./run-lifecycle.ts"));
  ({
    admitQueuedMessageForSession,
    clearPendingQueueItemsForRun,
    removeDeliveredQueuedChatSendForRun,
    removeQueuedMessage,
    markQueuedChatSendsWaitingForReconnect,
    removeVisibleOrScopedQueuedMessageWithoutReleasing,
    subscribeChatOutboxProjection,
    syncChatQueueFromStoredOutbox,
  } = await import("./chat-queue.ts"));
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number, label: string) {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call[argIndex];
}

function findRequestPayload(source: MockCallSource, method: string, label: string) {
  const call = Array.from(source.mock.calls).find((candidate) => candidate[0] === method);
  if (!call) {
    throw new Error(`expected request call: ${label}`);
  }
  return requireRecord(call[1], label);
}

function eventPayloads(host: TestChatHost, event: string): Array<Record<string, unknown>> {
  return (host.eventLogBuffer ?? [])
    .filter((entry): entry is { event: string; payload: Record<string, unknown> } => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const candidate = entry as { event?: unknown; payload?: unknown };
      return (
        candidate.event === event &&
        Boolean(candidate.payload && typeof candidate.payload === "object")
      );
    })
    .map((entry) => entry.payload);
}

function admitHostQueueItems(host: TestChatHost): void {
  const queues = [host.chatQueue, ...Object.values(host.chatQueueByScope ?? {})];
  for (const item of queues.flat()) {
    expect(
      admitStoredChatComposerQueueItem(
        host,
        item.sessionKey ?? host.sessionKey,
        item,
        item.agentId,
      ),
    ).toBe(true);
  }
}

function queueScopeKey(host: TestChatHost, sessionKey: string, agentId?: string): string {
  return storedChatOutboxScopeKey(resolveStoredChatOutboxScope(host, sessionKey, agentId));
}

function fetchInit(source: MockCallSource, callIndex: number) {
  return requireRecord(mockArg(source, callIndex, 1, `fetch init ${callIndex}`), "fetch init");
}

function fetchUrl(source: MockCallSource, callIndex: number) {
  const input = mockArg(source, callIndex, 0, `fetch input ${callIndex}`);
  if (typeof input === "string" || input instanceof URL || input instanceof Request) {
    return requestUrl(input);
  }
  throw new Error(`expected fetch input ${callIndex}`);
}

function makeHost(overrides?: Partial<TestChatHost>): TestChatHost {
  const renderLifecycle: RenderLifecycle = {
    invalidate: vi.fn(),
    afterCommit: (effect) => {
      let active = true;
      renderLifecycle.invalidate();
      queueMicrotask(() => {
        if (active) {
          effect(() => undefined);
        }
      });
      return () => {
        active = false;
      };
    },
  };
  const host = {
    client: null,
    chatMessages: [],
    chatStream: null,
    chatStreamSegments: [],
    chatToolMessages: [],
    connected: true,
    chatLoading: false,
    chatMessage: "",
    chatLocalInputHistoryBySession: {},
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
    chatAttachments: [],
    chatQueue: [],
    chatQueueByScope: {},
    chatRunId: null,
    chatSending: false,
    lastError: null,
    sessionKey: "agent:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set<string>(),
    sessionsLoading: false,
    sessionsResult: null,
    sessionsResultAgentId: null,
    sessionsError: null,
    sessionsShowArchived: false,
    chatModelsLoading: false,
    chatModelCatalog: [],
    refreshSessionsAfterChat: new Map(),
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    renderLifecycle,
    querySelector: () => null,
    chatScrollCommitCleanup: null,
    chatScrollFrame: null,
    chatScrollGuardFrame: null,
    chatScrollTimeout: null,
    chatScrollGeneration: 0,
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: false,
    chatProgrammaticScrollTarget: 0,
    ...overrides,
  };
  const sessions =
    overrides?.sessions ??
    createSessionCapability({
      snapshot: {
        client: host.client,
        connected: host.connected,
        hello: host.hello,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
  for (const session of host.sessionsResult?.sessions ?? []) {
    sessions.reconcile(session, host.sessionsResult?.defaults, {
      selectedGlobalAgentId: host.assistantAgentId,
      showArchived: host.sessionsShowArchived,
    });
  }
  const resolvedHost = { ...host, sessions } as TestChatHost;
  for (const [sessionKey, patchPromise] of Object.entries(
    overrides?.pendingSettingsPatches ?? {},
  )) {
    trackPendingChatPickerPatch(resolvedHost, sessionKey, patchPromise);
  }
  return resolvedHost;
}

function createSessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

function idleChatHistory(sessionKey = "agent:main") {
  return {
    messages: [],
    sessionInfo: row(sessionKey, { hasActiveRun: false, status: "done" }),
  };
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

const neverSettlesPromise: Promise<never> = Promise.race([]);

function pendingPromise<T = unknown>(): Promise<T> {
  return neverSettlesPromise as Promise<T>;
}

async function raceWithMacrotask(promise: Promise<unknown>): Promise<"resolved" | "pending"> {
  return await Promise.race([
    promise.then(() => "resolved" as const),
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

describe("refreshChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Chat session refreshes active-only when Sessions shows archived rows", () => {
    expect(buildChatSessionListOptions({ sessionsShowArchived: true })).toMatchObject({
      activeMinutes: 0,
      limit: 50,
      showArchived: false,
    });
  });

  it("dispatches chat refresh work without waiting for slow history RPCs", async () => {
    const request = vi.fn(() => pendingPromise());
    const requestUpdate = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      requestUpdate,
    });

    const refresh = refreshChat(host);
    const outcome = await raceWithMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(host.chatLoading).toBe(true);
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "main",
      limit: 100,
    });
    expect(request).not.toHaveBeenCalledWith("models.list", { view: "configured" });
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    expect(request).not.toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      includeArgs: true,
      scope: "text",
    });
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("scopes global chat refresh session rows to the selected agent", async () => {
    const request = vi.fn(() => pendingPromise());
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    const refresh = refreshChat(host);
    const outcome = await raceWithMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "global",
      agentId: "work",
      limit: 100,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });

  it("scopes agent main aliases as selected global chat refreshes", async () => {
    const request = vi.fn(() => pendingPromise());
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:work:main",
      agentsList: { defaultId: "main", mainKey: "main" },
    });

    const refresh = refreshChat(host);
    const outcome = await raceWithMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:work:main",
      agentId: "work",
      limit: 100,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });

  it("scopes agent session refresh rows before the list limit", async () => {
    const request = vi.fn(() => pendingPromise());
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:work:dashboard",
      agentsList: { defaultId: "main", mainKey: "main" },
    });

    const refresh = refreshChat(host);
    const outcome = await raceWithMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:work:dashboard",
      limit: 100,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });

  it("uses hello default for global chat refresh before agents list loads", async () => {
    const request = vi.fn(() => pendingPromise());
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "global",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        snapshot: { sessionDefaults: { defaultAgentId: "ops" } },
      },
    });

    const refresh = refreshChat(host);
    const outcome = await raceWithMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "global",
      agentId: "ops",
      limit: 100,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });

  it("keeps unknown chat refresh session rows unscoped", async () => {
    const request = vi.fn(() => pendingPromise());
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "unknown",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    const refresh = refreshChat(host);
    const outcome = await raceWithMacrotask(refresh);

    expect(outcome).toBe("resolved");
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "unknown",
      limit: 100,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });

  it("can wait for history without waiting for secondary work", async () => {
    const history = createDeferred<unknown>();
    const requestUpdate = vi.fn();
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return history.promise;
      }
      return pendingPromise();
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      requestUpdate,
    });

    const refresh = refreshChat(host, { awaitHistory: true, scheduleScroll: false });
    const pendingOutcome = await raceWithMacrotask(refresh);

    expect(pendingOutcome).toBe("pending");
    history.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
    });

    await expect(refresh).resolves.toBeUndefined();
    expect(host.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "ready" }] },
    ]);
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("records chat history timing when a reload keeps active stream state visible", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
        });
      }
      return pendingPromise();
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatRunId: "run-main",
      chatStream: "partial",
      eventLogBuffer: [],
    });

    await refreshChat(host, { awaitHistory: true, scheduleScroll: false });

    expect(host.chatStream).toBe("partial");
    expect(eventPayloads(host, "control-ui.chat.history")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "start",
          sessionKey: "main",
          previousRunId: "run-main",
        }),
        expect.objectContaining({
          phase: "applied",
          sessionKey: "main",
          previousRunId: "run-main",
          resetStream: true,
        }),
      ]),
    );
  });

  it("drains a restored queue after refresh proves the selected session is idle", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:dashboard", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "restored send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      return {};
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:dashboard",
      chatQueue: [{ id: "queued-1", text: "after reload", createdAt: 1 }],
    });
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:dashboard",
        message: "after reload",
      }),
    );
    expect(host.chatQueue).toEqual([]);
  });

  it("drains a restored queue from history metadata when the visible list is scoped elsewhere", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:work:dashboard", {
            hasActiveRun: false,
            status: "done",
          }),
        };
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "scoped restored send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      return {};
    });
    const previousSessionsResult = createSessionsResult([
      row("agent:main:main", { hasActiveRun: false, status: "done" }),
    ]);
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:work:dashboard",
      sessionsResult: previousSessionsResult,
      chatQueue: [{ id: "queued-1", text: "after scoped reload", createdAt: 1 }],
    });
    (host as unknown as ChatHost & { sessionsResultAgentId: string }).sessionsResultAgentId =
      "main";
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(host.sessionsResult).toBe(previousSessionsResult);
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:work:dashboard",
        message: "after scoped reload",
      }),
    );
    expect(host.chatQueue).toEqual([]);
  });

  it("drains a restored queue when global history metadata answers an agent main alias", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("global", {
            kind: "global",
            hasActiveRun: false,
            status: "done",
          }),
        };
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "global restored send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      return {};
    });
    const previousSessionsResult = createSessionsResult([
      row("agent:main:main", { hasActiveRun: false, status: "done" }),
    ]);
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:work:main",
      agentsList: { defaultId: "main", mainKey: "main" },
      sessionsResult: previousSessionsResult,
      chatQueue: [{ id: "queued-1", text: "after global alias reload", createdAt: 1 }],
    });
    (host as unknown as ChatHost & { sessionsResultAgentId: string }).sessionsResultAgentId =
      "main";
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "global",
        agentId: "work",
        message: "after global alias reload",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    expect(host.chatQueue).toEqual([]);
  });

  it("drains a restored queue from fresh history metadata despite stale sessions errors", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:dashboard", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "stale-error restored send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      return {};
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:dashboard",
      sessionsError: "old sessions.list failure",
      chatQueue: [{ id: "queued-1", text: "after stale error", createdAt: 1 }],
    });
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main:dashboard",
        message: "after stale error",
      }),
    );
    expect(host.chatQueue).toEqual([]);
  });

  it("keeps a restored queue while the selected session is still active", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:dashboard", { hasActiveRun: true, status: "running" }),
        };
      }
      return {};
    });
    const restoredQueue = [{ id: "queued-1", text: "after active run", createdAt: 1 }];
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:dashboard",
      chatQueue: restoredQueue,
    });
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toEqual([expect.objectContaining(restoredQueue[0])]);
    expect(host.chatRunId).toBeNull();
  });

  it("keeps a restored queue when stale history says a newer active row is idle", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:dashboard", {
            hasActiveRun: false,
            status: "done",
            updatedAt: 5,
          }),
        };
      }
      return {};
    });
    const restoredQueue = [{ id: "queued-1", text: "after active run", createdAt: 1 }];
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:dashboard",
      chatQueue: restoredQueue,
      sessionsResult: createSessionsResult([
        row("agent:main:dashboard", {
          hasActiveRun: true,
          status: "running",
          updatedAt: 10,
          startedAt: 9,
        }),
      ]),
    });
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toEqual([expect.objectContaining(restoredQueue[0])]);
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      status: "running",
      updatedAt: 10,
    });
  });

  it("keeps a restored queue when history has no selected-session metadata", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });
    const restoredQueue = [{ id: "queued-1", text: "after reload", createdAt: 1 }];
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:dashboard",
      chatQueue: restoredQueue,
      sessionsResult: createSessionsResult([
        row("agent:main:dashboard", { hasActiveRun: false, status: "done" }),
      ]),
    });
    admitHostQueueItems(host);

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toEqual([expect.objectContaining(restoredQueue[0])]);
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });
});

describe("refreshChatAvatar", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  afterEach(() => {
    resetChatAttachmentPayloadStoreForTest();
    vi.unstubAllGlobals();
  });

  it("uses a route-relative avatar endpoint before basePath bootstrap finishes", async () => {
    const createObjectURL = vi.fn(() => "blob:local-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ avatarUrl: "/avatar/main" }),
        });
      }
      if (url === "/avatar/main") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(fetchUrl(fetchMock as unknown as MockCallSource, 0)).toBe("/avatar/main?meta=1");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).method).toBe("GET");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 1)).toBe("/avatar/main");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1).method).toBe("GET");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1)).not.toHaveProperty("headers");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:local-avatar");
  });

  it("prefers the paired device token for avatar metadata and local avatar URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:device-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/openclaw/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ avatarUrl: "/avatar/main" }),
        });
      }
      if (url === "/avatar/main") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({
      basePath: "/openclaw/",
      sessionKey: "agent:main",
      settings: { token: "session-token" },
      password: "shared-password",
      hello: { auth: { deviceToken: "device-token" } } as ChatHost["hello"],
    });
    await refreshChatAvatar(host);

    expect(fetchUrl(fetchMock as unknown as MockCallSource, 0)).toBe(
      "/openclaw/avatar/main?meta=1",
    );
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).method).toBe("GET");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).headers).toEqual({
      Authorization: "Bearer device-token",
    });
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 1)).toBe("/avatar/main");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1).method).toBe("GET");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1).headers).toEqual({
      Authorization: "Bearer device-token",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:device-avatar");
  });

  it("fetches local avatars through Authorization headers instead of tokenized URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:session-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/openclaw/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ avatarUrl: "/avatar/main" }),
        });
      }
      if (url === "/avatar/main") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({
      basePath: "/openclaw/",
      sessionKey: "agent:main",
      settings: { token: "session-token" },
    });
    await refreshChatAvatar(host);

    expect(fetchUrl(fetchMock as unknown as MockCallSource, 0)).toBe(
      "/openclaw/avatar/main?meta=1",
    );
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).method).toBe("GET");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).headers).toEqual({
      Authorization: "Bearer session-token",
    });
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 1)).toBe("/avatar/main");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1).method).toBe("GET");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1).headers).toEqual({
      Authorization: "Bearer session-token",
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:session-avatar");
  });

  it("keeps mounted dashboard avatar endpoints under the normalized base path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "/openclaw/", sessionKey: "agent:ops:main" });
    await refreshChatAvatar(host);

    expect(fetchUrl(fetchMock as unknown as MockCallSource, 0)).toBe("/openclaw/avatar/ops?meta=1");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).method).toBe("GET");
    expect(host.chatAvatarUrl).toBeNull();
  });

  it("drops remote avatar metadata so the control UI can rely on same-origin images only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        avatarUrl: "https://example.com/avatar.png",
        avatarSource: "https://example.com/avatar.png",
        avatarStatus: "remote",
        avatarReason: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("https://example.com/avatar.png");
    expect(host.chatAvatarStatus).toBe("remote");
  });

  it("keeps unresolved IDENTITY.md avatar metadata when falling back to the logo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        avatarUrl: null,
        avatarSource: "assets/avatars/nova-portrait.png",
        avatarStatus: "none",
        avatarReason: "missing",
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("assets/avatars/nova-portrait.png");
    expect(host.chatAvatarStatus).toBe("none");
    expect(host.chatAvatarReason).toBe("missing");
  });

  it("ignores stale avatar responses after switching sessions", async () => {
    const createObjectURL = vi.fn(() => "blob:ops-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const mainRequest = createDeferred<{ avatarUrl?: string }>();
    const opsRequest = createDeferred<{ avatarUrl?: string }>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => mainRequest.promise,
        });
      }
      if (url === "/avatar/ops?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => opsRequest.promise,
        });
      }
      if (url === "/avatar/ops") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main:main" });

    const firstRefresh = refreshChatAvatar(host);
    host.sessionKey = "agent:ops:main";
    const secondRefresh = refreshChatAvatar(host);

    mainRequest.resolve({ avatarUrl: "/avatar/main" });
    await firstRefresh;
    expect(host.chatAvatarUrl).toBeNull();

    opsRequest.resolve({ avatarUrl: "/avatar/ops" });
    await secondRefresh;

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(host.chatAvatarUrl).toBe("blob:ops-avatar");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 0)).toBe("/avatar/main?meta=1");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 0).method).toBe("GET");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 1)).toBe("/avatar/ops?meta=1");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 1).method).toBe("GET");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 2)).toBe("/avatar/ops");
    expect(fetchInit(fetchMock as unknown as MockCallSource, 2).method).toBe("GET");
  });

  it("ignores stale global avatar responses after switching selected agents", async () => {
    const createObjectURL = vi.fn(() => "blob:ops-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const workRequest = createDeferred<{ avatarUrl?: string }>();
    const opsRequest = createDeferred<{ avatarUrl?: string }>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/avatar/work?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => workRequest.promise,
        });
      }
      if (url === "/avatar/ops?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => opsRequest.promise,
        });
      }
      if (url === "/avatar/ops") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({
      basePath: "",
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });

    const firstRefresh = refreshChatAvatar(host);
    host.assistantAgentId = "ops";
    const secondRefresh = refreshChatAvatar(host);

    workRequest.resolve({ avatarUrl: "/avatar/work" });
    await firstRefresh;
    expect(host.chatAvatarUrl).toBeNull();

    opsRequest.resolve({ avatarUrl: "/avatar/ops" });
    await secondRefresh;

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(host.chatAvatarUrl).toBe("blob:ops-avatar");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 0)).toBe("/avatar/work?meta=1");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 1)).toBe("/avatar/ops?meta=1");
    expect(fetchUrl(fetchMock as unknown as MockCallSource, 2)).toBe("/avatar/ops");
  });
});

describe("refreshChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  it("does not wait for secondary session refreshes before showing history", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => pendingPromise<Response>()) as never;
    try {
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return Promise.resolve({
            messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
          });
        }
        return pendingPromise();
      });
      const host = makeHost({
        client: { request } as unknown as ChatHost["client"],
        sessionKey: "main",
      });

      const outcome = await raceWithMacrotask(refreshChat(host));

      expect(outcome).toBe("resolved");
      expect(host.chatMessages).toEqual([
        { role: "assistant", content: [{ type: "text", text: "ready" }] },
      ]);
      expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("handleSendChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  beforeEach(() => {
    executeSlashCommandMock.mockReset();
    setLastActiveSessionKeyMock.mockReset();
    vi.stubGlobal("sessionStorage", createStorageMock());
  });

  it("preserves the visible bare main route for an immediate send", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { runId: "bare-main-run", status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      agentsList: { defaultId: "main", mainKey: "main" },
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "stay on the visible route",
      sessionKey: "main",
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: "stay on the visible route",
        sessionKey: "main",
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("cancels button-triggered /new resets when confirmation is declined", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "keep this draft",
      sessionKey: "agent:main",
    });

    await handleSendChat(host, "/new", { confirmReset: true, restoreDraft: true });

    expect(confirm).toHaveBeenCalledWith("Start a new session? This will reset the current chat.");
    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(host.refreshSessionsAfterChat.size).toBe(0);
  });

  it("cancels button-triggered /new resets when confirmation is unavailable", async () => {
    vi.stubGlobal("confirm", undefined);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "keep this draft",
      sessionKey: "agent:main",
    });

    await handleSendChat(host, "/new", { confirmReset: true, restoreDraft: true });

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep this draft");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(host.refreshSessionsAfterChat.size).toBe(0);
  });

  it("runs the fresh-session action for confirmed /new overrides", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const createChatSession = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "restore me",
      sessionKey: "agent:main",
      createChatSession,
    });

    await handleSendChat(host, "/new", { confirmReset: true, restoreDraft: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(host.chatMessage).toBe("restore me");
    expect(host.refreshSessionsAfterChat.size).toBe(0);
  });

  it("routes typed /new through the fresh-session action without confirmation", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const createChatSession = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/new",
      sessionKey: "agent:main",
      createChatSession,
    });

    await handleSendChat(host);

    expect(confirm).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(host.chatMessage).toBe("");
  });

  it("does not queue typed /new behind an active run", async () => {
    const createChatSession = vi.fn();
    const host = makeHost({
      chatMessage: "/new",
      chatRunId: "run-main",
      chatStream: "Working...",
      createChatSession,
    });

    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessage).toBe("");
  });

  it("preserves typed /reset command dispatch without confirmation", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/reset",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(confirm).not.toHaveBeenCalled();
    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("/reset");
    expect(host.chatMessage).toBe("");
  });

  it("parks a settings-delayed reset when the user changes sessions", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/reset",
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "/reset",
    });

    const queuedScopeKey = queueScopeKey(host, "agent:main");
    host.chatQueueByScope = { [queuedScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    settingsPatch.resolve(true);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueueByScope?.[queuedScopeKey]?.[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "/reset",
    });
  });

  it("coalesces settings-delayed redirects and preserves a newer draft", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.steer") {
        return {
          status: "started",
          runId: "redirect-run",
          messageSeq: 2,
          interruptedActiveRun: true,
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/redirect start over",
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    const duplicate = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    await duplicate;
    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("/redirect start over");

    host.chatMessage = "new draft";
    settingsPatch.resolve(true);
    await send;

    expect(request).toHaveBeenCalledWith("sessions.steer", {
      key: "agent:main",
      message: "start over",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.chatMessage).toBe("new draft");
    expect(host.chatRunId).toBe("redirect-run");
  });

  it("keeps a redirect unsent when a pending picker setting fails", async () => {
    const settingsPatch = createDeferred<boolean>();
    const attachment = {
      id: "redirect-attachment",
      mimeType: "text/plain",
      fileName: "notes.txt",
    };
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatAttachments: [attachment],
      chatMessage: "/redirect start over",
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(host.chatMessage).toBe("/redirect start over");

    settingsPatch.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("/redirect start over");
    expect(host.chatAttachments).toStrictEqual([attachment]);
    expect(host.chatRunId).toBeNull();
  });

  it.each([
    {
      input: "/reset soft please reload system prompt",
      expected: "/reset soft please reload system prompt",
    },
    {
      input: "/reset\tsoft please reload system prompt",
      expected: "/reset soft please reload system prompt",
    },
    {
      input: "/reset\nsoft please reload system prompt",
      expected: "/reset soft please reload system prompt",
    },
    {
      input: "/reset: soft please reload system prompt",
      expected: "/reset soft please reload system prompt",
    },
  ])("preserves $input args and skips confirmation dialog", async ({ input, expected }) => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: input,
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(confirm).not.toHaveBeenCalled();
    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe(expected);
    expect(host.chatMessage).toBe("");
  });

  it.each([
    "/reset softish please archive",
    "/reset\tsoftish please archive",
    "/reset\nsoftish please archive",
    "/reset: softish please archive",
  ])("keeps %s on the hard-reset confirmation path", async (message) => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "keep this draft",
      sessionKey: "agent:main",
    });

    await handleSendChat(host, message, {
      confirmReset: true,
      restoreDraft: true,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep this draft");
  });

  it("does not seed refreshSessionsAfterChat for a terminal timeout ack on a refreshing send", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "timeout" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/reset",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    const runId = String(payload.idempotencyKey);
    const runState = host as ChatHost & {
      chatStreamStartedAt?: number | null;
      lastLocalTerminalReconcile?: unknown;
    };
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(runState.chatStreamStartedAt).toBeNull();
    expect(runState.lastLocalTerminalReconcile).toMatchObject({
      phase: "interrupted",
      runId,
      sessionKey: "agent:main",
      sessionStatus: "killed",
    });
    expect(host.refreshSessionsAfterChat.size).toBe(0);
  });

  it("keeps a completed reset successful without replacing the Sessions table", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.send") {
        const payload = requireRecord(params, "chat send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "sessions.list") {
        return createSessionsResult([row("agent:main", { hasActiveRun: false, status: "done" })]);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const archivedSessions = createSessionsResult([
      row("agent:main:archived", { archived: true, status: "done" }),
    ]);
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/reset",
      sessionKey: "agent:main",
      sessionsShowArchived: true,
      sessionsResult: archivedSessions,
    });

    await handleSendChat(host);

    const runState = host as ChatHost & { lastLocalTerminalReconcile?: unknown };
    expect(runState.lastLocalTerminalReconcile).toMatchObject({
      phase: "done",
      sessionKey: "agent:main",
      sessionStatus: "done",
    });
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "sessions.list")).toBe(true),
    );
    expect(host.sessionsResult).toBe(archivedSessions);
  });

  it("marks terminal error ACK sends failed instead of accepting the queued message", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.send") {
        const payload = requireRecord(params, "chat send payload");
        return { runId: payload.idempotencyKey, status: "error" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "send before failing",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("send before failing");
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "send before failing",
      sendState: "failed",
      sendError: "Chat failed before the run started; try again.",
    });
    expect(host.lastError).toBe("Chat failed before the run started; try again.");
    expect(host.chatRunId).toBeNull();
  });

  it("records visible send timing phases for a normal chat send", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return {
          status: "started",
          serverTiming: {
            receivedToAckMs: 17,
            loadSessionMs: 4,
            prepareAttachmentsMs: 0.5,
          },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "measure first send",
      eventLogBuffer: [],
    });

    await handleSendChat(host);

    const sendEvents = eventPayloads(host, "control-ui.chat.send");
    expect(sendEvents.map((payload) => payload.phase)).toEqual(
      expect.arrayContaining(["pending-visible", "request-start", "ack"]),
    );
    const ack = sendEvents.find((payload) => payload.phase === "ack");
    expect(ack).toMatchObject({
      ackStatus: "started",
      sessionKey: "agent:main",
      sendState: "sending",
    });
    expect(ack?.durationMs).toEqual(expect.any(Number));
    expect(ack?.requestDurationMs).toEqual(expect.any(Number));
    expect(ack).toMatchObject({
      serverReceivedToAckMs: 17,
      serverLoadSessionMs: 4,
      serverPrepareAttachmentsMs: 0.5,
    });
  });

  it("records Gateway post-ACK server timing milestones for a chat send", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "measure server milestone",
      eventLogBuffer: [],
    });

    await handleSendChat(host);

    const ack = eventPayloads(host, "control-ui.chat.send").find(
      (payload) => payload.phase === "ack",
    );
    const runId = typeof ack?.runId === "string" ? ack.runId : "";
    expect(runId).toMatch(uuidPattern);

    recordChatSendServerTiming(host, {
      phase: "agent-run-started",
      runId,
      sessionKey: "agent:main",
      agentId: "main",
      ackToPhaseMs: 12,
      receivedToPhaseMs: 25,
      dispatchStartedToPhaseMs: 8,
      agentRunId: "agent-run-1",
    });

    expect(eventPayloads(host, "control-ui.chat.send")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "server-agent-run-started",
          runId,
          sessionKey: "agent:main",
          agentId: "main",
          ackStatus: "started",
          serverPhase: "agent-run-started",
          serverAckToPhaseMs: 12,
          serverReceivedToPhaseMs: 25,
          serverDispatchStartedToPhaseMs: 8,
          agentRunId: "agent-run-1",
        }),
      ]),
    );
  });

  it("warns when the first assistant reply paint is slow", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const runId = "run-slow-first-assistant";
    const host = makeHost({
      chatStream: "slow first token",
      eventLogBuffer: [],
    });
    const timingHost = host as ChatHost & {
      chatSendTimingsByRun: Map<
        string,
        {
          runId: string;
          submittedAtMs: number;
          requestStartedAtMs: number;
          ackAtMs: number;
          ackStatus: "started";
          sendAttempts: number;
          sendState: "sending";
          sessionKey: string;
          agentId: string;
        }
      >;
    };
    timingHost.chatSendTimingsByRun = new Map([
      [
        runId,
        {
          runId,
          submittedAtMs: performance.now() - 2_000,
          requestStartedAtMs: performance.now() - 1_900,
          ackAtMs: performance.now() - 1_800,
          ackStatus: "started",
          sendAttempts: 1,
          sendState: "sending",
          sessionKey: "agent:main",
          agentId: "main",
        },
      ],
    ]);

    recordFirstAssistantChatTiming(
      host,
      {
        agentId: "main",
        runId,
        sessionKey: "agent:main",
        state: "delta",
      },
      "delta",
    );

    await vi.waitFor(() =>
      expect(eventPayloads(host, "control-ui.chat.send")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "first-assistant-visible",
            runId,
            slow: true,
          }),
        ]),
      ),
    );
    expect(warn).toHaveBeenCalledWith(
      "[openclaw] control-ui.chat.send",
      expect.objectContaining({
        phase: "first-assistant-visible",
        runId,
        slow: true,
      }),
    );
  });

  it("records pending send paint timing before a delayed chat.send ACK", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const chatSend = createDeferred<{ status: "started" }>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return chatSend.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "measure painted pending send",
      eventLogBuffer: [],
    });

    const send = handleSendChat(host);

    await vi.waitFor(() =>
      expect(eventPayloads(host, "control-ui.chat.send").map((payload) => payload.phase)).toEqual(
        expect.arrayContaining(["pending-visible", "request-start", "pending-painted"]),
      ),
    );

    chatSend.resolve({ status: "started" });
    await send;

    const phasesAfterAck = eventPayloads(host, "control-ui.chat.send").map(
      (payload) => payload.phase,
    );
    expect(phasesAfterAck).toEqual(expect.arrayContaining(["ack"]));
  });

  it("waits for an in-flight model picker update before sending chat", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "use the newly selected model",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "use the newly selected model",
    });

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("use the newly selected model");
    expect(host.chatMessage).toBe("");
  });

  it("waits for every pending reasoning and speed patch before sending chat", async () => {
    const thinkingUpdate = createDeferred<unknown>();
    const fastModeUpdate = createDeferred<unknown>();
    const sessionsResult = createSessionsResult([
      row("agent:main", {
        effectiveFastMode: false,
        fastMode: false,
        thinkingLevel: "low",
      }),
    ]);
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "sessions.patch") {
        const patch = requireRecord(params, "session settings patch");
        if (Object.hasOwn(patch, "thinkingLevel")) {
          return thinkingUpdate.promise;
        }
        if (Object.hasOwn(patch, "fastMode")) {
          return fastModeUpdate.promise;
        }
      }
      if (method === "sessions.list") {
        return Promise.resolve(sessionsResult);
      }
      if (method === "chat.send") {
        return Promise.resolve({ status: "started" });
      }
      return Promise.reject(new Error(`Unexpected request: ${method}`));
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "use the new reasoning and speed",
      sessionsResult,
    });
    const settingsHost = host as unknown as Parameters<typeof switchChatThinkingLevel>[0];

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
    const fastModePatch = switchChatFastMode(settingsHost, "on");
    const send = handleSendChat(host);
    await Promise.resolve();

    expect(request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(2);
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "use the new reasoning and speed",
    });

    fastModeUpdate.resolve({});
    await fastModePatch;
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

    thinkingUpdate.resolve({});
    await Promise.all([thinkingPatch, send]);
    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload).toMatchObject({
      message: "use the new reasoning and speed",
      sessionKey: "agent:main",
    });
  });

  it("waits for a settings patch started in another split pane", async () => {
    const thinkingUpdate = createDeferred<unknown>();
    const sessionsResult = createSessionsResult([
      row("agent:work:main", {
        thinkingLevel: "low",
      }),
    ]);
    const request = vi.fn((method: string) => {
      if (method === "sessions.patch") {
        return thinkingUpdate.promise;
      }
      if (method === "sessions.list") {
        return Promise.resolve(sessionsResult);
      }
      if (method === "chat.send") {
        return Promise.resolve({ status: "started" });
      }
      return Promise.reject(new Error(`Unexpected request: ${method}`));
    });
    const client = { request } as unknown as ChatHost["client"];
    const agentsList = { defaultId: "main", mainKey: "home" };
    const settingsPane = makeHost({
      agentsList,
      client,
      sessionKey: "agent:work:main",
      sessionsResult,
    });
    const sendPane = makeHost({
      agentsList,
      client,
      chatMessage: "wait for the other pane",
      sessionKey: "agent:work:home",
      sessions: settingsPane.sessions,
      sessionsResult,
    });
    const settingsHost = settingsPane as unknown as Parameters<typeof switchChatThinkingLevel>[0];

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
    const send = handleSendChat(sendPane);

    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(sendPane.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "wait for the other pane",
    });

    thinkingUpdate.resolve({});
    await Promise.all([thinkingPatch, send]);

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(
      findRequestPayload(request as unknown as MockCallSource, "chat.send", "chat send payload"),
    ).toMatchObject({
      message: "wait for the other pane",
      sessionKey: "agent:work:home",
    });
  });

  it.each([
    { patchKey: "agent:main:main", sendKey: "agent:ops:work" },
    { patchKey: "agent:ops:work", sendKey: "agent:main:main" },
  ])("gates $sendKey on its default-main alias patch", async ({ patchKey, sendKey }) => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const agentsList = {
      defaultId: "ops",
      mainKey: "work",
      scope: "per-sender",
      agents: [{ id: "ops" }],
    };
    const settingsPane = makeHost({
      agentsList,
      pendingSettingsPatches: { [patchKey]: settingsPatch.promise },
      sessionKey: patchKey,
    });
    const sendPane = makeHost({
      agentsList,
      chatMessage: "wait for the legacy alias patch",
      client: { request } as unknown as ChatHost["client"],
      sessionKey: sendKey,
      sessions: settingsPane.sessions,
    });

    const send = handleSendChat(sendPane);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(request).not.toHaveBeenCalled();

    settingsPatch.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(sendPane.chatMessage).toBe("wait for the legacy alias patch");
  });

  it("keeps a real main agent patch separate from a non-main default agent", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const agentsList = {
      defaultId: "ops",
      mainKey: "work",
      scope: "per-sender",
      agents: [{ id: "ops" }, { id: "main" }],
    };
    const mainPane = makeHost({
      agentsList,
      pendingSettingsPatches: { "agent:main:main": settingsPatch.promise },
      sessionKey: "agent:main:main",
    });
    const sendPane = makeHost({
      agentsList,
      chatMessage: "send on the configured default agent",
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:ops:work",
      sessions: mainPane.sessions,
    });

    await handleSendChat(sendPane);

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    settingsPatch.resolve(false);
  });

  it("does not gate an agent main send on a distinct per-sender global patch", async () => {
    const globalPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      assistantAgentId: "work",
      chatMessage: "send to the agent main session",
      client: { request } as unknown as ChatHost["client"],
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "global",
            scope: "global",
          },
        },
      },
      pendingSettingsPatches: { global: globalPatch.promise },
      sessionKey: "agent:work:main",
    });

    expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("resolved");
    await send;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    globalPatch.resolve(false);
  });

  it("gates global-scope agent main aliases on the global patch", async () => {
    const globalPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
      assistantAgentId: "work",
      chatMessage: "wait for the global settings",
      client: { request } as unknown as ChatHost["client"],
      pendingSettingsPatches: { global: globalPatch.promise },
      sessionKey: "agent:work:main",
    });

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(request).not.toHaveBeenCalled();

    globalPatch.resolve(true);
    await send;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("parks a delayed global send after navigating to an agent main alias", async () => {
    const globalPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      assistantAgentId: "work",
      chatMessage: "keep this on global",
      client: { request } as unknown as ChatHost["client"],
      pendingSettingsPatches: { global: globalPatch.promise },
      sessionKey: "global",
    });

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    const queuedScopeKey = queueScopeKey(host, "global", "work");
    host.chatQueueByScope = { [queuedScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:work:main";

    globalPatch.resolve(true);
    await send;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueueByScope?.[queuedScopeKey]?.[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "keep this on global",
    });
  });

  it("keeps the draft unsent when a settings patch retires with its connection", async () => {
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessionsResult = createSessionsResult([
      row("agent:main", {
        thinkingLevel: "low",
      }),
    ]);
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatFollowLocked: true,
      chatMessage: "do not send after reconnect",
      chatNewMessagesBelow: true,
      chatToolMessages: [
        { role: "toolResult", toolCallId: "existing-tool", content: "keep this tool output" },
      ],
      chatUserNearBottom: false,
      sessionsResult,
    });
    vi.spyOn(host.sessions, "patch").mockResolvedValue(null);
    const settingsHost = host as unknown as Parameters<typeof switchChatThinkingLevel>[0];

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
    const send = handleSendChat(host);

    await expect(thinkingPatch).resolves.toBe(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatMessage).toBe("do not send after reconnect");
    expect(host.chatNewMessagesBelow).toBe(true);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatToolMessages).toEqual([
      { role: "toolResult", toolCallId: "existing-tool", content: "keep this tool output" },
    ]);
    expect(host.chatUserNearBottom).toBe(false);
    expect(host.sessionsResult?.sessions[0]?.thinkingLevel).toBe("low");
  });

  it("preserves draft edits made while waiting for a model picker update", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "keep typing";

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("send this");
    expect(host.chatMessage).toBe("keep typing");
  });

  it("preserves attachment payloads for edited drafts after a delayed send", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "delayed-att",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        sizeBytes: file.size,
      },
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      file,
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatAttachments: [attachment],
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "keep typing with the attachment";

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.message).toBe("send this");
    const attachments = payload.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.content).toBe("JVBERi0xLjQK");
    expect(attachments[0]?.fileName).toBe("brief.pdf");
    expect(attachments[0]?.mimeType).toBe("application/pdf");
    expect(attachments[0]?.type).toBe("file");
    expect(host.chatMessage).toBe("keep typing with the attachment");
    expect(host.chatAttachments).toStrictEqual([]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("preserves edited attachments when attachments change during a delayed send", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const originalFile = new File(["original"], "original.pdf", { type: "application/pdf" });
    const editedFile = new File(["edited"], "edited.pdf", { type: "application/pdf" });
    const originalAttachment = registerChatAttachmentPayload({
      attachment: {
        id: "original-att",
        mimeType: "application/pdf",
        fileName: "original.pdf",
        sizeBytes: originalFile.size,
      },
      dataUrl: "data:application/pdf;base64,b3JpZ2luYWw=",
      file: originalFile,
    });
    const editedAttachment = registerChatAttachmentPayload({
      attachment: {
        id: "edited-att",
        mimeType: "application/pdf",
        fileName: "edited.pdf",
        sizeBytes: editedFile.size,
      },
      dataUrl: "data:application/pdf;base64,ZWRpdGVk",
      file: editedFile,
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatAttachments: [originalAttachment],
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatAttachments = [editedAttachment];

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.message).toBe("send this");
    const attachments = payload.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.content).toBe("b3JpZ2luYWw=");
    expect(attachments[0]?.fileName).toBe("original.pdf");
    expect(attachments[0]?.mimeType).toBe("application/pdf");
    expect(attachments[0]?.type).toBe("file");
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([editedAttachment]);
    expect(getChatAttachmentDataUrl(originalAttachment)).toBeNull();
    expect(getChatAttachmentDataUrl(editedAttachment)).toBe("data:application/pdf;base64,ZWRpdGVk");
  });

  it("sends snapshotted attachment payloads when the composer removes them during a wait", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const file = new File(["original"], "original.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "removed-att",
        mimeType: "application/pdf",
        fileName: "original.pdf",
        sizeBytes: file.size,
      },
      dataUrl: "data:application/pdf;base64,b3JpZ2luYWw=",
      file,
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatAttachments: [attachment],
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatAttachments = [];
    releaseChatAttachmentPayloads([attachment]);

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.message).toBe("send this");
    const attachments = payload.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.content).toBe("b3JpZ2luYWw=");
    expect(attachments[0]?.fileName).toBe("original.pdf");
    expect(attachments[0]?.mimeType).toBe("application/pdf");
    expect(attachments[0]?.type).toBe("file");
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toStrictEqual([]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("does not cross-gate case-distinct opaque Matrix sessions", async () => {
    const otherSessionSwitch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:matrix:group:!room:Example",
      chatMessage: "send in other session",
      pendingSettingsPatches: {
        "agent:main:matrix:group:!Room:Example": otherSessionSwitch.promise,
      },
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:main:matrix:group:!room:Example");
    expect(payload.message).toBe("send in other session");
    otherSessionSwitch.resolve(false);
  });

  it("keeps the draft when a pending model picker update fails", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "do not send on rollback",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("do not send on rollback");
  });

  it("preserves every send when a shared picker patch fails", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "first blocked message",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const firstSend = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "second blocked message";
    const secondSend = handleSendChat(host);
    await Promise.resolve();

    switchUpdate.resolve(false);
    await Promise.all([firstSend, secondSend]);

    expect(request).not.toHaveBeenCalled();
    expect([host.chatMessage, ...host.chatQueue.map((item) => item.text)].toSorted()).toEqual([
      "first blocked message",
      "second blocked message",
    ]);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
    });
  });

  it("keeps blocked attachments retryable when the composer has new draft text", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const file = new File(["private"], "private.txt", { type: "text/plain" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "private-att",
        mimeType: "text/plain",
        fileName: "private.txt",
        sizeBytes: file.size,
      },
      dataUrl: "data:text/plain;base64,cHJpdmF0ZQ==",
      file,
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatAttachments: [attachment],
      chatMessage: "send this attachment",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "new unrelated draft";

    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("new unrelated draft");
    expect(host.chatAttachments).toStrictEqual([]);
    expect(host.chatQueue[0]).toMatchObject({
      attachments: [attachment],
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text: "send this attachment",
    });
    expect(getChatAttachmentDataUrl(attachment)).toBe("data:text/plain;base64,cHJpdmF0ZQ==");
  });

  it("does not restore a manually removed model-wait send after model update failure", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "remove this pending send",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    const queuedId = host.chatQueue[0]?.id;
    expect(queuedId).toEqual(expect.any(String));
    removeQueuedMessage(host, queuedId);

    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("keeps resolved model-wait sends queued under the submitted session after switching", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "send from session a",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue[0]?.text).toBe("send from session a");

    const queuedScopeKey = queueScopeKey(host, "agent:main");
    host.chatQueueByScope = { [queuedScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    host.chatMessage = "session b draft";
    switchUpdate.resolve(true);
    await send;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatMessage).toBe("session b draft");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatQueueByScope?.[queuedScopeKey]?.[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "send from session a",
    });
  });

  it("continues a resolved model-wait send in its submitted session after switching", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "offscreen model-wait send");
        return { runId: String(payload.idempotencyKey), status: "ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "send from session a after settings",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    const queuedScopeKey = queueScopeKey(host, "agent:main");
    host.chatQueueByScope = { [queuedScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    host.chatMessage = "session b draft";

    // Model the only settings event arriving before its follow-up refresh lets
    // the picker promise resolve. A waiting-model row cannot use that wakeup.
    await retryReconnectableQueuedChatSends(host);
    expect(request).not.toHaveBeenCalled();

    switchUpdate.resolve(true);
    await send;

    const sends = request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(1);
    expect(requireRecord(sends[0]?.[1], "offscreen model-wait payload")).toMatchObject({
      message: "send from session a after settings",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("session b draft");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatQueueByScope?.[queuedScopeKey]).toBeUndefined();
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps failed model-wait sends retryable under the submitted session after switching", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "send from session a",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    const queuedScopeKey = queueScopeKey(host, "agent:main");
    host.chatQueueByScope = { [queuedScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    host.chatMessage = "";

    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatQueueByScope?.[queuedScopeKey]?.[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text: "send from session a",
    });
  });

  it("does not flush model-wait sends before the model picker update finishes", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "wait for selected model",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      eventLogBuffer: [],
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "wait for selected model",
    });
    expect(eventPayloads(host, "control-ui.chat.send")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "waiting-model",
          sendState: "waiting-model",
        }),
      ]),
    );

    await retryReconnectableQueuedChatSends(host);
    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue[0]?.sendState).toBe("waiting-model");

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.message).toBe("wait for selected model");
  });

  it("waits for pending settings before retrying a failed queued send", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      if (method === "chat.send") {
        return { runId: "retry-run", status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "retry-send",
          text: "retry with new settings",
          createdAt: 1,
          sendError: "previous failure",
          sendRunId: "retry-run",
          sendState: "failed",
          sessionKey: "agent:main",
        },
      ],
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
    });

    const retry = retryQueuedChatMessage(host, "retry-send");

    expect(await raceWithMacrotask(retry)).toBe("pending");
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "agent:main" }),
    );
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "retry with new settings",
    });

    settingsPatch.resolve(true);
    await retry;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendState: "sending",
        text: "retry with new settings",
      }),
    ]);
  });

  it("keeps a queued retry failed when its pending settings patch fails", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "retry-send",
          text: "do not retry stale settings",
          createdAt: 1,
          sendError: "previous failure",
          sendRunId: "retry-run",
          sendState: "failed",
          sessionKey: "agent:main",
        },
      ],
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
    });

    const retry = retryQueuedChatMessage(host, "retry-send");
    expect(await raceWithMacrotask(retry)).toBe("pending");

    settingsPatch.resolve(false);
    await retry;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text: "do not retry stale settings",
    });
  });

  it("leaves a memory-only failed retry unchanged when durable admission fails", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "memory-only-retry",
      text: "preserve this failed send",
      createdAt: 1,
      sendError: "previous failure",
      sendRunId: "original-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      chatQueue: [original],
      client: { request } as unknown as ChatHost["client"],
    });

    await retryQueuedChatMessage(host, original.id);

    syncChatQueueFromStoredOutbox(host, {
      sessionKey: original.sessionKey,
      queue: [],
    });

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue).toStrictEqual([original]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("does not volatile-retry a durable unconfirmed row when storage reads fail", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn();
    const original = {
      id: "durable-unconfirmed-read-failure",
      text: "keep the durable claim",
      createdAt: 1,
      sendRunId: "durable-unconfirmed-run",
      sendState: "unconfirmed" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      chatQueue: [original],
      client: { request } as unknown as ChatHost["client"],
    });
    expect(admitQueuedMessageForSession(host, original.sessionKey, original)).toBe(true);
    const getItem = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    await retryQueuedChatMessage(host, original.id);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue).toStrictEqual([original]);
    getItem.mockRestore();
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([original]);
  });

  it("does not acquire volatile provenance after repeated durable retry read failures", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn();
    const original = {
      id: "durable-failed-repeat-read-failure",
      text: "never bypass the durable row",
      createdAt: 1,
      sendRunId: "durable-failed-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      chatQueue: [original],
      client: { request } as unknown as ChatHost["client"],
    });
    expect(admitQueuedMessageForSession(host, original.sessionKey, original)).toBe(true);
    const getItem = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    await retryQueuedChatMessage(host, original.id);
    await retryQueuedChatMessage(host, original.id);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue).toStrictEqual([original]);
    getItem.mockRestore();
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([original]);
  });

  it("drains a foreground retry after the in-flight send fails", async () => {
    const foregroundAck = createDeferred<{ runId: string; status: "error" }>();
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        return Promise.resolve(idleChatHistory());
      }
      if (method !== "chat.send") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const payload = requireRecord(params, "foreground retry send");
      return payload.message === "new foreground send"
        ? foregroundAck.promise
        : Promise.resolve({ runId: "retry-run", status: "started" });
    });
    const retryItem = {
      id: "retry-send",
      text: "retry after failure",
      createdAt: 1,
      sendError: "previous failure",
      sendRunId: "retry-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      chatMessage: "new foreground send",
      chatQueue: [retryItem],
      client: { request } as unknown as ChatHost["client"],
    });
    expect(admitQueuedMessageForSession(host, retryItem.sessionKey, retryItem)).toBe(true);

    const foreground = handleSendChat(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await retryQueuedChatMessage(host, "retry-send");

    expect(request).toHaveBeenCalledTimes(1);
    expect(host.chatQueue.find((item) => item.id === "retry-send")?.sendState).toBe("waiting-idle");

    foregroundAck.resolve({ runId: "foreground-run", status: "error" });
    await foreground;
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(2),
    );

    const retriedSend = request.mock.calls.filter(([method]) => method === "chat.send")[1];
    expect(requireRecord(retriedSend?.[1], "rescheduled retry").message).toBe(
      "retry after failure",
    );
    expect(host.chatQueue.find((item) => item.id === "retry-send")).toMatchObject({
      sendState: "sending",
      text: "retry after failure",
    });
  });

  it("waits for replay settings without blocking an independent session send", async () => {
    const settingsPatch = createDeferred<boolean>();
    const foregroundAck = createDeferred<{ runId: string; status: "started" }>();
    const sendPayloads: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      const payload = requireRecord(params, `${method} payload`);
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row(String(payload.sessionKey), {
            hasActiveRun: false,
            status: "done",
          }),
        });
      }
      if (method === "chat.send") {
        sendPayloads.push(payload);
        return payload.sessionKey === "agent:main"
          ? foregroundAck.promise
          : Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      pendingSettingsPatches: { "agent:other": settingsPatch.promise },
      sessionKey: "agent:main",
    });
    const replayScopeKey = queueScopeKey(host, "agent:other");
    host.chatQueueByScope = {
      [replayScopeKey]: [
        {
          id: "settings-gated-replay",
          text: "replay after settings",
          createdAt: 1,
          sendRunId: "settings-gated-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:other",
        },
      ],
    };
    admitHostQueueItems(host);

    const replay = retryReconnectableQueuedChatSends(host);
    expect(await raceWithMacrotask(replay)).toBe("pending");
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "agent:other" }),
    );
    expect(sendPayloads).toStrictEqual([]);

    host.chatMessage = "independent foreground send";
    const foreground = handleSendChat(host);
    await vi.waitFor(() => expect(sendPayloads).toHaveLength(1));
    expect(sendPayloads[0]?.sessionKey).toBe("agent:main");

    settingsPatch.resolve(true);
    await replay;
    expect(sendPayloads.map((payload) => payload.sessionKey)).toEqual([
      "agent:main",
      "agent:other",
    ]);

    foregroundAck.resolve({ runId: "foreground-run", status: "started" });
    await foreground;
  });

  it("keeps slash-command model changes in sync with the chat header cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch,
    );
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: "main",
          resolved: {
            modelProvider: "openai",
            model: "gpt-5-mini",
          },
        };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 0,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const refreshCurrentSessionTools = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
      refreshCurrentSessionTools,
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(host.sessions.state.modelOverrides.main).toBe("openai/gpt-5-mini");
    expect(refreshCurrentSessionTools).toHaveBeenCalledTimes(1);
  });

  it("queues local slash commands while the gateway client is unavailable", async () => {
    const host = makeHost({
      client: null,
      chatMessage: "/think",
      connected: true,
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        localCommandName: "think",
        sendState: "waiting-reconnect",
        text: "/think",
      }),
    ]);
  });

  it("shows local slash-command feedback when dispatch fails unexpectedly", async () => {
    executeSlashCommandMock.mockRejectedValue(new Error("dispatch failed"));
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/think",
      connected: true,
    });

    await handleSendChat(host);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(host.chatMessage).toBe("");
    expect(host.lastError).toBe("Error: dispatch failed");
    expect(host.chatMessages).toHaveLength(1);
    const feedback = requireRecord(host.chatMessages[0], "feedback message");
    expect(feedback.role).toBe("system");
    expect(feedback.content).toBe("Command `/think` failed unexpectedly.");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        localCommandName: "think",
        sendState: "failed",
        text: "/think",
      }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({ localCommandName: "think", sendState: "failed" }),
    ]);
  });

  it("sends /btw immediately while a main run is active without queueing it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/btw what changed?",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("/btw what changed?");
    expect(payload.deliver).toBe(false);
    const idempotencyKey = payload.idempotencyKey;
    expect(typeof idempotencyKey).toBe("string");
    expect(uuidPattern.test(idempotencyKey as string)).toBe(true);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/btw what changed?");
  });

  it("sends /approve immediately while a main run is waiting without queueing it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Waiting for approval...",
      chatMessage: "/approve approval-123 allow-once",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "approval command payload",
    );
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("/approve approval-123 allow-once");
    expect(payload.deliver).toBe(false);
    expect(payload.idempotencyKey).toEqual(expect.stringMatching(uuidPattern));
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Waiting for approval...");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/approve approval-123 allow-once");
  });

  it("sends /side through the detached BTW path", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/side what changed?",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.message).toBe("/side what changed?");
    expect(payload.deliver).toBe(false);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
  });

  it("sends /btw without adopting a main chat run when idle", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/btw summarize this",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.message).toBe("/btw summarize this");
    expect(payload.deliver).toBe(false);
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/btw summarize this");
  });

  it("keeps queued normal messages recallable before transcript history catches up", async () => {
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "queued while busy",
      chatRunId: "run-1",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("queued while busy");
    expect(host.chatQueue[0]?.sendState).toBe("waiting-idle");
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]?.sendState).toBe(
      "waiting-idle",
    );
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("queued while busy");
  });

  it("requires durable admission for offline input queued behind an active run", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const attachment = {
      id: "busy-offline-attachment",
      mimeType: "image/png",
      fileName: "offline.png",
      dataUrl: "data:image/png;base64,AAA",
    };
    const host = makeHost({
      chatAttachments: [attachment],
      chatMessage: "queue after the active run",
      chatRunId: "run-1",
      connected: false,
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("queue after the active run");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(getChatAttachmentDataUrl(host.chatAttachments[0]!)).toBe(attachment.dataUrl);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("keeps offline input behind an active run in the durable reconnect queue", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      chatMessage: "wait for the active run",
      chatRunId: "run-1",
      connected: false,
    });

    await handleSendChat(host);

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "wait for the active run",
      }),
    ]);
    expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({
        text: "wait for the active run",
      }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]?.sendState).toBe(
      "waiting-reconnect",
    );
    host.chatMessage = "do not overtake";
    await handleSendChat(host);

    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;
    host.chatRunId = null;
    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toHaveLength(2);
  });

  it("serializes same-session sends from split panes in durable FIFO order", async () => {
    const firstAck = createDeferred<unknown>();
    const sendPayloads: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method !== "chat.send") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const payload = requireRecord(params, "split-pane send payload");
      sendPayloads.push(payload);
      if (sendPayloads.length === 1) {
        return firstAck.promise;
      }
      return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
    });
    const client = { request } as unknown as ChatHost["client"];
    const firstHost = makeHost({ client });
    const secondHost = makeHost({ client });

    const firstSend = handleSendChat(firstHost, "first pane turn");
    await vi.waitFor(() => expect(sendPayloads).toHaveLength(1));
    const secondSend = handleSendChat(secondHost, "second pane turn");
    await Promise.resolve();

    expect(sendPayloads.map((payload) => payload.message)).toEqual(["first pane turn"]);
    firstAck.resolve({ runId: sendPayloads[0]?.idempotencyKey, status: "ok" });
    await Promise.all([firstSend, secondSend]);

    expect(sendPayloads.map((payload) => payload.message)).toEqual([
      "first pane turn",
      "second pane turn",
    ]);
    expect(listStoredChatOutboxes(firstHost)).toStrictEqual([]);
  });

  it("drains independent session outboxes without head-of-line blocking", async () => {
    const slowHistory = createDeferred<unknown>();
    const sentSessions: string[] = [];
    const request = vi.fn((method: string, params?: unknown) => {
      const payload = requireRecord(params, `${method} payload`);
      if (method === "chat.history") {
        if (payload.sessionKey === "agent:main:slow") {
          return slowHistory.promise;
        }
        return Promise.resolve({
          messages: [],
          sessionInfo: row(String(payload.sessionKey), {
            hasActiveRun: false,
            status: "done",
          }),
        });
      }
      if (method === "chat.send") {
        sentSessions.push(String(payload.sessionKey));
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const slowItem = {
      id: "slow-session-send",
      text: "slow session",
      createdAt: 1,
      sendRunId: "slow-session-run",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main:slow",
    };
    const readyItem = {
      id: "ready-session-send",
      text: "ready session",
      createdAt: 2,
      sendRunId: "ready-session-run",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main:ready",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:main:visible",
    });
    host.chatQueueByScope = {
      [queueScopeKey(host, slowItem.sessionKey)]: [slowItem],
      [queueScopeKey(host, readyItem.sessionKey)]: [readyItem],
    };
    expect(admitQueuedMessageForSession(host, slowItem.sessionKey, slowItem)).toBe(true);
    expect(admitQueuedMessageForSession(host, readyItem.sessionKey, readyItem)).toBe(true);

    const resume = retryReconnectableQueuedChatSends(host);

    await vi.waitFor(() => expect(sentSessions).toContain(readyItem.sessionKey));
    expect(sentSessions).not.toContain(slowItem.sessionKey);
    slowHistory.resolve({
      messages: [],
      sessionInfo: row(slowItem.sessionKey, { hasActiveRun: false, status: "done" }),
    });
    await resume;

    expect(sentSessions).toEqual([readyItem.sessionKey, slowItem.sessionKey]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps visible sending state owned by its scope while an inactive outbox finishes", async () => {
    const visibleAck = createDeferred<unknown>();
    const sentSessions: string[] = [];
    const visibleSessionKey = "agent:main:visible";
    const inactiveSessionKey = "agent:main:inactive";
    const request = vi.fn((method: string, params?: unknown) => {
      const payload = requireRecord(params, `${method} payload`);
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row(String(payload.sessionKey), {
            hasActiveRun: false,
            status: "done",
          }),
        });
      }
      if (method === "chat.send") {
        const sessionKey = String(payload.sessionKey);
        sentSessions.push(sessionKey);
        return sessionKey === visibleSessionKey
          ? visibleAck.promise
          : Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: visibleSessionKey,
    });

    const visibleSend = handleSendChat(host, "visible pending send");
    await vi.waitFor(() => expect(sentSessions).toContain(visibleSessionKey));
    expect(host.chatSending).toBe(true);

    const inactiveItem = {
      id: "inactive-send-finishes-first",
      text: "inactive send",
      createdAt: 2,
      sessionKey: inactiveSessionKey,
    };
    host.chatQueueByScope = {
      ...host.chatQueueByScope,
      [queueScopeKey(host, inactiveSessionKey)]: [inactiveItem],
    };
    expect(admitQueuedMessageForSession(host, inactiveSessionKey, inactiveItem)).toBe(true);
    const resume = retryReconnectableQueuedChatSends(host);

    await vi.waitFor(() => expect(sentSessions).toContain(inactiveSessionKey));
    expect(host.chatSending).toBe(true);

    const visibleRunId = host.chatQueue[0]?.sendRunId;
    visibleAck.resolve({ runId: visibleRunId, status: "ok" });
    await Promise.all([visibleSend, resume]);

    expect(host.chatSending).toBe(false);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps global outboxes for different agents isolated", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      const payload = requireRecord(params, `${method} payload`);
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row("global", { hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        sends.push(payload);
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      assistantAgentId: "main",
      agentsList: { defaultId: "main", mainKey: "main" },
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "global",
    });
    const mainItem = {
      id: "global-main-send",
      text: "send as main",
      createdAt: 1,
      sessionKey: "global",
      agentId: "main",
    };
    const workItem = {
      id: "global-work-send",
      text: "send as work",
      createdAt: 2,
      sessionKey: "global",
      agentId: "work",
    };
    host.chatQueue = [mainItem];
    host.chatQueueByScope = {
      [queueScopeKey(host, "global", "work")]: [workItem],
    };
    expect(admitQueuedMessageForSession(host, "global", mainItem)).toBe(true);
    expect(admitQueuedMessageForSession(host, "global", workItem)).toBe(true);

    await retryReconnectableQueuedChatSends(host);

    expect(sends).toHaveLength(2);
    expect(sends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: "main", message: "send as main" }),
        expect.objectContaining({ agentId: "work", message: "send as work" }),
      ]),
    );
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("reconciles a restored undefined-state command before destructive execution", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "restored-undefined-clear",
      text: "/clear",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "clear",
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [item],
    });
    // Seed the persisted pre-fix shape without creating fresh-admission provenance.
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: item.sessionKey }),
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(0);
    expect(host.chatQueue).toEqual([expect.objectContaining({ id: item.id })]);
  });

  it("reconciles a waiting-idle row after restart before its durable claim", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "restart-before-send-claim",
      text: "wait behind the server run",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "restart-before-send-claim-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [item],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: item.sessionKey }),
    );
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toEqual([expect.objectContaining({ id: item.id })]);
  });

  it("claims one stored local command once across split panes", async () => {
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as ChatHost["client"];
    const item = {
      id: "shared-local-command",
      text: "/think high",
      createdAt: 1,
      localCommandArgs: "high",
      localCommandName: "think",
      sessionKey: "agent:main",
    };
    const firstHost = makeHost({ client, chatQueue: [item] });
    const secondHost = makeHost({ client, chatQueue: [{ ...item }] });
    expect(admitQueuedMessageForSession(firstHost, firstHost.sessionKey, item)).toBe(true);

    await Promise.all([
      retryReconnectableQueuedChatSends(firstHost),
      retryReconnectableQueuedChatSends(secondHost),
    ]);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(listStoredChatOutboxes(firstHost)).toStrictEqual([]);
  });

  it("keeps the visible split pane as lane owner while consecutive local commands replay", async () => {
    const firstCommand = createDeferred<{ content: string }>();
    executeSlashCommandMock
      .mockImplementationOnce(() => firstCommand.promise)
      .mockResolvedValueOnce({ content: "Thinking level set." });
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory("agent:main:visible");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as ChatHost["client"];
    const sessionKey = "agent:main:visible";
    const items = [
      {
        id: "first-shared-local-command",
        text: "/think high",
        createdAt: 1,
        localCommandArgs: "high",
        localCommandName: "think",
        sessionKey,
      },
      {
        id: "second-shared-local-command",
        text: "/think low",
        createdAt: 2,
        localCommandArgs: "low",
        localCommandName: "think",
        sessionKey,
      },
    ];
    const visibleHost = makeHost({ client, chatQueue: items, sessionKey });
    const inactiveHost = makeHost({ client, chatQueue: [], sessionKey: "agent:main:inactive" });
    admitHostQueueItems(visibleHost);

    const visibleDrain = retryReconnectableQueuedChatSends(visibleHost);
    await vi.waitFor(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));
    const inactiveDrain = retryReconnectableQueuedChatSends(inactiveHost);
    firstCommand.resolve({ content: "Thinking level set." });
    await Promise.all([visibleDrain, inactiveDrain]);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(2);
    expect(listStoredChatOutboxes(visibleHost)).toStrictEqual([]);
  });

  it("projects a running local command to panes that subscribe after execution starts", async () => {
    const command = createDeferred<{ content: string }>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "slow-local-command",
      text: "/compact",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "compact",
      sessionKey: "agent:main",
    };
    const client = { request } as unknown as ChatHost["client"];
    const host = makeHost({
      client,
      chatQueue: [item],
    });
    const peer = makeHost({ client, chatQueue: [] });
    const stopHost = subscribeChatOutboxProjection(host);
    let stopPeer = () => {};
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);

    try {
      const draining = retryReconnectableQueuedChatSends(host);
      await vi.waitFor(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));
      stopPeer = subscribeChatOutboxProjection(peer);

      expect(host.chatQueue[0]?.sendState).toBe("executing-command");
      expect(peer.chatQueue[0]?.sendState).toBe("executing-command");
      expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]?.sendState).toBe(
        "unconfirmed",
      );
      await retryQueuedChatMessage(peer, item.id);
      expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);

      const peerItem = {
        id: "peer-durable-mutation",
        text: "do not disturb the running command",
        createdAt: 2,
        sessionKey: peer.sessionKey,
      };
      peer.chatQueue = [...peer.chatQueue, peerItem];
      expect(admitQueuedMessageForSession(peer, peer.sessionKey, peerItem)).toBe(true);
      expect(host.chatQueue[0]?.sendState).toBe("executing-command");
      expect(peer.chatQueue[0]?.sendState).toBe("executing-command");
      removeQueuedMessage(peer, peerItem.id);
      expect(host.chatQueue[0]?.sendState).toBe("executing-command");
      expect(peer.chatQueue[0]?.sendState).toBe("executing-command");

      command.resolve({ content: "Compaction complete." });
      await draining;

      expect(listStoredChatOutboxes(host)).toStrictEqual([]);
    } finally {
      stopPeer();
      stopHost();
    }
  });

  it("retires a queued local command without applying its late result after a route switch", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory("agent:main:first");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "route-switched-local-command",
      text: "/model gpt-5-mini",
      createdAt: 1,
      localCommandArgs: "gpt-5-mini",
      localCommandName: "model",
      sessionKey: "agent:main:first",
    };
    const refreshCurrentSessionTools = vi.fn(async () => undefined);
    const refreshCurrentChat = vi.fn(async () => undefined);
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      connectionEpoch: 1,
      chatQueue: [item],
      refreshCurrentChat,
      refreshCurrentSessionTools,
      sessionKey: item.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

    const draining = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));

    host.sessionKey = "agent:main:second";
    host.chatMessages = [{ role: "assistant", content: "Second session transcript" }];
    host.lastError = "Second session error";
    host.chatError = "Second session error";
    const secondSessionMessages = host.chatMessages;
    command.resolve({
      action: "refresh",
      content: "Model set to `gpt-5-mini`.",
      pendingCurrentRun: true,
      sessionPatch: {
        modelOverride: { kind: "qualified", value: "openai/gpt-5-mini" },
      },
      trackRunId: "stale-command-run",
    });
    await draining;

    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
    expect(host.chatMessages).toBe(secondSessionMessages);
    expect(host.chatRunId).toBeNull();
    expect(host.lastError).toBe("Second session error");
    expect(host.chatError).toBe("Second session error");
    expect(host.sessions.state.modelOverrides[item.sessionKey]).toBe("openai/gpt-5-mini");
    expect(refreshCurrentSessionTools).not.toHaveBeenCalled();
    expect(refreshCurrentChat).not.toHaveBeenCalled();
  });

  it("does not borrow a replacement connection error for a stale queued command", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const firstClient = {
      request: vi.fn(async (method: string) => {
        if (method === "chat.history") {
          return idleChatHistory("agent:main:first");
        }
        throw new Error(`Unexpected request: ${method}`);
      }),
    } as unknown as ChatHost["client"];
    const item = {
      id: "reconnected-local-command",
      text: "/model unavailable",
      createdAt: 1,
      localCommandArgs: "unavailable",
      localCommandName: "model",
      sessionKey: "agent:main:first",
    };
    const host = makeHost({
      client: firstClient,
      connectionEpoch: 1,
      chatQueue: [item],
      sessionKey: item.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

    const draining = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));

    host.client = {
      request: vi.fn(async (method: string) => {
        throw new Error(`Unexpected replacement request: ${method}`);
      }),
    } as unknown as ChatHost["client"];
    host.connectionEpoch = 2;
    host.lastError = "Replacement connection error";
    host.chatError = "Replacement connection error";
    command.resolve({ content: "Old connection command failed.", failed: true });
    await draining;

    expect(host.lastError).toBe("Replacement connection error");
    expect(host.chatError).toBe("Replacement connection error");
    expect(loadChatComposerSnapshot(host, item.sessionKey)?.queue).toEqual([
      expect.objectContaining({
        id: item.id,
        sendError: "Command /model failed.",
        sendState: "failed",
      }),
    ]);
  });

  it("retires a durable accepted send when its terminal run event arrives", () => {
    const item = {
      id: "terminal-delivery",
      text: "already accepted",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "terminal-delivery-run",
      sendState: "sending" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({ chatQueue: [item] });
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);

    expect(removeDeliveredQueuedChatSendForRun(host, item.sendRunId)).toMatchObject({
      id: item.id,
    });

    expect(host.chatQueue).toStrictEqual([]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("retires a durable accepted send from a replacement pane without a local projection", () => {
    const item = {
      id: "terminal-delivery-from-closed-pane",
      text: "accepted before the pane closed",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "terminal-delivery-from-closed-pane-run",
      sendState: "sending" as const,
      sessionKey: "agent:main:closed-pane",
    };
    const sender = makeHost({ chatQueue: [item], sessionKey: item.sessionKey });
    const replacement = makeHost({ chatQueue: [], sessionKey: "agent:main:replacement" });
    expect(admitQueuedMessageForSession(sender, item.sessionKey, item)).toBe(true);

    expect(removeDeliveredQueuedChatSendForRun(replacement, item.sendRunId)).toMatchObject({
      id: item.id,
    });

    expect(replacement.chatQueue).toStrictEqual([]);
    expect(listStoredChatOutboxes(replacement)).toStrictEqual([]);
  });

  it("preserves terminal user-turn ordering when an inactive split pane handles the event first", () => {
    const item = {
      id: "split-terminal-delivery",
      text: "prompt from the visible pane",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "split-terminal-delivery-run",
      sendState: "sending" as const,
      sessionKey: "agent:main:visible",
    };
    const client = { request: vi.fn() } as unknown as ChatHost["client"];
    const visible = makeHost({
      chatQueue: [item],
      chatRunId: item.sendRunId,
      client,
      sessionKey: item.sessionKey,
    });
    const inactive = makeHost({
      chatQueue: [],
      client,
      sessionKey: "agent:main:inactive",
    });
    for (const host of [visible, inactive]) {
      Object.assign(host, {
        chatMessagesBySession: new Map<string, unknown[]>(),
        connectionEpoch: 1,
        pendingSessionMessageReloadSessionKey: null,
        requestUpdate: vi.fn(),
      });
    }
    expect(admitQueuedMessageForSession(visible, item.sessionKey, item)).toBe(true);
    const event = {
      event: "chat",
      payload: {
        state: "final",
        runId: item.sendRunId,
        sessionKey: item.sessionKey,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "terminal reply" }],
          timestamp: 2,
        },
      },
    } as Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(inactive as unknown as ChatPageHost, event);
    handlePageGatewayEvent(visible as unknown as ChatPageHost, event);
    handlePageGatewayEvent(inactive as unknown as ChatPageHost, event);

    expect(
      visible.chatMessages.map((message) => requireRecord(message, "terminal transcript").role),
    ).toEqual(["user", "assistant"]);
    const inactiveCached = readChatMessagesFromCache(
      inactive.chatMessagesBySession ?? new Map(),
      inactive,
      { sessionKey: item.sessionKey },
    );
    expect(
      inactiveCached
        .slice(0, 2)
        .map((message) => requireRecord(message, "inactive terminal transcript").role),
    ).toEqual(["user", "assistant"]);
    expect(
      inactiveCached.filter((message) => {
        const marker = requireRecord(message, "cached terminal transcript")["__openclaw"];
        return (
          marker &&
          typeof marker === "object" &&
          requireRecord(marker, "cached terminal marker").idempotencyKey ===
            `${item.sendRunId}:user`
        );
      }),
    ).toHaveLength(1);
    expect(listStoredChatOutboxes(visible)).toStrictEqual([]);
  });

  it("pins terminal attachment turns to durable data across split panes", () => {
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:terminal-attachment");
        static override revokeObjectURL = revokeObjectUrl;
      },
    );
    const dataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "terminal-attachment",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        sizeBytes: file.size,
      },
      dataUrl,
      file,
    });
    const item = {
      id: "split-terminal-attachment-delivery",
      text: "summarize",
      attachments: [attachment],
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "split-terminal-attachment-delivery-run",
      sendState: "sending" as const,
      sessionKey: "agent:main:visible",
    };
    const client = { request: vi.fn() } as unknown as ChatHost["client"];
    const visible = makeHost({
      chatQueue: [item],
      chatRunId: item.sendRunId,
      client,
      sessionKey: item.sessionKey,
    });
    const inactive = makeHost({
      chatQueue: [],
      client,
      sessionKey: "agent:main:inactive",
    });
    for (const host of [visible, inactive]) {
      Object.assign(host, {
        chatMessagesBySession: new Map<string, unknown[]>(),
        connectionEpoch: 1,
        pendingSessionMessageReloadSessionKey: null,
        requestUpdate: vi.fn(),
      });
    }
    expect(admitQueuedMessageForSession(visible, item.sessionKey, item)).toBe(true);
    const event = {
      event: "chat",
      payload: {
        state: "final",
        runId: item.sendRunId,
        sessionKey: item.sessionKey,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "terminal reply" }],
          timestamp: 2,
        },
      },
    } as Parameters<typeof handlePageGatewayEvent>[1];

    handlePageGatewayEvent(inactive as unknown as ChatPageHost, event);
    handlePageGatewayEvent(visible as unknown as ChatPageHost, event);

    const visibleUser = requireRecord(visible.chatMessages[0], "visible terminal user turn");
    const visibleContent = visibleUser.content as Array<Record<string, unknown>>;
    expect(requireRecord(visibleContent[1]?.attachment, "visible terminal attachment").url).toBe(
      dataUrl,
    );
    const inactiveCached = readChatMessagesFromCache(
      inactive.chatMessagesBySession ?? new Map(),
      inactive,
      { sessionKey: item.sessionKey },
    );
    const inactiveUser = requireRecord(inactiveCached[0], "inactive terminal user turn");
    const inactiveContent = inactiveUser.content as Array<Record<string, unknown>>;
    expect(requireRecord(inactiveContent[1]?.attachment, "inactive terminal attachment").url).toBe(
      dataUrl,
    );
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:terminal-attachment");
    expect(listStoredChatOutboxes(visible)).toStrictEqual([]);
  });

  it("drains a queued reset without awaiting its own active outbox lane", async () => {
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const sendPayloads: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        return Promise.resolve(idleChatHistory());
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "queued reset send payload");
        sendPayloads.push(payload);
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const items = [
      {
        id: "queued-think-before-reset",
        text: "/think high",
        createdAt: 1,
        localCommandArgs: "high",
        localCommandName: "think",
        sessionKey: "agent:main",
      },
      {
        id: "queued-reset-after-think",
        text: "/reset",
        createdAt: 2,
        localCommandArgs: "",
        localCommandName: "reset",
        sessionKey: "agent:main",
      },
      {
        id: "queued-prompt-after-reset",
        text: "run only after reset",
        createdAt: 3,
        sessionKey: "agent:main",
      },
    ];
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: items,
    });
    admitHostQueueItems(host);

    const completed = await Promise.race([
      retryReconnectableQueuedChatSends(host).then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);

    expect(completed).toBe(true);
    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(sendPayloads.map((payload) => payload.message)).toEqual([
      "/reset",
      "run only after reset",
    ]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("sends an offline queued reset when history has untagged messages", async () => {
    const sendPayloads: Array<Record<string, unknown>> = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [{ role: "assistant", content: "older reply" }],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "offline queued reset payload");
        sendPayloads.push(payload);
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "offline-reset-with-history",
      text: "/reset",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "reset",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [item],
    });
    expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

    await retryReconnectableQueuedChatSends(host);

    expect(sendPayloads).toHaveLength(1);
    expect(sendPayloads[0]?.message).toBe("/reset");
    expect(sendPayloads[0]?.idempotencyKey).toEqual(expect.stringMatching(uuidPattern));
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("does not execute a stored local command when its durable claim fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const write = storage.setItem.bind(storage);
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "local-command-claim-failure",
      text: "/think high",
      createdAt: 1,
      localCommandArgs: "high",
      localCommandName: "think",
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [item],
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);
    let failedClaims = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (value.includes(item.id) && value.includes('"unconfirmed"') && failedClaims === 0) {
        failedClaims += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });

    await retryReconnectableQueuedChatSends(host);

    expect(failedClaims).toBe(1);
    expect(executeSlashCommandMock).not.toHaveBeenCalled();
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
  });

  it("keeps a failed stored local command retryable after a transient disconnect", async () => {
    const events: string[] = [];
    executeSlashCommandMock
      .mockImplementationOnce(async () => {
        events.push("think-failed");
        return {
          content: "Failed to set thinking level: gateway closed during command",
          failed: true,
        };
      })
      .mockImplementationOnce(async () => {
        events.push("think-retried");
        return { content: "Thinking level set." };
      });
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      if (method === "chat.send") {
        events.push("following-prompt");
        return { status: "ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "retry-local-command-after-disconnect",
      text: "/think high",
      createdAt: 1,
      localCommandArgs: "high",
      localCommandName: "think",
      sessionKey: "agent:main",
    };
    const following = {
      id: "prompt-after-retried-command",
      text: "use the new thinking level",
      createdAt: 2,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [item, following],
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);
    expect(admitQueuedMessageForSession(host, host.sessionKey, following)).toBe(true);

    await retryReconnectableQueuedChatSends(host);

    expect(host.chatQueue[0]).toMatchObject({
      id: item.id,
      sendState: "failed",
    });
    expect(listStoredChatOutboxes(host)[0]?.queue.map((entry) => entry.id)).toEqual([
      item.id,
      following.id,
    ]);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendState).toBe("failed");

    await retryReconnectableQueuedChatSends(host);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["think-failed"]);

    await retryQueuedChatMessage(host, item.id);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["think-failed", "think-retried", "following-prompt"]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("retires a rejected clear, drops its optimistic history, and parks its successor", async () => {
    const sentMessages: string[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.reset") {
        throw new Error("post-commit lifecycle failed");
      }
      if (method === "chat.history") {
        return idleChatHistory();
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "successor send payload");
        sentMessages.push(String(payload.message));
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const clear = {
      id: "uncertain-clear",
      text: "/clear",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "clear",
      sessionKey: "agent:main",
    };
    const successor = {
      id: "prompt-after-uncertain-clear",
      text: "send only after review",
      createdAt: 2,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessages: [{ role: "user", content: "possibly cleared" }],
      chatQueue: [clear, successor],
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, clear)).toBe(true);
    expect(admitQueuedMessageForSession(host, host.sessionKey, successor)).toBe(true);

    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(1);
    expect(sentMessages).toEqual([]);
    expect(host.chatMessages).toEqual([]);
    expect(host.chatQueue.map((item) => item.id)).toEqual([successor.id]);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      id: successor.id,
      sendState: "unconfirmed",
    });
    expect(host.chatQueue[0]?.sendError).toContain("preceding /clear may have completed");

    await retryReconnectableQueuedChatSends(host);
    await retryQueuedChatMessage(host, clear.id);

    expect(request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(1);
    expect(sentMessages).toEqual([]);

    await retryQueuedChatMessage(host, successor.id);

    expect(sentMessages).toEqual([successor.text]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("fails closed when history refresh rejects after an uncertain clear", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        throw new Error("post-commit lifecycle failed");
      }
      if (method === "chat.history") {
        throw new Error("history unavailable");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "possibly cleared" }],
    });

    await handleSendChat(host);

    expect(host.chatMessages).toEqual([]);
    expect(host.lastError).toContain("clear request may have completed");
    expect(host.lastError).toContain("could not be refreshed");
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps the uncertain clear as a durable barrier when parking its successor fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const write = storage.setItem.bind(storage);
    let resetIssued = false;
    let failedBarrierWrites = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        resetIssued = true;
        throw new Error("post-commit lifecycle failed");
      }
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const clear = {
      id: "uncertain-clear-storage-barrier",
      text: "/clear",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "clear",
      sessionKey: "agent:main",
    };
    const successor = {
      id: "successor-storage-barrier",
      text: "must stay parked",
      createdAt: 2,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [clear, successor],
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, clear)).toBe(true);
    expect(admitQueuedMessageForSession(host, host.sessionKey, successor)).toBe(true);
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      const successorIndex = value.indexOf(`"id":"${successor.id}"`);
      const successorRecord =
        successorIndex >= 0 ? value.slice(successorIndex, successorIndex + 500) : "";
      if (
        resetIssued &&
        failedBarrierWrites === 0 &&
        successorRecord.includes('"sendState":"unconfirmed"')
      ) {
        failedBarrierWrites += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });

    await retryReconnectableQueuedChatSends(host);

    expect(failedBarrierWrites).toBe(1);
    expect(request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
      expect.objectContaining({ id: clear.id, sendState: "unconfirmed" }),
      expect.objectContaining({ id: successor.id }),
    ]);

    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(1);
  });

  it("does not resurrect a send deleted by another pane before its ACK", async () => {
    const ack = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return ack.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as ChatHost["client"];
    const sendingHost = makeHost({ client });
    const staleHost = makeHost({ client });
    const send = handleSendChat(sendingHost, "delete before ack");
    await vi.waitFor(() => expect(sendingHost.chatQueue[0]?.sendState).toBe("sending"));
    const id = sendingHost.chatQueue[0]?.id ?? "missing";
    const runId = sendingHost.chatQueue[0]?.sendRunId;
    staleHost.chatQueue = loadChatComposerSnapshot(staleHost, staleHost.sessionKey)?.queue ?? [];

    removeQueuedMessage(staleHost, id);
    ack.resolve({ runId, status: "started" });
    await send;

    expect(listStoredChatOutboxes(sendingHost)).toStrictEqual([]);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("removes a durable item from its located session after the visible route switches", () => {
    const queuedSessionKey = "agent:main:queued-before-switch";
    const item = {
      id: "remove-after-route-switch",
      text: "cancel from the original session",
      createdAt: 1,
      sessionKey: queuedSessionKey,
    };
    const host = makeHost({ sessionKey: "agent:main:new-route" });
    const queuedScopeKey = queueScopeKey(host, queuedSessionKey);
    host.chatQueueByScope = { [queuedScopeKey]: [item] };
    expect(admitQueuedMessageForSession(host, queuedSessionKey, item)).toBe(true);

    expect(
      removeVisibleOrScopedQueuedMessageWithoutReleasing(host, item.id, queuedSessionKey),
    ).toMatchObject({ id: item.id });

    expect(host.chatQueueByScope?.[queuedScopeKey]).toBeUndefined();
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("does not publish an outbox projection across gateways", () => {
    const source = makeHost({
      settings: { gatewayUrl: "ws://gateway-a.test/control" },
    });
    const otherGateway = makeHost({
      settings: { gatewayUrl: "ws://gateway-b.test/control" },
    });
    const stopSource = subscribeChatOutboxProjection(source);
    const stopOther = subscribeChatOutboxProjection(otherGateway);
    const item = {
      id: "gateway-a-only",
      text: "stay on gateway a",
      createdAt: 1,
      sessionKey: source.sessionKey,
    };
    source.chatQueue = [item];
    try {
      expect(admitQueuedMessageForSession(source, source.sessionKey, item)).toBe(true);
      expect(otherGateway.chatQueue).toStrictEqual([]);
    } finally {
      stopOther();
      stopSource();
    }
  });

  it("clears an inactive pane cache when another pane removes its durable item", () => {
    const sessionKey = "agent:main:cached-session";
    const item = {
      id: "cached-item-removed-elsewhere",
      text: "do not resurrect me",
      createdAt: 1,
      sessionKey,
    };
    const source = makeHost({ chatQueue: [item], sessionKey });
    const cachedPane = makeHost({ sessionKey: "agent:main:other-session" });
    const cachedScopeKey = queueScopeKey(cachedPane, sessionKey);
    cachedPane.chatQueueByScope = { [cachedScopeKey]: [{ ...item }] };
    const stopSource = subscribeChatOutboxProjection(source);
    const stopCachedPane = subscribeChatOutboxProjection(cachedPane);
    try {
      expect(admitQueuedMessageForSession(source, sessionKey, item)).toBe(true);

      removeQueuedMessage(source, item.id);

      expect(cachedPane.chatQueueByScope?.[cachedScopeKey]).toBeUndefined();
      cachedPane.sessionKey = sessionKey;
      cachedPane.chatQueue = cachedPane.chatQueueByScope?.[cachedScopeKey] ?? [];
      expect(cachedPane.chatQueue).toStrictEqual([]);
    } finally {
      stopCachedPane();
      stopSource();
    }
  });

  it("clears a failed row in another pane when its durable item is removed", async () => {
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "failed-item-removed-elsewhere",
      text: "do not retry after another pane cancels",
      createdAt: 1,
      sendError: "previous failure",
      sendRunId: "failed-item-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const source = makeHost({ chatQueue: [item], sessionKey: item.sessionKey });
    const peer = makeHost({
      chatQueue: [{ ...item }],
      client: { request } as unknown as ChatHost["client"],
      sessionKey: item.sessionKey,
    });
    const stopSource = subscribeChatOutboxProjection(source);
    const stopPeer = subscribeChatOutboxProjection(peer);
    try {
      expect(admitQueuedMessageForSession(source, item.sessionKey, item)).toBe(true);

      removeQueuedMessage(source, item.id);

      expect(peer.chatQueue).toStrictEqual([]);
      await retryQueuedChatMessage(peer, item.id);
      expect(request).not.toHaveBeenCalled();
      expect(listStoredChatOutboxes(peer)).toStrictEqual([]);
    } finally {
      stopPeer();
      stopSource();
    }
  });

  it("coalesces duplicate in-flight chat submits before the gateway acknowledges them", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
    });

    const first = handleSendChat(host, "same prompt");
    const second = handleSendChat(host, "same prompt");

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("same prompt");
    expect(host.chatQueue[0]?.sendState).toBe("sending");
    expect(host.chatMessages).toStrictEqual([]);

    const queuedRunId = host.chatQueue[0]?.sendRunId;
    sent.resolve({ runId: queuedRunId, status: "started" });
    await Promise.all([first, second]);

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendState: "sending", text: "same prompt" }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" }),
    ]);
    expect(host.chatMessages).toStrictEqual([]);
  });

  it("keeps normal prompt text visible as pending until chat.send is acknowledged", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "do not lose this",
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    expect(host.chatMessage).toBe("");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "do not lose this",
      sendState: "sending",
      sessionKey: "agent:main",
    });
    const runId = host.chatQueue[0]?.sendRunId;
    expect(typeof runId).toBe("string");

    sent.resolve({ runId, status: "started" });
    await send;

    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendState: "sending", text: "do not lose this" }),
    ]);
    expect(host.chatRunId).toBe(runId);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" }),
    ]);
    expect(host.chatMessages).toStrictEqual([]);
  });

  it("projects an in-flight normal send to panes that subscribe after transport starts", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve(idleChatHistory());
      }
      if (method === "chat.send") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as ChatHost["client"];
    const item = {
      id: "late-pane-live-send",
      text: "keep late panes read-only",
      createdAt: 1,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client,
      chatQueue: [item],
    });
    const stalePeer = makeHost({ client, chatQueue: [{ ...item }] });
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);

    const send = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1),
    );
    const runId = host.chatQueue[0]?.sendRunId;
    expect(runId).toMatch(uuidPattern);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]?.sendState).toBe(
      "waiting-reconnect",
    );

    const latePeer = makeHost({ client, chatQueue: [] });
    const stopLatePeer = subscribeChatOutboxProjection(latePeer);
    try {
      expect(latePeer.chatQueue).toEqual([
        expect.objectContaining({
          id: item.id,
          sendRunId: runId,
          sendState: "sending",
        }),
      ]);
      await retryQueuedChatMessage(latePeer, item.id);
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);

      removeQueuedMessage(stalePeer, item.id);
      expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
      expect(stalePeer.chatQueue[0]?.sendState).toBe("sending");
      expect(latePeer.chatQueue[0]?.sendState).toBe("sending");

      sent.resolve({ runId, status: "started" });
      await send;
      expect(latePeer.chatQueue[0]?.sendState).toBe("sending");

      expect(removeDeliveredQueuedChatSendForRun(host, runId)).toMatchObject({ id: item.id });
      expect(latePeer.chatQueue).toStrictEqual([]);
    } finally {
      stopLatePeer();
    }
  });

  it("escapes reply sender labels and clears reply state after chat.send is acknowledged", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "continue",
      chatReplyTarget: {
        messageId: "reply-source-1",
        text: "quoted body",
        senderLabel: "A *B* [C]",
      },
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    expect(host.chatReplyTarget?.messageId).toBe("reply-source-1");
    expect(host.chatQueue[0]?.text).toBe("> **A \\*B\\* \\[C\\]:** quoted body\n\ncontinue");

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await send;

    expect(host.chatReplyTarget).toBeNull();
  });

  it("keeps reply state when chat.send fails before acceptance", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return Promise.resolve({ runId: "run-failed", status: "error" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "retry this",
      chatReplyTarget: {
        messageId: "reply-source-2",
        text: "quoted body",
        senderLabel: "User",
      },
    });

    await handleSendChat(host);

    expect(host.chatReplyTarget?.messageId).toBe("reply-source-2");
    expect(host.chatMessage).toBe("retry this");
  });

  it("routes queued Skill Workshop revisions through the proposal request RPC", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "skills.proposals.requestRevision") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "keep my draft",
    });
    (host as ChatHost & { currentSessionId?: string }).currentSessionId = "session-current";

    const send = handleSendChat(host, "Make the support files 5", {
      restoreDraft: true,
      skillWorkshopRevision: {
        proposalId: "support-file-sampler-20260531-68207b7b7f",
        agentId: "proposal-owner",
      },
    });
    await Promise.resolve();

    expect(host.chatQueue[0]).toMatchObject({
      text: "Make the support files 5",
      skillWorkshopRevision: {
        proposalId: "support-file-sampler-20260531-68207b7b7f",
        agentId: "proposal-owner",
      },
    });
    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "skills.proposals.requestRevision",
      "revision request payload",
    );
    expect(payload).toMatchObject({
      agentId: "proposal-owner",
      proposalId: "support-file-sampler-20260531-68207b7b7f",
      instructions: "Make the support files 5",
      sessionKey: "agent:main",
      sessionId: "session-current",
    });
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("targetAgentId");

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await send;

    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendState: "sending", text: "Make the support files 5" }),
    ]);
    expect(host.chatMessages).toStrictEqual([]);
  });

  it("treats slash-like Skill Workshop revision drafts as revision instructions", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "skills.proposals.requestRevision") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
    });

    const send = handleSendChat(host, "/reset examples", {
      restoreDraft: true,
      skillWorkshopRevision: {
        proposalId: "support-file-sampler-20260531-68207b7b7f",
      },
    });
    await Promise.resolve();

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "skills.proposals.requestRevision",
      "revision slash payload",
    );
    expect(payload).toMatchObject({
      proposalId: "support-file-sampler-20260531-68207b7b7f",
      instructions: "/reset examples",
      sessionKey: "agent:main",
    });
    expect(payload).not.toHaveProperty("message");
    expect(host.chatQueue[0]).toMatchObject({
      refreshSessions: false,
      text: "/reset examples",
      skillWorkshopRevision: {
        proposalId: "support-file-sampler-20260531-68207b7b7f",
      },
    });

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await send;

    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendState: "sending", text: "/reset examples" }),
    ]);
    expect(host.chatMessages).toStrictEqual([]);
  });

  it("keeps delayed chat.send ACK effects scoped to the submitted session", async () => {
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "stay with session A",
      sessionKey: "agent:a",
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    const queuedRunId = host.chatQueue[0]?.sendRunId;
    expect(queuedRunId).toEqual(expect.any(String));

    const submittedScopeKey = queueScopeKey(host, "agent:a");
    host.chatQueueByScope = { [submittedScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:b";
    host.chatMessages = [];
    host.chatRunId = null;
    host.chatStream = null;

    sent.resolve({ runId: queuedRunId, status: "started" });
    await send;

    expect(host.sessionKey).toBe("agent:b");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatQueueByScope?.[submittedScopeKey]).toEqual([
      expect.objectContaining({ sendState: "sending", text: "stay with session A" }),
    ]);
  });

  it("keeps a pre-ack socket close recoverable with the same run id", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        throw new Error("gateway closed (1006): network lost");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "retry after reconnect",
    });

    await handleSendChat(host);

    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatQueue).toHaveLength(1);
    const queued = host.chatQueue[0];
    expect(queued?.text).toBe("retry after reconnect");
    expect(queued?.sendState).toBe("waiting-reconnect");
    expect(queued?.sendRunId).toEqual(expect.any(String));
    expect(host.lastError).toBe("Message will send when the Gateway reconnects.");
  });

  it("retains an ambiguous pre-ack send id when browser storage rejects recovery", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let rejectWrites = false;
    const setItemSpy = vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    let attemptedRunId: unknown;
    let sendAttempts = 0;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.send") {
        const payload = requireRecord(params, "chat send payload");
        attemptedRunId ??= payload.idempotencyKey;
        sendAttempts += 1;
        if (sendAttempts === 1) {
          rejectWrites = true;
          throw new Error("gateway closed (1006): network lost");
        }
        return { runId: payload.idempotencyKey, status: "started" };
      }
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const replyTarget = {
      messageId: "reply-before-ack",
      text: "quoted body",
      senderLabel: "User",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "retry after reconnect",
      chatReplyTarget: replyTarget,
    });

    await handleSendChat(host);

    expect(attemptedRunId).toEqual(expect.stringMatching(uuidPattern));
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendAttempts: 1,
        text: "> **User:** quoted body\n\nretry after reconnect",
        sendRunId: attemptedRunId,
        sendState: "waiting-reconnect",
      }),
    ]);
    expect(host.chatReplyTarget).toBeNull();
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );

    await retryReconnectableQueuedChatSends(host);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);

    rejectWrites = false;
    setItemSpy.mockRestore();
    await retryQueuedChatMessage(host, host.chatQueue[0]?.id ?? "missing");

    const sendPayloads = request.mock.calls
      .filter(([method]) => method === "chat.send")
      .map((call) => requireRecord(call[1], "manual retry payload"));
    expect(sendPayloads).toHaveLength(2);
    expect(sendPayloads[1]?.idempotencyKey).toBe(attemptedRunId);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendRunId: attemptedRunId, sendState: "sending" }),
    ]);
  });

  it("restores input when a volatile send fails before transport", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        throw new Error("gateway not connected");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "safe to restore",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("safe to restore");
    expect(host.chatQueue).toStrictEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends a connected attachment when browser quota rejects durable admission", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.send") {
        const payload = requireRecord(params, "volatile connected send payload");
        return { runId: payload.idempotencyKey, status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const attachment = {
      id: "large-connected-attachment",
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
      fileName: "large.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20 * 1024 * 1024,
    };
    const host = makeHost({
      chatAttachments: [attachment],
      chatMessage: "send the large file",
      client: { request } as unknown as ChatHost["client"],
    });

    await handleSendChat(host);

    const sends = request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(1);
    const sendPayload = requireRecord(sends[0]?.[1], "volatile connected send payload");
    expect(sendPayload).toMatchObject({
      attachments: [
        {
          content: "JVBERi0xLjQ=",
          fileName: "large.pdf",
          mimeType: "application/pdf",
        },
      ],
      message: "send the large file",
    });
    expect(host.chatAttachments).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toEqual(expect.any(String));
    expect(sendPayload.idempotencyKey).toBe(host.chatRunId);
    expect(host.lastError).toBeNull();
    expect(
      host.chatMessages.map((message) => requireRecord(message, "volatile transcript").role),
    ).toEqual(["user"]);
    markQueuedChatSendsWaitingForReconnect(host);
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("retries an unconfirmed volatile send with the same run id", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const runIds: unknown[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "chat.send") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const payload = requireRecord(params, "volatile retry payload");
      runIds.push(payload.idempotencyKey);
      if (runIds.length === 1) {
        throw new Error("gateway closed (1006): network lost");
      }
      return { runId: payload.idempotencyKey, status: "started" };
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "retry the oversized turn",
    });

    await handleSendChat(host);

    const itemId = host.chatQueue[0]?.id ?? "missing-volatile-retry";
    const originalRunId = host.chatQueue[0]?.sendRunId;
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendRunId: originalRunId, sendState: "unconfirmed" }),
    ]);

    await retryReconnectableQueuedChatSends(host);
    expect(runIds).toEqual([originalRunId]);

    await retryQueuedChatMessage(host, itemId);

    expect(runIds).toEqual([originalRunId, originalRunId]);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe(originalRunId);
    expect(
      host.chatMessages.map((message) => requireRecord(message, "retried transcript").role),
    ).toEqual(["user"]);
  });

  it("retries a failed volatile send with a fresh run id", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const firstAttempt = createDeferred<unknown>();
    const runIds: unknown[] = [];
    const request = vi.fn((method: string, params?: unknown) => {
      if (method !== "chat.send") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const payload = requireRecord(params, "failed volatile retry payload");
      runIds.push(payload.idempotencyKey);
      return runIds.length === 1
        ? firstAttempt.promise
        : Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "retry after definite failure",
    });

    const sending = handleSendChat(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    host.chatMessage = "newer composer input";
    firstAttempt.reject(new Error("send rejected"));
    await sending;

    const itemId = host.chatQueue[0]?.id ?? "missing-failed-volatile-retry";
    expect(host.chatQueue[0]?.sendState).toBe("failed");
    expect(host.chatMessage).toBe("newer composer input");

    await retryQueuedChatMessage(host, itemId);

    expect(runIds).toHaveLength(2);
    expect(runIds[1]).not.toBe(runIds[0]);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatMessage).toBe("newer composer input");
  });

  it("keeps a volatile in-flight row when another durable item publishes", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let rejectWrites = true;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const volatileSend = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        return volatileSend.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "volatile first",
    });

    const firstSend = handleSendChat(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const volatileId = host.chatQueue[0]?.id;
    const volatileRunId = host.chatQueue[0]?.sendRunId;

    rejectWrites = false;
    host.chatMessage = "durable second";
    await handleSendChat(host);
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([
      expect.objectContaining({ text: "durable second", sendState: "waiting-idle" }),
    ]);

    volatileSend.reject(new Error("gateway closed (1006): network lost"));
    await firstSend;

    expect(host.chatQueue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: volatileId,
          sendRunId: volatileRunId,
          sendState: "unconfirmed",
        }),
        expect.objectContaining({ text: "durable second", sendState: "waiting-idle" }),
      ]),
    );
  });

  it("does not send a volatile item ahead of a durable backlog", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let rejectWrites = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn();
    const host = makeHost({
      connected: false,
      chatMessage: "durable first",
    });
    await handleSendChat(host);

    host.connected = true;
    host.client = { request } as unknown as ChatHost["client"];
    rejectWrites = true;
    host.chatMessage = "volatile second";
    await handleSendChat(host);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("volatile second");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ text: "durable first", sendState: "waiting-reconnect" }),
    ]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("keeps a pre-ack send queued when newer composer input blocks restoration", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let rejectWrites = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const sent = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        rejectWrites = true;
        return sent.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "original send",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "new draft";
    sent.reject(new Error("gateway closed (1006): network lost"));
    await send;

    expect(host.chatMessage).toBe("new draft");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "original send",
        sendAttempts: 1,
        sendState: "waiting-reconnect",
      }),
    ]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("queues normal sends made while disconnected", async () => {
    const host = makeHost({
      client: null,
      connected: false,
      chatMessage: "send after reconnect",
      eventLogBuffer: [],
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "send after reconnect",
      sendState: "waiting-reconnect",
      sessionKey: "agent:main",
    });
    expect(host.chatQueue[0]?.sendRunId).toEqual(expect.any(String));
    expect(eventPayloads(host, "control-ui.chat.send")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "waiting-reconnect",
          sendState: "waiting-reconnect",
        }),
      ]),
    );
  });

  it("retries an explicitly retryable send rejection while still connected", async () => {
    const sendRunIds: string[] = [];
    let sendAttempts = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "retryable send payload");
        sendRunIds.push(String(payload.idempotencyKey));
        sendAttempts += 1;
        if (sendAttempts === 1) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Gateway is temporarily busy",
            retryable: true,
            retryAfterMs: 100,
          });
        }
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "retry without disconnecting",
    });

    await handleSendChat(host);

    expect(host.connected).toBe(true);
    expect(host.chatQueue[0]).toMatchObject({ sendAttempts: 0, sendState: "waiting-reconnect" });
    await vi.waitFor(() => expect(sendAttempts).toBe(2));
    expect(sendRunIds[1]).toBe(sendRunIds[0]);
    await vi.waitFor(() => expect(listStoredChatOutboxes(host)).toStrictEqual([]));
  });

  it("retries reconnect history after a retryable response without a socket close", async () => {
    const host = makeHost({
      client: null,
      connected: false,
      chatMessage: "retry history while connected",
    });
    await handleSendChat(host);
    let historyAttempts = 0;
    let sendAttempts = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        historyAttempts += 1;
        if (historyAttempts === 1) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "History is temporarily unavailable",
            retryable: true,
            retryAfterMs: 100,
          });
        }
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        sendAttempts += 1;
        const payload = requireRecord(params, "history retry send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;

    await retryReconnectableQueuedChatSends(host);

    expect(historyAttempts).toBe(1);
    expect(sendAttempts).toBe(0);
    await vi.waitFor(() => expect(sendAttempts).toBe(1));
    expect(historyAttempts).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(listStoredChatOutboxes(host)).toStrictEqual([]));
  });

  it("persists queueable local commands entered while disconnected", async () => {
    executeSlashCommandMock.mockResolvedValueOnce({ content: "Thinking level set." });
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const attachment = {
      id: "offline-command-attachment",
      dataUrl: "data:text/plain;base64,dGVzdA==",
      fileName: "notes.txt",
      mimeType: "text/plain",
    };
    const host = makeHost({
      client: null,
      connected: false,
      chatAttachments: [attachment],
      chatMessage: "/think high",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([attachment]);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        localCommandArgs: "high",
        localCommandName: "think",
        sendState: "waiting-reconnect",
        text: "/think high",
      }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({
        localCommandName: "think",
        sendState: "waiting-reconnect",
        text: "/think high",
      }),
    ]);

    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(host.chatAttachments).toEqual([attachment]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("reconciles startup history before replaying an offline local command", async () => {
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const startupHistory = createDeferred<unknown>();
    let historyRequests = 0;
    const request = vi.fn((method: string) => {
      if (method !== "chat.history") {
        throw new Error(`Unexpected request: ${method}`);
      }
      historyRequests += 1;
      if (historyRequests === 1) {
        return startupHistory.promise;
      }
      return Promise.resolve({
        messages: [],
        sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
      });
    });
    const host = makeHost({
      client: null,
      connected: false,
      chatMessage: "/think high",
    });
    await handleSendChat(host);

    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;
    const replay = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() => expect(historyRequests).toBe(1));
    expect(executeSlashCommandMock).not.toHaveBeenCalled();

    startupHistory.resolve({
      messages: [],
      sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
    });
    await replay;

    expect(executeSlashCommandMock).not.toHaveBeenCalled();
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({ localCommandName: "think", sendState: "waiting-reconnect" }),
    ]);

    await flushChatQueueForEvent(host);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("restores an offline local command when durable admission fails", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const host = makeHost({
      client: null,
      connected: false,
      chatMessage: "/think high",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("/think high");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("retains offline attachments when browser storage rejects the queue", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);
    const attachment = {
      id: "offline-attachment",
      mimeType: "image/png",
      fileName: "offline.png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AAA",
    };
    const host = makeHost({
      client: null,
      connected: false,
      chatAttachments: [attachment],
    });

    await handleSendChat(host);

    expect(host.chatAttachments).toEqual([attachment]);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("consumes a reply target after queueing its turn offline", async () => {
    const host = makeHost({
      client: null,
      connected: false,
      chatMessage: "continue offline",
      chatReplyTarget: {
        messageId: "reply-source-offline",
        text: "quoted body",
        senderLabel: "User",
      },
    });

    await handleSendChat(host);

    expect(host.chatQueue[0]).toMatchObject({
      text: "> **User:** quoted body\n\ncontinue offline",
      sendState: "waiting-reconnect",
    });
    expect(host.chatReplyTarget).toBeNull();

    host.chatMessage = "next offline turn";
    await handleSendChat(host);

    expect(host.chatQueue[1]?.text).toBe("next offline turn");
  });

  it("replays a queued global send while another agent remains selected", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        return Promise.resolve({ runId: "run-work", status: "started" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: null,
      connected: false,
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessage: "send to work later",
    });

    await handleSendChat(host);

    expect(host.chatQueue[0]).toMatchObject({
      text: "send to work later",
      sessionKey: "global",
      agentId: "work",
      sendState: "waiting-reconnect",
    });

    host.assistantAgentId = "main";
    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "queued global send payload",
    );
    expect(payload.sessionKey).toBe("global");
    expect(payload.agentId).toBe("work");
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(
      loadChatComposerSnapshot({ ...host, assistantAgentId: "work" }, "global")?.queue,
    ).toEqual([expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" })]);
  });

  it("replays a queued main alias after the route canonicalizes to global", async () => {
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "canonical alias payload");
        return Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      assistantAgentId: "work",
      chatMessage: "survive alias canonicalization",
      client: null,
      connected: false,
      sessionKey: "agent:work:main",
    });

    await handleSendChat(host);
    const restored = loadChatComposerSnapshot(host, "global");
    expect(restored?.queue[0]).toMatchObject({
      agentId: "work",
      sessionKey: "global",
      sendState: "waiting-reconnect",
    });

    host.sessionKey = "global";
    host.chatQueue = restored?.queue ?? [];
    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    expect(
      findRequestPayload(request as unknown as MockCallSource, "chat.send", "canonical alias"),
    ).toMatchObject({
      agentId: "work",
      message: "survive alias canonicalization",
      sessionKey: "global",
    });
  });

  it("abandons stale reconnect history after the connection epoch changes", async () => {
    const history = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return history.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      assistantAgentId: "work",
      client: { request } as unknown as ChatHost["client"],
      connectionEpoch: 1,
      sessionKey: "global",
      chatQueue: [
        {
          id: "global-agent-race",
          text: "stay with work",
          createdAt: 1,
          agentId: "work",
          sendAttempts: 0,
          sendRunId: "global-agent-race-run",
          sendState: "waiting-reconnect",
          sessionKey: "global",
        },
      ],
    });
    admitHostQueueItems(host);

    const retry = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("chat.history", expect.anything()));
    host.connectionEpoch = 2;
    history.resolve({
      messages: [],
      sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
    });
    await retry;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
  });

  it("reruns a stale in-flight drain when reconnect schedules the current epoch", async () => {
    const staleHistory = createDeferred<unknown>();
    let historyRequests = 0;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        historyRequests += 1;
        if (historyRequests === 1) {
          return staleHistory.promise;
        }
        return Promise.resolve({
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "current epoch send payload");
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      connectionEpoch: 1,
      chatQueue: [
        {
          id: "reconnect-rerun",
          text: "send on the current epoch",
          createdAt: 1,
          sendRunId: "reconnect-rerun-id",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    const staleRetry = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() => expect(historyRequests).toBe(1));
    host.connectionEpoch = 2;
    const reconnectRetry = retryReconnectableQueuedChatSends(host);
    staleHistory.resolve({
      messages: [],
      sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
    });
    await Promise.all([staleRetry, reconnectRetry]);

    // Two reconciliation reads plus the post-delivery transcript refresh.
    expect(historyRequests).toBe(3);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("reruns blocked history when a terminal wakeup arrives during reconciliation", async () => {
    const activeHistory = createDeferred<unknown>();
    let historyRequests = 0;
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        historyRequests += 1;
        if (historyRequests === 1) {
          return activeHistory.promise;
        }
        return Promise.resolve({
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "terminal wakeup send payload");
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "terminal-wakeup-rerun",
          text: "send after the terminal wakeup",
          createdAt: 1,
          sendRunId: "terminal-wakeup-rerun-id",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    const initialDrain = retryReconnectableQueuedChatSends(host);
    await vi.waitFor(() => expect(historyRequests).toBe(1));
    const terminalWakeup = flushChatQueueForEvent(host);
    activeHistory.resolve({
      messages: [],
      sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
    });
    await Promise.all([initialDrain, terminalWakeup]);

    // Two reconciliation reads plus the post-delivery transcript refresh.
    expect(historyRequests).toBe(3);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps a reconnect send queued when attempt persistence fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      connected: true,
      chatQueue: [
        {
          id: "queued-retry-storage-failure",
          text: "keep this queued message",
          createdAt: 1,
          sendRunId: "run-retry-storage-failure",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    await retryReconnectableQueuedChatSends(host);

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: "queued-retry-storage-failure",
        sendState: "waiting-reconnect",
      }),
    ]);
    expect(host.chatQueue[0]?.sendAttempts).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("removes a reconnect send with history proof before stale local busy state blocks it", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [
            {
              role: "user",
              __openclaw: { idempotencyKey: "ambiguous-run:user" },
            },
          ],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "ambiguous-run",
      chatQueue: [
        {
          id: "ambiguous-delivered",
          text: "already delivered",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "ambiguous-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("rechecks an idle history snapshot before parking a delivered send", async () => {
    let historyRequests = 0;
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        historyRequests += 1;
        return Promise.resolve({
          messages:
            historyRequests === 1
              ? []
              : [
                  {
                    role: "user",
                    __openclaw: { idempotencyKey: "late-history-proof:user" },
                  },
                ],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "late-history-proof",
          text: "landed during the first history read",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "late-history-proof",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    // Two reconciliation reads plus the post-delivery transcript refresh.
    expect(historyRequests).toBe(3);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps a settings-blocked Skill Workshop revision retryable", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return idleChatHistory();
      }
      if (method === "skills.proposals.requestRevision") {
        return { runId: "revision-retry", status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      chatMessage: "keep my draft",
      client: { request } as unknown as ChatHost["client"],
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
    });
    const revision = {
      proposalId: "support-file-sampler-20260531-68207b7b7f",
      agentId: "proposal-owner",
    };

    const send = handleSendChat(host, "Make the support files 6", {
      restoreDraft: true,
      skillWorkshopRevision: revision,
    });
    expect(await raceWithMacrotask(send)).toBe("pending");
    settingsPatch.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("keep my draft");
    expect(host.chatQueue[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      skillWorkshopRevision: revision,
      text: "Make the support files 6",
    });

    await retryQueuedChatMessage(host, host.chatQueue[0]!.id);

    expect(
      findRequestPayload(
        request as unknown as MockCallSource,
        "skills.proposals.requestRevision",
        "revision retry payload",
      ),
    ).toMatchObject({
      agentId: "proposal-owner",
      instructions: "Make the support files 6",
      proposalId: revision.proposalId,
    });
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendState: "sending",
        skillWorkshopRevision: revision,
        text: "Make the support files 6",
      }),
    ]);
  });

  it("stops delivered-send reconciliation when durable removal fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const remove = storage.removeItem.bind(storage);
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [
            {
              role: "user",
              __openclaw: { idempotencyKey: "delivered-removal-failure:user" },
            },
          ],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const item = {
      id: "delivered-removal-failure",
      text: "already delivered but still durable",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "delivered-removal-failure",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [item],
    });
    admitHostQueueItems(host);
    let failedDeletes = 0;
    vi.spyOn(storage, "removeItem").mockImplementation((key) => {
      if (failedDeletes === 0) {
        failedDeletes += 1;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      remove(key);
    });

    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(failedDeletes).toBe(1);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
  });

  it("parks an ambiguous reconnect send when idle history cannot prove delivery", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "ambiguous-unconfirmed",
          text: "maybe delivered",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "unconfirmed-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
        {
          id: "blocked-tail",
          text: "must not overtake",
          createdAt: 2,
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);
    await flushChatQueueForEvent(host);

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      id: "ambiguous-unconfirmed",
      sendState: "unconfirmed",
    });
    expect(host.chatQueue.map((item) => item.id)).toEqual([
      "ambiguous-unconfirmed",
      "blocked-tail",
    ]);
    expect(host.lastError).toContain("Delivery could not be confirmed");
  });

  it("does not replay while fresh history reports an active run", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "done" }),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "wait-for-idle",
          text: "send after the active run",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "wait-for-idle-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
  });

  it("skips a manually failed head when replaying a later reconnect send", async () => {
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        const payload = requireRecord(params, "reconnect tail payload");
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatQueue: [
        {
          id: "manual-head",
          text: "manual only",
          createdAt: 1,
          sendRunId: "manual-run",
          sendState: "failed",
        },
        {
          id: "reconnect-tail",
          text: "safe automatic tail",
          createdAt: 2,
          sendAttempts: 0,
          sendRunId: "reconnect-tail-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(
      findRequestPayload(request as unknown as MockCallSource, "chat.send", "tail"),
    ).toMatchObject({ idempotencyKey: "reconnect-tail-run", message: "safe automatic tail" });
    expect(host.chatQueue.map((item) => item.id)).toEqual(["manual-head"]);
  });

  it("keeps the sole failed queue item when an offline manual retry cannot persist", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const host = makeHost({
      connected: false,
      chatQueue: [
        {
          id: "manual-offline-retry",
          text: "do not lose me",
          createdAt: 1,
          sendRunId: "manual-offline-run",
          sendState: "failed",
        },
      ],
    });
    admitHostQueueItems(host);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    await retryQueuedChatMessage(host, "manual-offline-retry");

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: "manual-offline-retry",
        text: "do not lose me",
        sendState: "failed",
      }),
    ]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("defers queued global send agent selection until defaults are known", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        });
      }
      if (method === "chat.send") {
        return Promise.resolve({ runId: "run-work", status: "started" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: null,
      connected: false,
      sessionKey: "global",
      chatMessage: "send to default later",
    });

    await handleSendChat(host);

    expect(host.chatQueue[0]).toMatchObject({
      text: "send to default later",
      sessionKey: "global",
      sendState: "waiting-reconnect",
    });
    expect(host.chatQueue[0]?.agentId).toBeUndefined();

    host.agentsList = { defaultId: "work" };
    host.client = { request } as unknown as ChatHost["client"];
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "queued global send payload",
    );
    expect(payload.sessionKey).toBe("global");
    expect(payload.agentId).toBe("work");
    expect(loadChatComposerSnapshot({ ...host, assistantAgentId: "main" }, "global")).toBeNull();
    expect(
      loadChatComposerSnapshot({ ...host, assistantAgentId: "work" }, "global")?.queue,
    ).toEqual([expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" })]);
  });

  it("marks saved session queued sends waiting after a disconnect", () => {
    const host = makeHost({ chatQueue: [] });
    const queuedScopeKey = queueScopeKey(host, "agent:a");
    host.chatQueueByScope = {
      [queuedScopeKey]: [
        {
          id: "pending-send-a",
          text: "pending",
          createdAt: 1,
          sendRunId: "run-a",
          sendState: "sending",
          sessionKey: "agent:a",
        },
      ],
    };

    markQueuedChatSendsWaitingForReconnect(host);

    expect(host.chatQueueByScope?.[queuedScopeKey]?.[0]).toMatchObject({
      sendRunId: "run-a",
      sendState: "waiting-reconnect",
    });
  });

  it("marks validation failures visible and restores the composer", async () => {
    const request = vi.fn((method: string) => {
      if (method === "chat.send") {
        throw new Error("send blocked by session policy");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "blocked prompt",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("blocked prompt");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      text: "blocked prompt",
      sendState: "failed",
      sendError: "send blocked by session policy",
    });
  });

  it("restores the BTW draft when detached send fails", async () => {
    const host = makeHost({
      client: {
        request: vi.fn(async (method: string) => {
          if (method === "chat.send") {
            throw new Error("network down");
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
      } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/btw what changed?",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessage).toBe("/btw what changed?");
    expect(host.lastError).toBe("network down");
  });

  it("restores the BTW draft when detached send returns a terminal timeout ACK", async () => {
    const host = makeHost({
      client: {
        request: vi.fn(async (method: string) => {
          if (method === "chat.send") {
            return { runId: "btw-terminal", status: "timeout" };
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
      } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/btw what changed?",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessage).toBe("/btw what changed?");
    expect(host.lastError).toBe("The active run ended before the detached message was accepted.");
  });

  it("clears BTW side results when /clear resets chat history", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        return { ok: true };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatSideResult: {
        kind: "btw",
        runId: "btw-run-clear",
        sessionKey: "main",
        question: "what changed?",
        text: "Detached BTW result",
        isError: false,
        ts: 1,
      },
      chatSideResultTerminalRuns: new Set(["btw-run-clear"]),
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.reset", { key: "main" });
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatSideResult).toBeNull();
    expect(host.chatSideResultTerminalRuns?.size).toBe(0);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("scopes /clear resets for selected-agent global sessions", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        return { ok: true };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatMessagesBySession: new Map([
        ["agent:work:main", [{ role: "assistant", content: "work history" }]],
        ["agent:main:main", [{ role: "assistant", content: "main history" }]],
      ]),
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
      agentId: "work",
    });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "global",
      agentId: "work",
      limit: 100,
    });
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessagesBySession?.has("agent:work:main")).toBe(false);
    expect(host.chatMessagesBySession?.has("agent:main:main")).toBe(true);
  });

  it("does not clear the newly visible session when a queued clear switches routes", async () => {
    const reset = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.reset") {
        return reset.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sourceSessionKey = "agent:main:source";
    const visibleSessionKey = "agent:main:visible";
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
      chatMessagesBySession: new Map([
        [sourceSessionKey, [{ role: "user", content: "source history" }]],
        [visibleSessionKey, [{ role: "user", content: "visible history" }]],
      ]),
      chatRunId: null,
      sessionKey: sourceSessionKey,
    });

    const clearing = handleSendChat(host);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.reset", { key: sourceSessionKey }),
    );
    host.chatQueueByScope = { [queueScopeKey(host, sourceSessionKey)]: host.chatQueue };
    host.chatQueue = [];
    host.sessionKey = visibleSessionKey;
    host.chatMessages = [{ role: "user", content: "visible history" }];
    host.chatRunId = "visible-run";
    reset.resolve({ ok: true });
    await clearing;

    expect(host.chatMessages).toEqual([{ role: "user", content: "visible history" }]);
    expect(host.chatRunId).toBe("visible-run");
    expect(host.chatMessagesBySession?.has(sourceSessionKey)).toBe(false);
    expect(host.chatMessagesBySession?.get(visibleSessionKey)).toEqual([
      { role: "user", content: "visible history" },
    ]);
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("invalidates the captured session cache when a rejected clear switches routes", async () => {
    const reset = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.reset") {
        return reset.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sourceSessionKey = "agent:main:source";
    const visibleSessionKey = "agent:main:visible";
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
      chatMessagesBySession: new Map([
        [sourceSessionKey, [{ role: "user", content: "cached source history" }]],
        [visibleSessionKey, [{ role: "user", content: "cached visible history" }]],
      ]),
      sessionKey: sourceSessionKey,
    });

    const clearing = handleSendChat(host);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.reset", { key: sourceSessionKey }),
    );
    host.chatQueueByScope = { [queueScopeKey(host, sourceSessionKey)]: host.chatQueue };
    host.chatQueue = [];
    host.sessionKey = visibleSessionKey;
    host.chatMessages = [{ role: "user", content: "visible history" }];
    reset.reject(new Error("post-commit lifecycle failed"));
    await clearing;

    expect(host.chatMessagesBySession?.has(sourceSessionKey)).toBe(false);
    expect(host.chatMessagesBySession?.get(visibleSessionKey)).toEqual([
      { role: "user", content: "cached visible history" },
    ]);
    expect(host.chatMessages).toEqual([{ role: "user", content: "visible history" }]);
    expect(host.lastError).toContain("clear request may have completed");
    expect(host.lastError).toContain("could not be refreshed");
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("retires an uncertain clear and refreshes replacement history without retrying", async () => {
    const reset = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.reset") {
        return reset.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      connectionEpoch: 1,
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "do not clear ambiguously" }],
    });

    const clearing = handleSendChat(host);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.reset", { key: "agent:main" }),
    );
    const queuedId = host.chatQueue[0]?.id ?? "missing-clear";
    const replacementRequest = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: "newer replacement history" }],
          thinkingLevel: null,
        };
      }
      throw new Error(`Unexpected replacement request: ${method}`);
    });
    host.client = { request: replacementRequest } as unknown as ChatHost["client"];
    host.connectionEpoch = 2;
    reset.resolve({ ok: true });
    await clearing;

    expect(host.chatMessages).toEqual([
      { role: "assistant", content: "newer replacement history" },
    ]);
    expect(host.chatQueue).toEqual([]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue ?? []).toEqual([]);
    expect(host.lastError).toContain("clear request may have completed");
    expect(replacementRequest).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:main",
      limit: 100,
    });

    await retryQueuedChatMessage(host, queuedId);

    expect(request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(1);
    expect(
      replacementRequest.mock.calls.filter(([method]) => method === "sessions.reset"),
    ).toHaveLength(0);
  });

  it("clears a canonically equivalent alias that becomes visible while reset is pending", async () => {
    const reset = createDeferred<unknown>();
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "sessions.reset") {
        return reset.promise;
      }
      if (method === "chat.history") {
        return Promise.resolve({
          messages: [{ role: "assistant", content: "canonical refreshed history" }],
          thinkingLevel: null,
        });
      }
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "alias history" }],
    });

    const clearing = handleSendChat(host);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.reset", {
        key: "agent:work:main",
        agentId: "work",
      }),
    );
    host.sessionKey = "global";
    host.chatMessages = [{ role: "user", content: "same canonical history" }];
    reset.resolve({ ok: true });
    await clearing;

    expect(host.chatMessages).toEqual([
      { role: "assistant", content: "canonical refreshed history" },
    ]);
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "global",
      agentId: "work",
      limit: 100,
    });
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("shows a visible pending item for /steer on the active run", async () => {
    const host = makeHost({
      client: {
        request: vi.fn(async (method: string) => {
          if (method === "chat.send") {
            return { status: "started", runId: "run-1", messageSeq: 2 };
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
      } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatMessage: "/steer tighten the plan",
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([row("agent:main:main", { status: "running" })]),
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("/steer tighten the plan");
    expect(host.chatQueue[0]?.kind).toBe("steered");
    expect(host.chatQueue[0]?.pendingRunId).toBe("run-1");
  });

  it("steers a queued message into the active run without replacing run tracking", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started", runId: "steer-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = { id: "queued-1", text: "tighten the plan", createdAt: 1 };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatStream: "Working...",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    await steerQueuedChatMessage(host, "queued-1");

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "steered chat send payload",
    );
    const idempotencyKey = payload.idempotencyKey;
    expect(typeof idempotencyKey).toBe("string");
    expect(uuidPattern.test(idempotencyKey as string)).toBe(true);
    expect(payload).toEqual({
      sessionKey: "agent:main:main",
      message: "tighten the plan",
      deliver: false,
      idempotencyKey,
      attachments: undefined,
    });
    expect(host.chatRunId).toBe("run-1");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("tighten the plan");
    expect(host.chatQueue[0]?.kind).toBe("steered");
    expect(host.chatQueue[0]?.pendingRunId).toBe("run-1");
  });

  it("does not steer a queued message without a durable claim", async () => {
    const request = vi.fn();
    const original = { id: "memory-only-steer", text: "do not lose this", createdAt: 1 };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });

    await steerQueuedChatMessage(host, original.id);

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([original]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("retires a durable queued turn after accepted steer before terminal resume", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started", runId: "steer-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "durable-steer",
      text: "tighten the durable plan",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    await steerQueuedChatMessage(host, original.id);

    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.chatQueue).toEqual([
      {
        id: original.id,
        text: original.text,
        createdAt: original.createdAt,
        kind: "steered",
        pendingRunId: "active-run",
      },
    ]);

    clearPendingQueueItemsForRun(host, "active-run");
    host.chatRunId = null;
    await retryReconnectableQueuedChatSends(host);

    expect(host.chatQueue).toEqual([]);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("does not restore a steer indicator after its run ends before the acknowledgement", async () => {
    let resolveRequest: (value: { status: "started"; runId: string }) => void = () => {};
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return await new Promise<{ status: "started"; runId: string }>((resolve) => {
          resolveRequest = resolve;
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "late-ack-durable-steer",
      text: "tighten the durable plan",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    const steering = steerQueuedChatMessage(host, original.id);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    clearPendingQueueItemsForRun(host, "active-run");
    host.chatRunId = null;
    resolveRequest({ status: "started", runId: "steer-run" });
    await steering;

    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.chatQueue).toEqual([]);
  });

  it("resumes a restored steer after its active run ended before a terminal error", async () => {
    let resolveSteer: (value: { status: "error"; runId: string }) => void = () => {};
    let sends = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:main", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        sends += 1;
        if (sends === 1) {
          return await new Promise<{ status: "error"; runId: string }>((resolve) => {
            resolveSteer = resolve;
          });
        }
        return { status: "ok", runId: "resumed-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "late-terminal-steer",
      text: "send after the steer fails",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    const steering = steerQueuedChatMessage(host, original.id);
    await vi.waitFor(() => expect(sends).toBe(1));
    clearPendingQueueItemsForRun(host, "active-run");
    host.chatRunId = null;
    await flushChatQueueForEvent(host);
    resolveSteer({ status: "error", runId: "steer-error" });
    await steering;
    await vi.waitFor(() => expect(sends).toBe(2));

    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.chatQueue).toEqual([]);
  });

  it("resumes a restored steer after its run ends offscreen before a terminal error", async () => {
    let resolveSteer: (value: { status: "error"; runId: string }) => void = () => {};
    let sends = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:original", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        sends += 1;
        if (sends === 1) {
          return await new Promise<{ status: "error"; runId: string }>((resolve) => {
            resolveSteer = resolve;
          });
        }
        return { status: "ok", runId: "resumed-offscreen-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "offscreen-late-terminal-steer",
      text: "send after the offscreen steer fails",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:original",
      agentId: "main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    const steering = steerQueuedChatMessage(host, original.id);
    await vi.waitFor(() => expect(sends).toBe(1));
    const originalScopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(host, host.sessionKey),
    );
    host.chatQueueByScope = { [originalScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:main:replacement";
    host.chatRunId = null;

    // The terminal event cannot replay an unconfirmed steer. The later
    // definitive rejection must provide the final wakeup for this old scope.
    await flushChatQueueForEvent(host);
    expect(sends).toBe(1);
    resolveSteer({ status: "error", runId: "steer-error" });
    await steering;
    await vi.waitFor(() => expect(sends).toBe(2));
    await vi.waitFor(() => expect(listStoredChatOutboxes(host)).toEqual([]));

    expect(host.chatQueue).toEqual([]);
    expect(host.chatQueueByScope[originalScopeKey]).toBeUndefined();
  });

  it("resumes a restored steer attachment from its durable payload after terminal cleanup", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:late-terminal-steer");
        static override revokeObjectURL = vi.fn();
      },
    );
    let resolveSteer: (value: { status: "error"; runId: string }) => void = () => {};
    const sendPayloads: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:main:main", { hasActiveRun: false, status: "done" }),
        };
      }
      if (method === "chat.send") {
        sendPayloads.push(requireRecord(params, "late terminal steer attachment payload"));
        if (sendPayloads.length === 1) {
          return await new Promise<{ status: "error"; runId: string }>((resolve) => {
            resolveSteer = resolve;
          });
        }
        return { status: "ok", runId: "resumed-attachment-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "late-terminal-steer-attachment",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        sizeBytes: file.size,
      },
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      file,
    });
    const original = {
      id: "late-terminal-attachment-steer",
      text: "send the attachment after the steer fails",
      attachments: [attachment],
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-attachment-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    const steering = steerQueuedChatMessage(host, original.id);
    await vi.waitFor(() => expect(sendPayloads).toHaveLength(1));
    clearPendingQueueItemsForRun(host, "active-run");
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    host.chatRunId = null;
    await flushChatQueueForEvent(host);
    resolveSteer({ status: "error", runId: "steer-error" });
    await steering;
    await vi.waitFor(() => expect(sendPayloads).toHaveLength(2));
    await vi.waitFor(() => expect(listStoredChatOutboxes(host)).toEqual([]));

    const replayAttachments = sendPayloads[1]?.attachments as Array<Record<string, unknown>>;
    expect(replayAttachments).toHaveLength(1);
    expect(replayAttachments[0]?.content).toBe("JVBERi0xLjQK");
    expect(replayAttachments[0]?.fileName).toBe("brief.pdf");
    expect(host.chatQueue).toEqual([]);
  });

  it("does not project a late steer acknowledgement into a newly selected session", async () => {
    let resolveRequest: (value: { status: "started"; runId: string }) => void = () => {};
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return await new Promise<{ status: "started"; runId: string }>((resolve) => {
          resolveRequest = resolve;
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "route-switch-steer",
      text: "tighten the plan",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:original",
      agentId: "main",
    };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: "agent:main:original",
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    const steering = steerQueuedChatMessage(host, original.id);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const originalScopeKey = storedChatOutboxScopeKey(
      resolveStoredChatOutboxScope(host, host.sessionKey),
    );
    host.chatQueueByScope = { [originalScopeKey]: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:main:replacement";
    resolveRequest({ status: "started", runId: "steer-run" });
    await steering;

    expect(listStoredChatOutboxes(host)).toEqual([]);
    expect(host.chatQueue).toEqual([]);
    expect(host.chatQueueByScope[originalScopeKey]).toBeUndefined();
    expect(setLastActiveSessionKeyMock).not.toHaveBeenCalled();
  });

  it.each(["terminal error", "ambiguous acknowledgement"] as const)(
    "keeps the durable steer recoverable after a route switch and %s",
    async (outcome) => {
      let resolveRequest: (value: { status: "error"; runId: string }) => void = () => {};
      let rejectRequest: (reason: Error) => void = () => {};
      const request = vi.fn(async (method: string) => {
        if (method === "chat.send") {
          return await new Promise<{ status: "error"; runId: string }>((resolve, reject) => {
            resolveRequest = resolve;
            rejectRequest = reject;
          });
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const original = {
        id: `route-switch-${outcome}`,
        text: "keep this steer recoverable",
        createdAt: 1,
        sendAttempts: 0,
        sendRunId: "queued-run",
        sendState: "waiting-idle" as const,
        sessionKey: "agent:main:original",
        agentId: "main",
      };
      const host = makeHost({
        client: { request } as unknown as ChatHost["client"],
        chatError: null,
        chatRunId: "active-run",
        chatQueue: [original],
        sessionKey: original.sessionKey,
      });
      expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

      const steering = steerQueuedChatMessage(host, original.id);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const originalScopeKey = storedChatOutboxScopeKey(
        resolveStoredChatOutboxScope(host, host.sessionKey),
      );
      host.chatQueueByScope = { [originalScopeKey]: [...host.chatQueue] };
      host.chatQueue = [];
      host.sessionKey = "agent:main:replacement";
      if (outcome === "terminal error") {
        resolveRequest({ status: "error", runId: "steer-error" });
      } else {
        rejectRequest(new Error("socket closed"));
      }
      await steering;

      const expectedState = outcome === "terminal error" ? "waiting-idle" : "unconfirmed";
      expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([
        { id: original.id, sendState: expectedState },
      ]);
      expect(host.chatQueue).toEqual([]);
      expect(host.chatQueueByScope[originalScopeKey]).toMatchObject([
        { id: original.id, sendState: expectedState },
      ]);
      expect(host.lastError).toBeNull();
      expect(host.chatError).toBeNull();
      expect(setLastActiveSessionKeyMock).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("parks a durable queued turn when the steer acknowledgement is ambiguous", async () => {
    let rejectRequest: (reason: Error) => void = () => {};
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return await new Promise<never>((_resolve, reject) => {
          rejectRequest = reject;
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = {
      id: "ambiguous-durable-steer",
      text: "tighten the durable plan",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "queued-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const client = { request } as unknown as ChatHost["client"];
    const host = makeHost({
      client,
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });
    const peer = makeHost({
      client,
      chatRunId: "active-run",
      chatQueue: [{ ...original }],
      sessionKey: host.sessionKey,
    });
    const latePeer = makeHost({ client, chatQueue: [], sessionKey: host.sessionKey });
    const stopHost = subscribeChatOutboxProjection(host);
    const stopPeer = subscribeChatOutboxProjection(peer);
    let stopLatePeer = () => {};
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    try {
      const steering = steerQueuedChatMessage(host, original.id);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(host.chatQueue).toHaveLength(1);
      expect(host.chatQueue[0]?.pendingRunId).toBe("active-run");
      expect(peer.chatQueue).toHaveLength(1);
      expect(peer.chatQueue[0]?.sendState).toBe("steering");
      await steerQueuedChatMessage(peer, original.id);
      expect(request).toHaveBeenCalledTimes(1);
      stopLatePeer = subscribeChatOutboxProjection(latePeer);
      expect(latePeer.chatQueue).toHaveLength(1);
      expect(latePeer.chatQueue[0]?.sendState).toBe("steering");
      await retryQueuedChatMessage(peer, original.id);
      expect(request).toHaveBeenCalledTimes(1);
      expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]?.sendState).toBe(
        "unconfirmed",
      );
      const outbox = listStoredChatOutboxes(host)[0];
      expect(outbox).toBeDefined();
      syncChatQueueFromStoredOutbox(peer, outbox!);
      expect(peer.chatQueue).toHaveLength(1);
      expect(peer.chatQueue[0]?.sendState).toBe("steering");

      clearPendingQueueItemsForRun(host, "active-run");
      host.chatRunId = null;
      rejectRequest(new Error("socket closed"));
      await steering;

      expect(listStoredChatOutboxes(host)[0]?.queue).toMatchObject([
        {
          id: original.id,
          text: original.text,
          sendRunId: original.sendRunId,
          sendError: "Steer delivery could not be confirmed. Check the active run before retrying.",
          sendState: "unconfirmed",
        },
      ]);
      expect(host.chatQueue).toHaveLength(1);
      expect(host.chatQueue[0]).toMatchObject({
        id: original.id,
        sendState: "unconfirmed",
      });
      expect(peer.chatQueue).toHaveLength(1);
      expect(peer.chatQueue[0]).toMatchObject({
        id: original.id,
        sendState: "unconfirmed",
      });
      expect(latePeer.chatQueue).toHaveLength(1);
      expect(latePeer.chatQueue[0]).toMatchObject({
        id: original.id,
        sendState: "unconfirmed",
      });
      expect(host.lastError).toBe(
        "Steer delivery could not be confirmed. Check the active run before retrying.",
      );

      await retryReconnectableQueuedChatSends(host);

      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    } finally {
      stopLatePeer();
      stopPeer();
      stopHost();
    }
  });

  it("removes queued steer indicators when chat.send returns terminal ok", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "ok", runId: "steer-ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = { id: "queued-1", text: "tighten the plan", createdAt: 1 };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatStream: "Working...",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    await steerQueuedChatMessage(host, "queued-1");

    expect(host.chatRunId).toBe("run-1");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatQueue).toStrictEqual([]);
    expect(setLastActiveSessionKeyMock).toHaveBeenCalledWith(expect.anything(), "agent:main:main");
  });

  it("restores queued steer items when chat.send returns terminal error", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "error", runId: "steer-error" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const original = { id: "queued-1", text: "tighten the plan", createdAt: 1 };
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatStream: "Working...",
      chatQueue: [original],
      sessionKey: "agent:main:main",
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    await steerQueuedChatMessage(host, "queued-1");

    expect(host.chatRunId).toBe("run-1");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatQueue).toStrictEqual([original]);
    expect(host.lastError).toBe("Steer failed before it reached the run; try again.");
    expect(setLastActiveSessionKeyMock).not.toHaveBeenCalled();
  });

  it("removes pending steer indicators when the run finishes", () => {
    const host = makeHost({
      chatQueue: [
        {
          id: "pending",
          text: "/steer tighten the plan",
          createdAt: 1,
          pendingRunId: "run-1",
        },
        {
          id: "queued",
          text: "follow up",
          createdAt: 2,
        },
      ],
    });

    clearPendingQueueItemsForRun(host, "run-1");

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.id).toBe("queued");
    expect(host.chatQueue[0]?.text).toBe("follow up");
  });

  it("drops sent attachment payload bytes while keeping the optimistic preview URL", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:brief");
        static override revokeObjectURL = vi.fn();
      },
    );
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "ok", runId: "run-1" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "att-1",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        sizeBytes: file.size,
      },
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      file,
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatAttachments: [attachment],
      chatMessage: "summarize",
    });

    await handleSendChat(host);

    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    expect(getChatAttachmentPreviewUrl(attachment)).toBe("blob:brief");
    expect(host.chatMessages).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize" },
          {
            type: "attachment",
            attachment: {
              url: "blob:brief",
              kind: "document",
              label: "brief.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("releases queued attachment payloads when the queued item is removed", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = vi.fn(() => "blob:queued");
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const file = new File(["%PDF-1.4\n"], "brief.pdf", { type: "application/pdf" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "queued-att",
        mimeType: "application/pdf",
        fileName: "brief.pdf",
        sizeBytes: file.size,
      },
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      file,
    });
    const host = makeHost({
      chatQueue: [{ id: "queued", text: "later", createdAt: 1, attachments: [attachment] }],
    });

    removeQueuedMessage(host, "queued");

    expect(host.chatQueue).toStrictEqual([]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:queued");
  });
});

describe("handleAbortChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  it("preserves the draft for connected toolbar aborts", async () => {
    const request = vi.fn(async () => ({ aborted: true }));
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatMessage: "next prompt",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(request).toHaveBeenCalledWith("chat.abort", {
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("next prompt");
    expect(host.chatRunId).toBe("run-main");
  });

  it("clears typed stop commands after aborting the active run", async () => {
    const request = vi.fn(async () => ({ aborted: true }));
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatMessage: "/stop",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("chat.abort", {
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("");
  });

  it("queues the active run abort while disconnected", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: "run-main",
      chatMessage: "draft",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toEqual({ runId: "run-main", sessionKey: "agent:main" });
    expect(host.chatMessage).toBe("");
    expect(host.chatRunId).toBe("run-main");
  });

  it("preserves the draft when queueing a toolbar abort while disconnected", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: "run-main",
      chatMessage: "draft",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(host.pendingAbort).toEqual({ runId: "run-main", sessionKey: "agent:main" });
    expect(host.chatMessage).toBe("draft");
    expect(host.chatRunId).toBe("run-main");
  });

  it("queues a session-scoped abort while disconnected after active run state is recovered", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
      sessionKey: "agent:main",
      sessionsResult: createSessionsResult([
        row("agent:main", { hasActiveRun: true }),
        row("agent:other", { hasActiveRun: true }),
      ]),
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toEqual({ runId: null, sessionKey: "agent:main" });
    expect(host.chatMessage).toBe("");
  });

  it("queues selected-agent global aborts with agent scope while disconnected", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      sessionsResult: createSessionsResult([
        row("global", { hasActiveRun: true, agentId: "work" } as Partial<GatewaySessionRow>),
      ]),
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toEqual({
      runId: null,
      sessionKey: "global",
      agentId: "work",
    });
    expect(host.chatMessage).toBe("");
  });

  it("ignores stale active-run flags once the current session is terminal", () => {
    const host = makeHost({
      chatRunId: null,
      sessionKey: "agent:main",
      sessionsResult: createSessionsResult([
        row("agent:main", { hasActiveRun: true, status: "done" }),
        row("agent:other", { hasActiveRun: true, status: "running" }),
      ]),
    });

    expect(hasAbortableSessionRun(host)).toBe(false);
  });

  it("ignores stale running status once the gateway reports no active run", () => {
    const host = makeHost({
      chatRunId: null,
      sessionKey: "agent:main",
      sessionsResult: createSessionsResult([
        row("agent:main", { hasActiveRun: false, status: "running" }),
        row("agent:other", { hasActiveRun: true, status: "running" }),
      ]),
    });

    expect(hasAbortableSessionRun(host)).toBe(false);
  });

  it("keeps the draft when disconnected without an active run", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
  });
});

afterAll(() => {
  vi.doUnmock("../../app/settings.ts");
  vi.resetModules();
});
