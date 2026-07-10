/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { UiSettings } from "../../app/settings.ts";
import { createSessionCapability } from "../../lib/sessions/index.ts";
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
  switchChatFastMode,
  switchChatThinkingLevel,
  trackPendingChatPickerPatch,
} from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

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
let clearPendingQueueItemsForRun: typeof import("./chat-queue.ts").clearPendingQueueItemsForRun;
let removeQueuedMessage: typeof import("./chat-queue.ts").removeQueuedMessage;
let markQueuedChatSendsWaitingForReconnect: typeof import("./chat-queue.ts").markQueuedChatSendsWaitingForReconnect;
let retryQueuedChatMessage: typeof import("./chat-send.ts").retryQueuedChatMessage;
let retryReconnectableQueuedChatSends: typeof import("./chat-send.ts").retryReconnectableQueuedChatSends;
let recordChatSendServerTiming: typeof import("./chat-send-timing.ts").recordChatSendServerTiming;
let recordFirstAssistantChatTiming: typeof import("./chat-send-timing.ts").recordFirstAssistantChatTiming;

async function loadChatHelpers(): Promise<void> {
  ({
    handleSendChat,
    steerQueuedChatMessage,
    navigateChatInputHistory,
    retryQueuedChatMessage,
    retryReconnectableQueuedChatSends,
  } = await import("./chat-send.ts"));
  ({ recordChatSendServerTiming, recordFirstAssistantChatTiming } =
    await import("./chat-send-timing.ts"));
  const chatState = await import("./chat-state.ts");
  refreshChat = (host, options) => chatState.refreshChat(host as unknown as ChatPageHost, options);
  ({ handleAbortChat, hasAbortableSessionRun } = await import("./run-lifecycle.ts"));
  ({ clearPendingQueueItemsForRun, removeQueuedMessage, markQueuedChatSendsWaitingForReconnect } =
    await import("./chat-queue.ts"));
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
    chatQueueBySession: {},
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
    chatModelSwitchPromises: {},
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
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("main", { hasActiveRun: false, status: "done" }),
        };
      }
      return {};
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatQueue: [{ id: "queued-1", text: "after reload", createdAt: 1 }],
    });

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
        message: "after reload",
      }),
    );
    expect(host.chatQueue).toEqual([]);
  });

  it("drains a restored queue from history metadata when the visible list is scoped elsewhere", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("agent:work:dashboard", {
            hasActiveRun: false,
            status: "done",
          }),
        };
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
    const request = vi.fn(async (method: string) => {
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

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:work:main",
        message: "after global alias reload",
      }),
    );
    expect(request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    expect(host.chatQueue).toEqual([]);
  });

  it("drains a restored queue from fresh history metadata despite stale sessions errors", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("main", { hasActiveRun: false, status: "done" }),
        };
      }
      return {};
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      sessionsError: "old sessions.list failure",
      chatQueue: [{ id: "queued-1", text: "after stale error", createdAt: 1 }],
    });

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "main",
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
          sessionInfo: row("main", { hasActiveRun: true, status: "running" }),
        };
      }
      return {};
    });
    const restoredQueue = [{ id: "queued-1", text: "after active run", createdAt: 1 }];
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatQueue: restoredQueue,
    });

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toEqual(restoredQueue);
    expect(host.chatRunId).toBeNull();
  });

  it("keeps a restored queue when stale history says a newer active row is idle", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return {
          messages: [],
          sessionInfo: row("main", {
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
      sessionKey: "main",
      chatQueue: restoredQueue,
      sessionsResult: createSessionsResult([
        row("main", {
          hasActiveRun: true,
          status: "running",
          updatedAt: 10,
          startedAt: 9,
        }),
      ]),
    });

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toEqual(restoredQueue);
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
      sessionKey: "main",
      chatQueue: restoredQueue,
      sessionsResult: createSessionsResult([row("main", { hasActiveRun: false, status: "done" })]),
    });

    await refreshChat(host, { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatQueue).toEqual(restoredQueue);
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

    host.chatQueueBySession = { "agent:main": [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    settingsPatch.resolve(true);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueueBySession?.["agent:main"]?.[0]).toMatchObject({
      sendState: undefined,
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
        return { messages: [] };
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

    await handleSendChat(host);

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
    host.chatQueueBySession = { global: [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:work:main";

    globalPatch.resolve(true);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueueBySession.global?.[0]).toMatchObject({
      sendState: undefined,
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

    host.chatQueueBySession = { "agent:main": [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    host.chatMessage = "session b draft";
    switchUpdate.resolve(true);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("session b draft");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatQueueBySession?.["agent:main"]?.[0]).toMatchObject({
      sendState: undefined,
      text: "send from session a",
    });
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
    host.chatQueueBySession = { "agent:main": [...host.chatQueue] };
    host.chatQueue = [];
    host.sessionKey = "agent:other";
    host.chatMessage = "";

    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatQueueBySession?.["agent:main"]?.[0]).toMatchObject({
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
    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "retry with new settings",
    });

    settingsPatch.resolve(true);
    await retry;

    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("keeps a queued retry failed when its pending settings patch fails", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
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

    expect(request).not.toHaveBeenCalled();
    expect(host.chatQueue[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text: "do not retry stale settings",
    });
  });

  it("drains a foreground retry after the in-flight send fails", async () => {
    const foregroundAck = createDeferred<{ runId: string; status: "error" }>();
    const request = vi.fn((method: string, params?: unknown) => {
      if (method !== "chat.send") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const payload = requireRecord(params, "foreground retry send");
      return payload.message === "new foreground send"
        ? foregroundAck.promise
        : Promise.resolve({ runId: "retry-run", status: "started" });
    });
    const host = makeHost({
      chatMessage: "new foreground send",
      chatQueue: [
        {
          id: "retry-send",
          text: "retry after failure",
          createdAt: 1,
          sendError: "previous failure",
          sendRunId: "retry-run",
          sendState: "failed",
          sessionKey: "agent:main",
        },
      ],
      client: { request } as unknown as ChatHost["client"],
    });

    const foreground = handleSendChat(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await retryQueuedChatMessage(host, "retry-send");

    expect(request).toHaveBeenCalledTimes(1);
    expect(host.chatQueue.find((item) => item.id === "retry-send")?.sendState).toBeUndefined();

    foregroundAck.resolve({ runId: "foreground-run", status: "error" });
    await foreground;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(requireRecord(request.mock.calls[1]?.[1], "rescheduled retry").message).toBe(
      "retry after failure",
    );
    expect(host.chatQueue.some((item) => item.id === "retry-send")).toBe(false);
  });

  it("does not overlap reconnect replay with a send started during its settings wait", async () => {
    const settingsPatch = createDeferred<boolean>();
    const foregroundAck = createDeferred<{ runId: string; status: "started" }>();
    const request = vi.fn((method: string, params?: unknown) => {
      if (method === "chat.send") {
        const payload = requireRecord(params, "reconnect admission send");
        return payload.sessionKey === "agent:main"
          ? foregroundAck.promise
          : Promise.resolve({ runId: "reconnect-run", status: "started" });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      chatQueueBySession: {
        "agent:other": [
          {
            id: "reconnect-send",
            text: "replay after the active request",
            createdAt: 1,
            sendRunId: "reconnect-run",
            sendState: "waiting-reconnect",
            sessionKey: "agent:other",
          },
        ],
      },
      chatMessage: "foreground request",
      client: { request } as unknown as ChatHost["client"],
      pendingSettingsPatches: { "agent:other": settingsPatch.promise },
      sessionKey: "agent:main",
    });

    const replay = retryReconnectableQueuedChatSends(host);
    expect(await raceWithMacrotask(replay)).toBe("pending");
    const foreground = handleSendChat(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    settingsPatch.resolve(true);
    await replay;

    expect(request).toHaveBeenCalledTimes(1);
    expect(host.chatQueueBySession?.["agent:other"]?.[0]).toMatchObject({
      sendState: "waiting-reconnect",
      text: "replay after the active request",
    });

    foregroundAck.resolve({ runId: "foreground-run", status: "started" });
    await foreground;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(requireRecord(request.mock.calls[1]?.[1], "rescheduled reconnect send").sessionKey).toBe(
      "agent:other",
    );
    expect(host.chatQueueBySession?.["agent:other"] ?? []).toStrictEqual([]);
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

  it("shows local slash-command feedback when the gateway client is unavailable", async () => {
    const host = makeHost({
      client: null,
      chatMessage: "/think",
      connected: true,
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
    expect(host.chatMessages).toHaveLength(1);
    const feedback = requireRecord(host.chatMessages[0], "feedback message");
    expect(feedback.role).toBe("system");
    expect(feedback.content).toBe(
      "Cannot run `/think`: Control UI is not connected to the Gateway.",
    );
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
    const host = makeHost({
      chatMessage: "queued while busy",
      chatRunId: "run-1",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("queued while busy");
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("queued while busy");
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

    expect(request).toHaveBeenCalledTimes(1);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("same prompt");
    expect(host.chatQueue[0]?.sendState).toBe("sending");
    expect(host.chatMessages).toStrictEqual([]);

    const queuedRunId = host.chatQueue[0]?.sendRunId;
    sent.resolve({ runId: queuedRunId, status: "started" });
    await Promise.all([first, second]);

    expect(request).toHaveBeenCalledTimes(1);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatMessages).toHaveLength(1);
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

    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe(runId);
    expect(host.chatMessages).toHaveLength(1);
    const userMessage = requireRecord(host.chatMessages[0], "user message");
    expect(userMessage.role).toBe("user");
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

    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatMessages).toHaveLength(1);
    const userMessage = requireRecord(host.chatMessages[0], "user message");
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toEqual([{ type: "text", text: "Make the support files 5" }]);
  });

  it("keeps a settings-blocked Skill Workshop revision retryable", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
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
    expect(host.chatQueue).toStrictEqual([]);
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

    expect(host.chatMessages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "/reset examples" }],
    });
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

    host.chatQueueBySession = { "agent:a": [...host.chatQueue] };
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
    expect(host.chatQueueBySession?.["agent:a"]).toBeUndefined();
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

  it("replays queued global sends under the originally selected agent", async () => {
    const request = vi.fn((method: string) => {
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
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("defers queued global send agent selection until defaults are known", async () => {
    const request = vi.fn((method: string) => {
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
  });

  it("marks saved session queued sends waiting after a disconnect", () => {
    const host = makeHost({
      chatQueue: [],
      chatQueueBySession: {
        "agent:a": [
          {
            id: "pending-send-a",
            text: "pending",
            createdAt: 1,
            sendRunId: "run-a",
            sendState: "sending",
            sessionKey: "agent:a",
          },
        ],
      },
    });

    markQueuedChatSendsWaitingForReconnect(host);

    expect(host.chatQueueBySession?.["agent:a"]?.[0]).toMatchObject({
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
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatStream: "Working...",
      chatQueue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
      sessionKey: "agent:main:main",
    });

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

  it("removes queued steer indicators when chat.send returns terminal ok", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "ok", runId: "steer-ok" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatStream: "Working...",
      chatQueue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
      sessionKey: "agent:main:main",
    });

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
        return { status: "started", runId: "run-1" };
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
