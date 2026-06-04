/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHost } from "./app-chat.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
  resetChatAttachmentPayloadStoreForTest,
} from "./chat/attachment-payload-store.ts";
import type { executeSlashCommand } from "./chat/slash-command-executor.ts";
import { loadSessions } from "./controllers/sessions.ts";
import type { GatewaySessionRow, SessionsListResult } from "./types.ts";

type ExecuteSlashCommand = typeof executeSlashCommand;

const { executeSlashCommandMock, setLastActiveSessionKeyMock } = vi.hoisted(() => ({
  executeSlashCommandMock: vi.fn(),
  setLastActiveSessionKeyMock: vi.fn(),
}));

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

vi.mock("./app-last-active-session.ts", () => ({
  setLastActiveSessionKey: (...args: unknown[]) => setLastActiveSessionKeyMock(...args),
}));

vi.mock("./chat/slash-command-executor.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat/slash-command-executor.ts")>();
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

let handleSendChat: typeof import("./app-chat.ts").handleSendChat;
let steerQueuedChatMessage: typeof import("./app-chat.ts").steerQueuedChatMessage;
let navigateChatInputHistory: typeof import("./app-chat.ts").navigateChatInputHistory;
let handleAbortChat: typeof import("./app-chat.ts").handleAbortChat;
let hasAbortableSessionRun: typeof import("./app-chat.ts").hasAbortableSessionRun;
let refreshChat: typeof import("./app-chat.ts").refreshChat;
let refreshChatAvatar: typeof import("./app-chat.ts").refreshChatAvatar;
let clearPendingQueueItemsForRun: typeof import("./app-chat.ts").clearPendingQueueItemsForRun;
let removeQueuedMessage: typeof import("./app-chat.ts").removeQueuedMessage;
let markQueuedChatSendsWaitingForReconnect: typeof import("./app-chat.ts").markQueuedChatSendsWaitingForReconnect;
let retryReconnectableQueuedChatSends: typeof import("./app-chat.ts").retryReconnectableQueuedChatSends;
let recordChatSendServerTiming: typeof import("./app-chat.ts").recordChatSendServerTiming;

async function loadChatHelpers(): Promise<void> {
  ({
    handleSendChat,
    steerQueuedChatMessage,
    navigateChatInputHistory,
    handleAbortChat,
    hasAbortableSessionRun,
    refreshChat,
    refreshChatAvatar,
    clearPendingQueueItemsForRun,
    removeQueuedMessage,
    markQueuedChatSendsWaitingForReconnect,
    retryReconnectableQueuedChatSends,
    recordChatSendServerTiming,
  } = await import("./app-chat.ts"));
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

function eventPayloads(host: ChatHost, event: string): Array<Record<string, unknown>> {
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

function makeHost(overrides?: Partial<ChatHost>): ChatHost {
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
    sessionsFilterActive: "0",
    sessionsFilterLimit: "50",
    sessionsIncludeGlobal: true,
    sessionsIncludeUnknown: true,
    sessionsShowArchived: false,
    sessionsExpandedCheckpointKey: null,
    sessionsCheckpointItemsByKey: {},
    sessionsCheckpointLoadingKey: null,
    sessionsCheckpointBusyKey: null,
    sessionsCheckpointErrorByKey: {},
    chatModelOverrides: {},
    chatModelSwitchPromises: {},
    chatModelsLoading: false,
    chatModelCatalog: [],
    refreshSessionsAfterChat: new Map(),
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    updateComplete: Promise.resolve(),
    ...overrides,
  };
  return host as ChatHost;
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

  it("dispatches chat refresh work without waiting for slow history or metadata RPCs", async () => {
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
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "main" }),
    );
    expect(request).not.toHaveBeenCalledWith("models.list", { view: "configured" });
    expect(request).not.toHaveBeenCalledWith("commands.list", expect.anything());
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
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "work" }),
    );
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

  it("can wait for history without waiting for secondary metadata refreshes", async () => {
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
    expect(request).not.toHaveBeenCalledWith("models.list", { view: "configured" });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "main" }),
    );
    expect(request).not.toHaveBeenCalledWith("models.list", { view: "configured" });
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
    (host as ChatHost & { sessionsResultAgentId: string }).sessionsResultAgentId = "main";

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
    (host as ChatHost & { sessionsResultAgentId: string }).sessionsResultAgentId = "main";

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

  it("does not wait for secondary chat metadata refreshes before showing history", async () => {
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
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "main" }),
      );
      expect(request).not.toHaveBeenCalledWith("models.list", { view: "configured" });
      expect(request).not.toHaveBeenCalledWith("commands.list", expect.anything());
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("falls back to separate metadata RPCs when chat.metadata is not advertised", async () => {
    const request = vi.fn(() => pendingPromise());
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: [] },
        features: { events: [], methods: ["chat.history"] },
      },
    });

    await refreshChat(host);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.list", { view: "configured" }),
    );
    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      includeArgs: true,
      scope: "text",
    });
    expect(request).not.toHaveBeenCalledWith("chat.metadata", expect.anything());
  });

  it("falls back to separate metadata RPCs when an older gateway rejects chat.metadata", async () => {
    const { GatewayRequestError } = await import("./gateway.ts");
    const request = vi.fn((method: string) => {
      if (method === "chat.metadata") {
        return Promise.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "unknown method: chat.metadata",
          }),
        );
      }
      return pendingPromise();
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
    });

    await refreshChat(host);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.list", { view: "configured" }),
    );
    expect(request).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      includeArgs: true,
      scope: "text",
    });
  });

  it("ignores stale chat.metadata results after the selected global agent changes", async () => {
    const { resetSlashCommandsForTest, SLASH_COMMANDS } = await import("./chat/slash-commands.ts");
    resetSlashCommandsForTest();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as never;
    const metadata = createDeferred<unknown>();
    const requestUpdate = vi.fn();
    try {
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return Promise.resolve({ messages: [], thinkingLevel: null });
        }
        if (method === "chat.metadata") {
          return metadata.promise;
        }
        return pendingPromise();
      });
      const host = makeHost({
        client: { request } as unknown as ChatHost["client"],
        sessionKey: "global",
        assistantAgentId: "work",
        requestUpdate,
      });

      await refreshChat(host);
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "work" }),
      );
      host.assistantAgentId = "ops";
      const updatesBeforeMetadata = requestUpdate.mock.calls.length;
      metadata.resolve({
        models: [{ id: "stale-model", name: "Stale Model", provider: "stale-provider" }],
        commands: [
          {
            acceptsArgs: false,
            description: "stale command",
            name: "stale-command",
            scope: "text",
            source: "native",
            textAliases: ["/stale-command"],
          },
        ],
      });

      await vi.waitFor(() =>
        expect(requestUpdate.mock.calls.length).toBeGreaterThan(updatesBeforeMetadata),
      );
      expect(host.chatModelCatalog).toEqual([]);
      expect(SLASH_COMMANDS.some((command) => command.name === "stale-command")).toBe(false);
    } finally {
      resetSlashCommandsForTest();
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
    const onSlashAction = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "restore me",
      sessionKey: "agent:main",
      onSlashAction,
    });

    await handleSendChat(host, "/new", { confirmReset: true, restoreDraft: true });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(onSlashAction).toHaveBeenCalledWith("new-session");
    expect(host.chatMessage).toBe("restore me");
    expect(host.refreshSessionsAfterChat.size).toBe(0);
  });

  it("routes typed /new through the fresh-session action without confirmation", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const onSlashAction = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/new",
      sessionKey: "agent:main",
      onSlashAction,
    });

    await handleSendChat(host);

    expect(confirm).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(onSlashAction).toHaveBeenCalledWith("new-session");
    expect(host.chatMessage).toBe("");
  });

  it("does not queue typed /new behind an active run", async () => {
    const onSlashAction = vi.fn();
    const host = makeHost({
      chatMessage: "/new",
      chatRunId: "run-main",
      chatStream: "Working...",
      onSlashAction,
    });

    await handleSendChat(host);

    expect(onSlashAction).toHaveBeenCalledWith("new-session");
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
      tab: "debug",
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
      tab: "debug",
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
      tab: "debug",
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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

  it("does not wait on model picker updates from another session", async () => {
    const otherSessionSwitch = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "agent:other",
      chatMessage: "send in other session",
      chatModelSwitchPromises: { "agent:main": otherSessionSwitch.promise },
    });

    await handleSendChat(host);

    const payload = findRequestPayload(
      request as unknown as MockCallSource,
      "chat.send",
      "chat send payload",
    );
    expect(payload.sessionKey).toBe("agent:other");
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("do not send on rollback");
  });

  it("does not restore canceled attachments onto new draft text after model update failure", async () => {
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "new unrelated draft";

    switchUpdate.resolve(false);
    await send;

    expect(request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("new unrelated draft");
    expect(host.chatAttachments).toStrictEqual([]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("does not restore a manually removed model-wait send after model update failure", async () => {
    const switchUpdate = createDeferred<boolean>();
    const request = vi.fn(async (method: string) => {
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "remove this pending send",
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
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
      sendError: "Model selection was interrupted. Review and retry when ready.",
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
      chatModelSwitchPromises: { "agent:main": switchUpdate.promise },
      eventLogBuffer: [],
      tab: "debug",
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
    const onSlashAction = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
      onSlashAction,
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(host.chatModelOverrides.main).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
    expect(onSlashAction).toHaveBeenCalledWith("refresh-tools-effective");
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

  it("keeps ACK-completed sends idle when sessions.list returns a stale active row", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "chat.send") {
        const payload = requireRecord(params, "chat send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      if (method === "sessions.list") {
        return createSessionsResult([
          row("agent:main", { hasActiveRun: true, status: "running", startedAt: 1 }),
        ]);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "already done",
      sessionsResult: createSessionsResult([
        row("agent:main", { hasActiveRun: true, status: "running", startedAt: 1 }),
      ]),
    });

    await handleSendChat(host);
    await Promise.resolve();
    await loadSessions(host as unknown as Parameters<typeof loadSessions>[0]);

    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(hasAbortableSessionRun(host)).toBe(false);
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
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
      tab: "debug",
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
  vi.doUnmock("./app-last-active-session.ts");
  vi.resetModules();
});
