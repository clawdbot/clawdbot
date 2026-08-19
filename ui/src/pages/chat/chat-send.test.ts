/* @vitest-environment jsdom */

import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { rememberChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  buildFallbackSlashCommands,
  buildSlashCommandsFromEntries,
  replaceSlashCommands,
} from "../../lib/chat/commands.ts";
import { createResolvedModelPatch } from "../../test-helpers/chat-model.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload as registerStoredChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { refreshChatAvatar } from "./chat-avatar.ts";
import * as chatCommandExecutor from "./chat-command-executor.ts";
import type { executeSlashCommand } from "./chat-command-executor.ts";
import { makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import { UNCONFIRMED_CHAT_SEND_ERROR } from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import {
  getPendingChatPickerPatch,
  switchChatFastMode,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  loadChatComposerSnapshot,
  removeStoredChatComposerQueueItem,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
import { getChatSessionProjection, setChatSessionProjection } from "./history-merge.ts";
import { handleChatInputHistoryKey } from "./input-history.ts";
import {
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";

type ExecuteSlashCommand = typeof executeSlashCommand;
type TestChatHost = ReturnType<typeof makeChatHost>;

function clientWithRequest(request: GatewayRequestHandler): NonNullable<ChatHost["client"]> {
  return createTestGatewayClient(request);
}

function asChatPageHost(host: TestChatHost): ChatPageHost {
  return host as ChatPageHost;
}

function writeChatQueueForScope(
  host: TestChatHost,
  sessionKey: string,
  queue: ChatQueueItem[],
  agentId?: string,
): void {
  const scope = resolveStoredChatOutboxScope(host, sessionKey, agentId);
  chatOutboxOwner(host).replace(host, scope, queue);
}

function setTransientQueuedMessageProjection(
  host: TestChatHost,
  sessionKey: string,
  item: ChatQueueItem,
): boolean {
  const owner = chatOutboxOwner(host);
  const scope = resolveStoredChatOutboxScope(host, sessionKey, item.agentId);
  if (!owner.durable(host, item.id)) {
    return false;
  }
  owner.projectLive(host, scope, item.id, item);
  return true;
}

function requireChatMessageCache(host: ChatHost): ChatMessageCache {
  if (!host.chatMessagesBySession) {
    throw new Error("Expected chat message cache");
  }
  return host.chatMessagesBySession;
}

function cacheChatMessages(
  cache: ChatMessageCache,
  host: Parameters<typeof cacheChatSessionSnapshot>[1],
  target: Parameters<typeof cacheChatSessionSnapshot>[2],
  messages: unknown[],
): void {
  cacheChatSessionSnapshot(cache, host, target, {
    messages,
    pagination: { hasMore: false },
    sessionId: null,
  });
}

function cacheEmptyChatSnapshot(host: ChatHost, sessionKey: string): void {
  cacheChatSessionSnapshot(
    requireChatMessageCache(host),
    host,
    { sessionKey },
    {
      messages: [],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "cached-session",
    },
  );
}

function createQueuedLocalCommand(
  id: string,
  text: string,
  options: { createdAt?: number; sessionKey?: string } = {},
) {
  const [name, ...args] = text.slice(1).split(" ");
  return {
    id,
    text,
    createdAt: options.createdAt ?? 1,
    localCommandArgs: args.join(" "),
    localCommandName: name ?? "",
    sessionKey: options.sessionKey ?? "agent:main",
  };
}

const executeSlashCommandMock = vi.fn();
const executeSlashCommandActual = chatCommandExecutor.executeSlashCommand;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const registeredAttachmentPayloads = new Map<
  string,
  ReturnType<typeof registerStoredChatAttachmentPayload>
>();

function registerChatAttachmentPayload(
  params: Parameters<typeof registerStoredChatAttachmentPayload>[0],
) {
  const attachment = registerStoredChatAttachmentPayload(params);
  registeredAttachmentPayloads.set(attachment.id, attachment);
  return attachment;
}

beforeEach(() => {
  executeSlashCommandMock.mockReset();
  vi.spyOn(chatCommandExecutor, "executeSlashCommand").mockImplementation((...args) => {
    const implementation = executeSlashCommandMock.getMockImplementation() as
      | ExecuteSlashCommand
      | undefined;
    return implementation ? executeSlashCommandMock(...args) : executeSlashCommandActual(...args);
  });
});

afterEach(() => {
  releaseChatAttachmentPayloads([...registeredAttachmentPayloads.values()]);
  registeredAttachmentPayloads.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let handleSendChat: typeof import("./chat-send-submit.ts").handleSendChat;
let steerQueuedChatMessage: typeof import("./chat-send-actions.ts").steerQueuedChatMessage;
let handleAbortChat: typeof import("./run-lifecycle.ts").handleAbortChat;
let hasAbortableSessionRun: typeof import("./run-lifecycle.ts").hasAbortableSessionRun;
let handlePageGatewayEvent: typeof import("./chat-state-events.ts").handlePageGatewayEvent;
let loadChatBranches: typeof import("./chat-history.ts").loadChatBranches;
let loadChatHistory: typeof import("./chat-history.ts").loadChatHistory;
let clearPendingQueueItemsForRun: typeof import("./chat-queue.ts").clearPendingQueueItemsForRun;
let admitQueuedMessageForSession: typeof import("./chat-queue.ts").admitQueuedMessageForSession;
let removeQueuedMessage: typeof import("./chat-queue.ts").removeQueuedMessage;
let removeDeliveredQueuedChatSendForRun: typeof import("./chat-queue.ts").removeDeliveredQueuedChatSendForRun;
let removeVisibleOrScopedQueuedMessageWithoutReleasing: typeof import("./chat-queue.ts").removeVisibleOrScopedQueuedMessageWithoutReleasing;
let markQueuedChatSendsWaitingForReconnect: typeof import("./chat-queue.ts").markQueuedChatSendsWaitingForReconnect;
let subscribeChatOutboxProjection: typeof import("./chat-queue.ts").subscribeChatOutboxProjection;
let syncVisibleChatQueueProjection: typeof import("./chat-queue.ts").syncVisibleChatQueueProjection;
let readChatQueueForScope: typeof import("./chat-queue.ts").readChatQueueForScope;
let flushChatQueueForEvent: typeof import("./chat-send-actions.ts").flushChatQueueForEvent;
let retryReconnectableQueuedChatSends: typeof import("./chat-send-actions.ts").retryReconnectableQueuedChatSends;
let retryQueuedChatMessage: typeof import("./chat-send-actions.ts").retryQueuedChatMessage;
let recordChatSendServerTiming: typeof import("./chat-send-timing.ts").recordChatSendServerTiming;
let beginQueuedMessageEdit: typeof import("./queued-message-edit.ts").beginQueuedMessageEdit;
let refreshPageChat: typeof import("./chat-state-refresh.ts").refreshPageChat;

async function loadChatHelpers(): Promise<void> {
  ({
    steerQueuedChatMessage,
    flushChatQueueForEvent,
    retryReconnectableQueuedChatSends,
    retryQueuedChatMessage,
  } = await import("./chat-send-actions.ts"));
  ({ handleSendChat } = await import("./chat-send-submit.ts"));
  ({ recordChatSendServerTiming } = await import("./chat-send-timing.ts"));
  ({ beginQueuedMessageEdit } = await import("./queued-message-edit.ts"));
  ({ handlePageGatewayEvent } = await import("./chat-state-events.ts"));
  ({ refreshPageChat } = await import("./chat-state-refresh.ts"));
  ({ loadChatBranches, loadChatHistory } = await import("./chat-history.ts"));
  ({ handleAbortChat, hasAbortableSessionRun } = await import("./run-lifecycle.ts"));
  ({
    admitQueuedMessageForSession,
    clearPendingQueueItemsForRun,
    removeDeliveredQueuedChatSendForRun,
    removeQueuedMessage,
    markQueuedChatSendsWaitingForReconnect,
    removeVisibleOrScopedQueuedMessageWithoutReleasing,
    readChatQueueForScope,
    subscribeChatOutboxProjection,
    syncVisibleChatQueueProjection,
  } = await import("./chat-queue.ts"));
}

function navigateChatInputHistory(host: TestChatHost, direction: "up" | "down"): boolean {
  return handleChatInputHistoryKey(host, {
    key: direction === "up" ? "ArrowUp" : "ArrowDown",
    selectionStart: 0,
    selectionEnd: 0,
    valueLength: host.chatMessage.length,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: direction === "up" ? 38 : 40,
  }).handled;
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

function createJsonResponse(body: unknown, options: { ok?: boolean } = {}): Response {
  const response = new Response(null, { status: options.ok === false ? 500 : 200 });
  response.json = async () => await body;
  return response;
}

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

const requireRecord = createRequireRecord("object", "expected-label");

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
  for (const item of host.chatQueue) {
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

async function completesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

describe("refreshChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("requestIdleCallback", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches chat refresh work without waiting for slow history RPCs", async () => {
    const requestUpdate = vi.fn();
    const host = makeChatHost({
      requestHandlers: {
        "sessions.branches.list": () => pendingPromise(),
        "chat.history": () => pendingPromise(),
      },
      sessionKey: "main",
      requestUpdate,
    });

    const refresh = refreshPageChat(asChatPageHost(host));

    expect(await raceWithMacrotask(refresh)).toBe("resolved");
    expect(host.chatLoading).toBe(true);
    expect(host.request).toHaveBeenCalledWith("chat.history", { sessionKey: "main", limit: 100 });
    expect(host.request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
    expect(requestUpdate).not.toHaveBeenCalled();
  });

  it("uses prepared models delivered with startup metadata", async () => {
    const startup = createDeferred<unknown>();
    const host = makeChatHost({
      hello: gatewayHelloForMethods(["chat.metadata", "chat.startup"], []),
      requestHandlers: {
        "chat.startup": () => startup.promise,
      },
    });

    const refresh = refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      deferBranches: true,
      startup: true,
    });

    expect(host.request.mock.calls.map(([method]) => method)).toEqual(["chat.startup"]);
    expect(await raceWithMacrotask(refresh)).toBe("pending");

    startup.resolve({
      messages: [],
      metadata: {
        commands: [],
        models: [
          {
            available: true,
            id: "startup-model",
            name: "Startup Model",
            provider: "openai",
          },
        ],
      },
    });
    await expect(refresh).resolves.toBeUndefined();
    await waitForFast(() =>
      expect(host.chatModelCatalog).toEqual([
        {
          available: true,
          id: "startup-model",
          name: "Startup Model",
          provider: "openai",
        },
      ]),
    );
    expect(host.request).not.toHaveBeenCalledWith("chat.metadata", expect.anything());
    expect(host.request).not.toHaveBeenCalledWith("models.list", expect.anything());
    expect(host.request).not.toHaveBeenCalledWith("commands.list", expect.anything());
  });

  it("renders cached models while startup metadata refreshes", async () => {
    const startup = createDeferred<unknown>();
    const host = makeChatHost({
      chatModelSwitchPromises: {},
      hello: gatewayHelloForMethods(["chat.metadata", "chat.startup"], []),
      requestHandlers: {
        "chat.startup": () => startup.promise,
      },
    });
    const cachedModel = {
      available: true,
      id: "cached-model",
      name: "Cached Model",
      provider: "openai",
    };
    rememberChatMetadata(expectDefined(host.client, "chat host client"), "main", {
      commands: [],
      models: [cachedModel],
    });

    const refresh = refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      deferBranches: true,
      startup: true,
    });

    expect(host.chatModelCatalog).toEqual([cachedModel]);
    expect(asChatPageHost(host).chatModelsLoading).toBe(true);
    const container = document.createElement("div");
    const controls = renderChatPaneComposerControls({
      state: asChatPageHost(host),
      selectedSession: undefined,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });
    render(controls.composerControls, container);
    expect(container.querySelector('[data-chat-model-catalog-state="refreshing"]')).not.toBeNull();
    expect(container.textContent).toContain("Refreshing models…");
    expect(container.textContent).not.toContain("Loading models…");

    startup.resolve({
      messages: [],
      metadata: {
        commands: [],
        models: [{ ...cachedModel, id: "fresh-model", name: "Fresh Model" }],
      },
    });
    await expect(refresh).resolves.toBeUndefined();
    await waitForFast(() =>
      expect(host.chatModelCatalog).toEqual([
        { ...cachedModel, id: "fresh-model", name: "Fresh Model" },
      ]),
    );
  });

  it.each([
    [
      "selected global agent",
      { sessionKey: "global", assistantAgentId: "work", agentsList: { defaultId: "main" } },
      { sessionKey: "global", agentId: "work", limit: 100 },
    ],
    [
      "agent main alias",
      { sessionKey: "agent:work:main", agentsList: { defaultId: "main", mainKey: "main" } },
      { sessionKey: "agent:work:main", agentId: "work", limit: 100 },
    ],
    [
      "agent session",
      {
        sessionKey: "agent:work:dashboard",
        agentsList: { defaultId: "main", mainKey: "main" },
      },
      { sessionKey: "agent:work:dashboard", limit: 100 },
    ],
    [
      "hello default before the agents list loads",
      {
        sessionKey: "global",
        hello: {
          ...gatewayHelloForMethods([], []),
          snapshot: { sessionDefaults: { defaultAgentId: "ops" } },
        },
      },
      { sessionKey: "global", agentId: "ops", limit: 100 },
    ],
    [
      "unknown session",
      { sessionKey: "unknown", assistantAgentId: "work", agentsList: { defaultId: "main" } },
      { sessionKey: "unknown", limit: 100 },
    ],
  ])("scopes history for %s", async (_name, overrides, expected) => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => pendingPromise(),
      },
      ...overrides,
    });

    expect(await raceWithMacrotask(refreshPageChat(asChatPageHost(host)))).toBe("resolved");
    expect(host.request).toHaveBeenCalledWith("chat.history", expected);
    expect(host.request).not.toHaveBeenCalledWith("sessions.list", expect.anything());
  });

  it("can await history without waiting for secondary refresh work", async () => {
    const history = createDeferred<unknown>();
    const requestUpdate = vi.fn();

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => history.promise,
      },
      sessionKey: "main",
      requestUpdate,
    });
    const refresh = refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      scheduleScroll: false,
    });
    expect(await raceWithMacrotask(refresh)).toBe("pending");

    history.resolve({
      messages: [{ role: "assistant", content: [{ type: "text", text: "ready" }] }],
    });
    await expect(refresh).resolves.toBeUndefined();
    expect(host.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "ready" }] },
    ]);
    expect(requestUpdate).toHaveBeenCalled();
  });

  it("keeps the routed archived descriptor when history confirms archive state", async () => {
    const key = "agent:main:dashboard:archived";
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row(key, {
            archived: true,
            sessionId: "archived-session",
          }),
        },
      },
      sessionKey: key,
      sessionsResult: createSessionsResult([
        row(key, {
          derivedTitle: "Readable archived title",
          sessionId: "archived-session",
        }),
      ]),
    });

    await refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      scheduleScroll: false,
    });

    expect(asChatPageHost(host).selectedChatSessionArchived).toBe(true);
    expect(host.sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key,
        archived: true,
        derivedTitle: "Readable archived title",
      }),
    ]);
  });

  it("keeps an active run adopted from history over newer stale catalog metadata", async () => {
    const runId = "run-restored";
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          inFlightRun: { runId, text: "Still working after navigation." },
          sessionInfo: row("main", {
            activeRunIds: [runId],
            hasActiveRun: true,
            status: "running",
            updatedAt: 1,
          }),
        },
      },
      sessionKey: "main",
      sessionsResult: createSessionsResult([
        row("main", { hasActiveRun: false, status: "done", updatedAt: 10 }),
      ]),
    });

    await refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      scheduleScroll: false,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(host.chatRunId).toBe(runId);
    expect(host.chatStream).toBe("Still working after navigation.");
    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
      updatedAt: 10,
    });
  });

  it("reconciles queued history over a prior terminal session row", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("main", {
            hasActiveRun: true,
            status: "queued",
            updatedAt: 11,
          }),
        },
      },
      sessionKey: "main",
      sessionsResult: createSessionsResult([
        row("main", { hasActiveRun: false, status: "failed", updatedAt: 10 }),
      ]),
    });

    await refreshPageChat(asChatPageHost(host), {
      awaitHistory: true,
      scheduleScroll: false,
    });

    expect(host.sessionsResult?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      status: "queued",
      updatedAt: 11,
    });
  });

  it.each([
    {
      name: "drains a restored queue after history proves the selected session is idle",
      history: () => idleChatHistory("agent:main:dashboard"),
      overrides: { sessionKey: "agent:main:dashboard" },
      message: "after reload",
      expectedSend: { sessionKey: "agent:main:dashboard", message: "after reload" },
    },
    {
      name: "drains a restored queue from history metadata when rows are scoped elsewhere",
      history: () => idleChatHistory("agent:work:dashboard"),
      overrides: {
        sessionKey: "agent:work:dashboard",
        sessionsResult: createSessionsResult([
          row("agent:main:main", { hasActiveRun: false, status: "done" }),
        ]),
        sessionsResultAgentId: "main",
      },
      message: "after scoped reload",
      expectedSend: { sessionKey: "agent:work:dashboard", message: "after scoped reload" },
      preservesSessionsResult: true,
    },
    {
      name: "drains a restored queue when global history answers an agent main alias",
      history: {
        messages: [],
        sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
      },
      overrides: {
        sessionKey: "agent:work:main",
        agentsList: { defaultId: "main", mainKey: "main" },
        sessionsResult: createSessionsResult([
          row("agent:main:main", { hasActiveRun: false, status: "done" }),
        ]),
        sessionsResultAgentId: "main",
      },
      message: "after global alias reload",
      expectedSend: { sessionKey: "global", agentId: "work", message: "after global alias reload" },
    },
    {
      name: "drains a restored queue despite stale session-list errors",
      history: () => idleChatHistory("agent:main:dashboard"),
      overrides: {
        sessionKey: "agent:main:dashboard",
        sessionsError: "old sessions.list failure",
      },
      message: "after stale error",
      expectedSend: { message: "after stale error" },
    },
  ])("$name", async ({ history, overrides, message, expectedSend, preservesSessionsResult }) => {
    const previousSessionsResult = overrides.sessionsResult;
    const host = makeChatHost({
      ...overrides,
      requestHandlers: {
        "chat.history": history,
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "restored send payload");
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      },
      chatQueue: [{ id: "queued-1", text: message, createdAt: 1 }],
    });
    admitHostQueueItems(host);

    await refreshPageChat(asChatPageHost(host), { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    if (preservesSessionsResult) {
      expect(host.sessionsResult).toBe(previousSessionsResult);
    }
    expect(host.request).toHaveBeenCalledWith("chat.send", expect.objectContaining(expectedSend));
    expect(host.chatQueue).toEqual([]);
  });

  it.each([
    {
      name: "keeps a restored queue while the selected session is active",
      history: {
        messages: [],
        sessionInfo: row("agent:main:dashboard", { hasActiveRun: true, status: "running" }),
      },
      text: "after active run",
    },
    {
      name: "keeps a restored queue when newer session state is active",
      history: {
        messages: [],
        sessionInfo: row("agent:main:dashboard", {
          hasActiveRun: false,
          status: "done",
          updatedAt: 5,
        }),
      },
      text: "after active run",
      sessionsResult: createSessionsResult([
        row("agent:main:dashboard", {
          hasActiveRun: true,
          status: "running",
          updatedAt: 10,
          startedAt: 9,
        }),
      ]),
      expectedSession: { hasActiveRun: true, status: "running", updatedAt: 10 },
    },
    {
      name: "keeps a restored queue when history omits selected-session metadata",
      history: { messages: [] },
      text: "after reload",
      sessionsResult: createSessionsResult([
        row("agent:main:dashboard", { hasActiveRun: false, status: "done" }),
      ]),
    },
  ])("$name", async ({ history, text, sessionsResult, expectedSession }) => {
    const restoredQueue = [{ id: "queued-1", text, createdAt: 1 }];
    const host = makeChatHost({
      requestHandlers: { "chat.history": history },
      sessionKey: "agent:main:dashboard",
      chatQueue: restoredQueue,
      sessionsResult,
    });
    admitHostQueueItems(host);

    await refreshPageChat(asChatPageHost(host), { scheduleScroll: false });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toEqual([expect.objectContaining(restoredQueue[0])]);
    if (expectedSession) {
      expect(host.sessionsResult?.sessions[0]).toMatchObject(expectedSession);
    }
  });
});

describe("refreshChatAvatar", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  const pairedDeviceHello = gatewayHelloForMethods([], []);

  it.each([
    {
      name: "uses a route-relative avatar endpoint before basePath bootstrap finishes",
      resourceBasePath: "",
      objectUrl: "blob:local-avatar",
      expectedToken: undefined,
      overrides: {},
    },
    {
      name: "prefers the paired device token for avatar metadata and local avatar URLs",
      resourceBasePath: "/openclaw/",
      objectUrl: "blob:device-avatar",
      expectedToken: "device-token",
      overrides: {
        settings: { token: "session-token" },
        password: "shared-password",
        hello: {
          ...pairedDeviceHello,
          auth: { ...pairedDeviceHello.auth, deviceToken: "device-token" },
        },
      },
    },
    {
      name: "fetches local avatars through Authorization headers instead of tokenized URLs",
      resourceBasePath: "/openclaw/",
      objectUrl: "blob:session-avatar",
      expectedToken: "session-token",
      overrides: { settings: { token: "session-token" } },
    },
  ])("$name", async ({ resourceBasePath, objectUrl, expectedToken, overrides }) => {
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const metadataUrl = `${resourceBasePath.replace(/\/$/, "")}/avatar/main?meta=1`;
    const fetchMock = vi.fn<typeof fetch>((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === metadataUrl) {
        return Promise.resolve(createJsonResponse({ avatarUrl: "/avatar/main" }));
      }
      if (url === "/avatar/main") {
        return Promise.resolve(new Response(new Blob(["avatar"])));
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = makeChatHost({ resourceBasePath, sessionKey: "agent:main", ...overrides });

    await refreshChatAvatar(host);

    for (const [index, url] of [metadataUrl, "/avatar/main"].entries()) {
      expect(fetchUrl(fetchMock, index)).toBe(url);
      const init = fetchInit(fetchMock, index);
      expect(init.method).toBe("GET");
      if (expectedToken) {
        expect(init.headers).toEqual({ Authorization: `Bearer ${expectedToken}` });
      } else {
        expect(init).not.toHaveProperty("headers");
      }
    }
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe(objectUrl);
  });
  it("keeps mounted dashboard avatar endpoints under the normalized base path", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(createJsonResponse({}, { ok: false }));
    vi.stubGlobal("fetch", fetchMock);

    const host = makeChatHost({
      resourceBasePath: "/openclaw/",
      sessionKey: "agent:ops:main",
    });
    await refreshChatAvatar(host);

    expect(fetchUrl(fetchMock, 0)).toBe("/openclaw/avatar/ops?meta=1");
    expect(fetchInit(fetchMock, 0).method).toBe("GET");
    expect(host.chatAvatarUrl).toBeNull();
  });

  it("drops remote avatar metadata so the control UI can rely on same-origin images only", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        avatarUrl: "https://example.com/avatar.png",
        avatarSource: "https://example.com/avatar.png",
        avatarStatus: "remote",
        avatarReason: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const host = makeChatHost({ resourceBasePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("https://example.com/avatar.png");
    expect(host.chatAvatarStatus).toBe("remote");
  });

  it("keeps unresolved IDENTITY.md avatar metadata when falling back to the logo", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      createJsonResponse({
        avatarUrl: null,
        avatarSource: "assets/avatars/nova-portrait.png",
        avatarStatus: "none",
        avatarReason: "missing",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const host = makeChatHost({ resourceBasePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("assets/avatars/nova-portrait.png");
    expect(host.chatAvatarStatus).toBe("none");
    expect(host.chatAvatarReason).toBe("missing");
  });

  it.each([
    {
      name: "ignores stale avatar responses after switching sessions",
      firstAgent: "main",
      overrides: { sessionKey: "agent:main:main" },
      switchAgent(host: TestChatHost) {
        host.sessionKey = "agent:ops:main";
      },
    },
    {
      name: "ignores stale global avatar responses after switching selected agents",
      firstAgent: "work",
      overrides: {
        sessionKey: "global",
        assistantAgentId: "work",
        agentsList: { defaultId: "main" },
      },
      switchAgent(host: TestChatHost) {
        host.assistantAgentId = "ops";
      },
    },
  ])("$name", async (fixture) => {
    const { firstAgent, overrides } = fixture;
    const createObjectURL = vi.fn(() => "blob:ops-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const firstRequest = createDeferred<{ avatarUrl?: string }>();
    const opsRequest = createDeferred<{ avatarUrl?: string }>();
    const firstMetadataUrl = `/avatar/${firstAgent}?meta=1`;
    const fetchMock = vi.fn<typeof fetch>((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === firstMetadataUrl) {
        return Promise.resolve(createJsonResponse(firstRequest.promise));
      }
      if (url === "/avatar/ops?meta=1") {
        return Promise.resolve(createJsonResponse(opsRequest.promise));
      }
      if (url === "/avatar/ops") {
        return Promise.resolve(new Response(new Blob(["avatar"])));
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = makeChatHost({ resourceBasePath: "", ...overrides });

    const firstRefresh = refreshChatAvatar(host);
    fixture.switchAgent(host);
    const secondRefresh = refreshChatAvatar(host);
    firstRequest.resolve({ avatarUrl: `/avatar/${firstAgent}` });
    await firstRefresh;
    expect(host.chatAvatarUrl).toBeNull();
    opsRequest.resolve({ avatarUrl: "/avatar/ops" });
    await secondRefresh;

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:ops-avatar");
    for (const [index, url] of [firstMetadataUrl, "/avatar/ops?meta=1", "/avatar/ops"].entries()) {
      expect(fetchUrl(fetchMock, index)).toBe(url);
      expect(fetchInit(fetchMock, index).method).toBe("GET");
    }
  });
});

function installPairClientPresentationCommand() {
  replaceSlashCommands(
    buildSlashCommandsFromEntries([
      {
        name: "pair",
        textAliases: ["/pair"],
        description: "Pair a device.",
        source: "plugin",
        scope: "both",
        acceptsArgs: true,
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      },
    ]),
  );
}

describe("handleSendChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  beforeEach(() => {
    vi.stubGlobal("sessionStorage", createStorageMock());
  });

  it("preserves the visible bare main route for an immediate send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { runId: "bare-main-run", status: "started" },
      },
      agentsList: { defaultId: "main", mainKey: "main" },
      chatMessage: "stay on the visible route",
      sessionKey: "main",
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: "stay on the visible route",
        sessionKey: "main",
      }),
    );
  });

  it("preserves user-authored bang commands through the normal composer send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { runId: "bang-command-run", status: "started" },
      },
      chatMessage: "!pwd",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ message: "!pwd", sessionKey: "agent:main" }),
    );
    expect(host.chatMessage).toBe("");
  });

  it.each(["stop", "esc", "abort", "wait", "exit"])(
    "sends the idle conversational word %s as a normal message",
    async (message) => {
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": { runId: `idle-${message}`, status: "started" },
        },
        chatMessage: message,
        sessionKey: "agent:main",
      });

      await handleSendChat(host);

      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ message, sessionKey: "agent:main" }),
      );
      expect(host.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
      expect(host.chatMessage).toBe("");
    },
  );

  afterEach(() => {
    replaceSlashCommands(buildFallbackSlashCommands());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["/pair", "/pair:", "/pair :"])(
    "handles parsed no-argument presentation %s before queueing",
    async (chatMessage) => {
      installPairClientPresentationCommand();
      const dispatchClientPresentation = vi.fn(async () => true);
      const baselineMessages = [{ role: "assistant", content: "Ready." }];
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage,
        chatMessages: baselineMessages,
        dispatchClientPresentation,
      });

      await handleSendChat(host);

      expect(dispatchClientPresentation).toHaveBeenCalledWith({ kind: "device-pairing" });
      expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
      expect(host.chatQueue).toStrictEqual([]);
      expect(host.chatMessages).toEqual(baselineMessages);
      expect(host.chatMessage).toBe("");
    },
  );

  it("does not mutate another session after an awaited presentation is handled", async () => {
    installPairClientPresentationCommand();
    const handled = createDeferred<boolean>();
    const dispatchClientPresentation = vi.fn(() => handled.promise);
    const otherSessionHistory = [{ text: "keep this", ts: 1 }];
    const host = makeChatHost({
      chatMessage: "/pair",
      dispatchClientPresentation,
      sessionKey: "agent:main",
      chatLocalInputHistoryBySession: { "agent:other": otherSessionHistory },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    expect(dispatchClientPresentation).toHaveBeenCalledWith({ kind: "device-pairing" });

    host.sessionKey = "agent:other";
    host.chatMessage = "/pair";
    handled.resolve(true);
    await send;

    expect(host.chatMessage).toBe("/pair");
    expect(host.chatLocalInputHistoryBySession["agent:other"]).toEqual(otherSessionHistory);
    expect(host.chatLocalInputHistoryBySession["agent:main"]).toBeUndefined();
    expect(host.chatQueue).toStrictEqual([]);
  });

  it.each(["/pair status", "/pair approve request-1", "/pair:qr", "/pair unknown"])(
    "keeps argument-bearing presentation command %s on the remote path",
    async (chatMessage) => {
      installPairClientPresentationCommand();
      const dispatchClientPresentation = vi.fn(async () => true);
      const host = makeChatHost({
        requestHandlers: { "chat.send": { status: "started" } },
        chatMessage,
        dispatchClientPresentation,
      });

      await handleSendChat(host);

      expect(dispatchClientPresentation).not.toHaveBeenCalled();
      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ message: chatMessage }),
      );
    },
  );

  it("keeps presentation commands with a persisted reply target on the remote path", async () => {
    installPairClientPresentationCommand();
    const sent = createDeferred<unknown>();
    const dispatchClientPresentation = vi.fn(async () => true);
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => sent.promise },
      chatMessage: "/pair",
      chatReplyTarget: {
        messageId: "id:pair-source",
        text: "pairing context",
        senderLabel: "Molty",
        sourceMessageId: "pair-source",
      },
      dispatchClientPresentation,
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    expect(dispatchClientPresentation).not.toHaveBeenCalled();
    expect(host.chatQueue[0]).toMatchObject({ text: "/pair", replyToId: "pair-source" });
    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ message: "/pair", replyToId: "pair-source" }),
    );
    expect(host.chatReplyTarget?.messageId).toBe("id:pair-source");

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await send;

    expect(host.chatReplyTarget).toBeNull();
  });

  it.each([
    { name: "unavailable", dispatch: vi.fn(async () => false) },
    {
      name: "failed",
      dispatch: vi.fn(async () => {
        throw new Error("presentation unavailable");
      }),
    },
  ])("retains remote behavior when client presentation is $name", async ({ dispatch }) => {
    installPairClientPresentationCommand();
    const host = makeChatHost({
      requestHandlers: { "chat.send": { status: "started" } },
      chatMessage: "/pair",
      dispatchClientPresentation: dispatch,
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ message: "/pair" }),
    );
  });

  it("does not intercept offline presentation commands before durable queue admission", async () => {
    installPairClientPresentationCommand();
    const dispatchClientPresentation = vi.fn(async () => true);
    const host = makeChatHost({
      chatMessage: "/pair",
      connected: false,
      dispatchClientPresentation,
    });

    await handleSendChat(host);

    expect(dispatchClientPresentation).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ text: "/pair", sendState: "waiting-reconnect" }),
    ]);

    const request = makeRequestMock({
      "chat.history": idleChatHistory(),
      "chat.send": { status: "started" },
    });
    host.client = clientWithRequest(request);
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    expect(dispatchClientPresentation).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ message: "/pair" }),
    );
  });

  it("keeps presentation commands with attachments on the remote path", async () => {
    installPairClientPresentationCommand();
    const dispatchClientPresentation = vi.fn(async () => true);
    const file = new File(["pairing notes"], "pairing.txt", { type: "text/plain" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "pairing-notes",
        mimeType: "text/plain",
        fileName: file.name,
        sizeBytes: file.size,
      },
      dataUrl: "data:text/plain;base64,cGFpcmluZyBub3Rlcw==",
      file,
    });
    const host = makeChatHost({
      requestHandlers: { "chat.send": { status: "started" } },
      chatMessage: "/pair",
      chatAttachments: [attachment],
      dispatchClientPresentation,
    });

    await handleSendChat(host);

    expect(dispatchClientPresentation).not.toHaveBeenCalled();
    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({ message: "/pair" }),
    );
  });

  it("routes typed /new through the fresh-session action without confirmation", async () => {
    const createChatSession = vi.fn(async () => true);
    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "/new",
      sessionKey: "agent:main",
      createChatSession,
    });

    await handleSendChat(host);

    expect(host.request).not.toHaveBeenCalled();
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(host.chatMessage).toBe("");
  });

  it("restores typed /new when session creation is cancelled", async () => {
    const createChatSession = vi.fn(async () => false);
    const host = makeChatHost({
      chatMessage: "/new",
      sessionKey: "agent:main",
      createChatSession,
    });

    await handleSendChat(host);

    expect(createChatSession).toHaveBeenCalledOnce();
    expect(host.chatMessage).toBe("/new");
  });

  it("does not queue typed /new behind an active run", async () => {
    const createChatSession = vi.fn(async () => true);
    const host = makeChatHost({
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatMessage: "/reset",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("/reset");
    expect(host.chatMessage).toBe("");
  });

  it("parks a settings-delayed reset when the user changes sessions", async () => {
    const settingsPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
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

    writeChatQueueForScope(host, "agent:main", host.chatQueue);
    host.sessionKey = "agent:other";
    syncVisibleChatQueueProjection(host);
    settingsPatch.resolve(true);
    await send;

    expect(host.request).not.toHaveBeenCalled();
    expect(readChatQueueForScope(host, "agent:main")[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "/reset",
    });
  });

  it("coalesces settings-delayed redirects and preserves a newer draft", async () => {
    const settingsPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": {
          status: "started",
          runId: "redirect-run",
          messageSeq: 2,
          interruptedActiveRun: true,
        },
      },
      chatMessage: "/redirect start over",
      pendingSettingsPatches: { "agent:main": settingsPatch.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    const duplicate = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    await duplicate;
    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("/redirect start over");

    host.chatMessage = "new draft";
    settingsPatch.resolve(true);
    await send;

    expect(host.request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main",
      message: "start over",
      queueMode: "interrupt",
      idempotencyKey: expect.any(String),
    });
    expect(host.request).toHaveBeenCalledTimes(1);
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

    const host = makeChatHost({
      requestHandlers: {},
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

    expect(host.request).not.toHaveBeenCalled();
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatMessage: input,
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe(expected);
    expect(host.chatMessage).toBe("");
  });

  it("does not seed refreshSessionsAfterChat for a terminal timeout ack on a refreshing send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "timeout" },
      },
      chatMessage: "/reset",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
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
    const archivedSessions = createSessionsResult([
      row("agent:main:archived", { archived: true, status: "done" }),
    ]);
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat send payload");
          return { runId: payload.idempotencyKey, status: "ok" };
        },
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        },
        "sessions.list": () =>
          createSessionsResult([row("agent:main", { hasActiveRun: false, status: "done" })]),
      },
      chatMessage: "/reset",
      sessionKey: "agent:main",
      sessionsArchivedFilter: "archived",
      sessionsResult: archivedSessions,
    });

    await handleSendChat(host);

    const runState = host as ChatHost & { lastLocalTerminalReconcile?: unknown };
    expect(runState.lastLocalTerminalReconcile).toMatchObject({
      phase: "done",
      sessionKey: "agent:main",
      sessionStatus: "done",
    });
    await waitForFast(() =>
      expect(host.request.mock.calls.some(([method]) => method === "sessions.list")).toBe(true),
    );
    expect(host.sessionsResult).toBe(archivedSessions);
  });

  it("marks terminal error ACK sends failed instead of accepting the queued message", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat send payload");
          return { runId: payload.idempotencyKey, status: "error" };
        },
      },
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

  it.each(["error", "timeout"] as const)(
    "removes only a reducer-owned optimistic turn after a terminal %s ACK",
    async (status) => {
      const persistedPeer = {
        role: "user",
        content: [{ type: "text", text: "same visible message" }],
        __openclaw: { id: "peer-user", seq: 1, idempotencyKey: "peer-run:user" },
      };
      let rejectedRunId = "";
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": (params: unknown) => {
            const payload = requireRecord(params, "terminal chat send payload");
            rejectedRunId = String(payload.idempotencyKey);
            const scope = { sessionKey: host.sessionKey };
            const projection = reduceSessionProjection(
              getChatSessionProjection(host, host.chatMessages, scope),
              {
                type: "sendPending",
                runId: rejectedRunId,
                message: {
                  role: "user",
                  content: [{ type: "text", text: "same visible message" }],
                  __openclaw: { idempotencyKey: `${rejectedRunId}:user` },
                },
                scope,
              },
            );
            setChatSessionProjection(host, projection);
            host.chatMessages = [...projection.messages];
            return { runId: rejectedRunId, status };
          },
        },
        chatMessage: "same visible message",
        chatMessages: [persistedPeer],
        sessionKey: "agent:main",
      });

      await handleSendChat(host);

      expect(host.chatMessages).toStrictEqual([persistedPeer]);
      expect(host.chatMessage).toBe("same visible message");
      expect(host.chatQueue).toHaveLength(1);
      expect(host.chatQueue[0]).toMatchObject({
        text: "same visible message",
        sendRunId: rejectedRunId,
        sendState: "failed",
      });
      expect(
        getChatSessionProjection(host, host.chatMessages, { sessionKey: host.sessionKey }).entries,
      ).not.toContainEqual(expect.objectContaining({ pendingRunId: rejectedRunId }));
    },
  );

  it("records visible send timing phases for a normal chat send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": {
          status: "started",
          serverTiming: {
            receivedToAckMs: 17,
            loadSessionMs: 4,
            prepareAttachmentsMs: 0.5,
          },
        },
      },
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
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

  it("records pending send paint timing before a delayed chat.send ACK", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const chatSend = createDeferred<{ status: "started" }>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => chatSend.promise,
      },
      chatMessage: "measure painted pending send",
      eventLogBuffer: [],
    });

    const send = handleSendChat(host);

    await waitForFast(() =>
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatMessage: "use the newly selected model",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "use the newly selected model",
    });

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
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
    const host = makeChatHost({
      requestHandlers: {
        "sessions.patch": (params: unknown) => {
          const patch = requireRecord(params, "session settings patch");
          if (Object.hasOwn(patch, "thinkingLevel")) {
            return thinkingUpdate.promise;
          }
          if (Object.hasOwn(patch, "fastMode")) {
            return fastModeUpdate.promise;
          }
          throw new Error("Unexpected sessions.patch payload");
        },
        "sessions.list": () => Promise.resolve(sessionsResult),
        "chat.send": () => Promise.resolve({ status: "started" }),
      },
      chatMessage: "use the new reasoning and speed",
      sessionsResult,
    });
    const settingsHost: Parameters<typeof switchChatThinkingLevel>[0] = host;

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
    const fastModePatch = switchChatFastMode(settingsHost, "on");
    const send = handleSendChat(host);
    await Promise.resolve();

    expect(host.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(
      1,
    );
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toStrictEqual([]);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "use the new reasoning and speed",
    });

    thinkingUpdate.resolve({});
    await thinkingPatch;
    await waitForFast(() =>
      expect(
        host.request.mock.calls.filter(([method]) => method === "sessions.patch"),
      ).toHaveLength(2),
    );
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

    fastModeUpdate.resolve({});
    await Promise.all([fastModePatch, send]);
    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload).toMatchObject({
      message: "use the new reasoning and speed",
      sessionKey: "agent:main",
    });
  });

  it("rechecks a picker update started as the captured update completes", async () => {
    const firstUpdate = createDeferred<unknown>();
    const secondUpdate = createDeferred<unknown>();
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    const queuedText = "do not use a superseded picker selection";
    let queuedWrites = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (value.includes(queuedText) && ++queuedWrites > 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    let patchCount = 0;
    const host = makeChatHost({
      requestHandlers: {
        "sessions.patch": () => (++patchCount === 1 ? firstUpdate.promise : secondUpdate.promise),
        "chat.send": { status: "started" },
      },
      chatMessage: queuedText,
    });

    const firstPatch = patchChatSessionSettings(host, "agent:main", { model: "first" });
    const secondPatch = firstPatch.then(() =>
      patchChatSessionSettings(host, "agent:main", { model: "second" }),
    );
    const send = handleSendChat(host);
    await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));

    firstUpdate.resolve({});
    await waitForFast(() => expect(patchCount).toBe(2));
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(queuedWrites).toBe(1);
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

    secondUpdate.resolve(null);
    await Promise.all([firstPatch, secondPatch, send]);

    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(host.chatMessage).toBe(queuedText);
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("keeps a resolved model reconciliation inside the canonical settings queue", async () => {
    const reconcile = createDeferred();
    let patchCount = 0;
    const host = makeChatHost({
      requestHandlers: {
        "sessions.patch": () => {
          patchCount += 1;
          return createResolvedModelPatch(patchCount === 1 ? "gpt-5-mini" : "gpt-5", "openai");
        },
      },
    });

    const first = patchChatSessionSettings(
      host,
      host.sessionKey,
      { model: "openai/gpt-5-mini" },
      { reconcile: async () => await reconcile.promise },
    );
    await waitForFast(() => expect(patchCount).toBe(1));
    const second = patchChatSessionSettings(host, host.sessionKey, {
      model: "openai/gpt-5",
    });
    await Promise.resolve();

    expect(patchCount).toBe(1);
    reconcile.resolve();
    await Promise.all([first, second]);
    expect(patchCount).toBe(2);
  });

  it("rolls a failed queued picker back to the preceding slash model value", async () => {
    const firstPatch = createDeferred<unknown>();
    let patchCount = 0;
    const host = makeChatHost({
      requestHandlers: {
        "sessions.patch": () => {
          patchCount += 1;
          if (patchCount === 1) {
            return firstPatch.promise;
          }
          throw new Error("picker rejected");
        },
      },
    });
    host.sessions.setModelOverride(host.sessionKey, "openai/gpt-old");

    const slash = patchChatSessionSettings(
      host,
      host.sessionKey,
      { model: "openai/gpt-5-mini" },
      {
        deferModelOverride: true,
        reconcile: () => {
          host.sessions.setModelOverride(host.sessionKey, "openai/gpt-5-mini");
        },
      },
    );
    await waitForFast(() => expect(patchCount).toBe(1));
    const picker = patchChatSessionSettings(host, host.sessionKey, {
      model: "openai/gpt-5",
    });

    expect(host.sessions.state.modelOverrides[host.sessionKey]).toBe("openai/gpt-old");
    firstPatch.resolve(createResolvedModelPatch("gpt-5-mini", "openai"));
    await expect(slash).resolves.toBeTruthy();
    await expect(picker).rejects.toThrow("picker rejected");
    expect(host.sessions.state.modelOverrides[host.sessionKey]).toBe("openai/gpt-5-mini");
  });

  it("keeps waiting when a late picker barrier cannot be persisted", async () => {
    const queuedText = "do not bypass the late picker";
    const history = createDeferred<unknown>();
    const settingsUpdate = createDeferred<unknown>();
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let rejectedBarrier = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (
        !rejectedBarrier &&
        value.includes(`"text":"${queuedText}"`) &&
        value.includes('"sendState":"failed"')
      ) {
        rejectedBarrier = true;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": { status: "started" },
        "sessions.patch": () => settingsUpdate.promise,
      },
      chatMessage: queuedText,
      chatQueue: [
        {
          id: "older-picker-barrier",
          text: "already delivered",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "older-picker-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    const send = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
    );
    const patch = patchChatSessionSettings(host, "agent:main", { model: "next" });
    history.resolve({
      messages: [{ role: "user", __openclaw: { idempotencyKey: "older-picker-run:user" } }],
      sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
    });

    await waitForFast(() => expect(rejectedBarrier).toBe(true));
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

    settingsUpdate.resolve(null);
    await Promise.all([patch, send]);
    await retryReconnectableQueuedChatSends(host);

    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    expect(host.chatMessage).toBe(queuedText);
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("does not gate a queued local command on an unrelated picker update", async () => {
    const settingsUpdate = createDeferred<boolean>();
    executeSlashCommandMock.mockResolvedValue({ content: "Compaction complete." });
    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "/compact",
      pendingSettingsPatches: { "agent:main": settingsUpdate.promise },
    });

    await handleSendChat(host);

    expect(executeSlashCommandMock).toHaveBeenCalledOnce();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
    settingsUpdate.resolve(false);
  });

  it("wakes a picker-delayed durable send after reconnect already tried its drain", async () => {
    const settingsUpdate = createDeferred<boolean>();
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatMessage: "send after picker and reconnect",
      client: null,
      connected: false,
      pendingSettingsPatches: { "agent:main": settingsUpdate.promise },
    });

    const send = handleSendChat(host);
    await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));

    host.client = clientWithRequest(host.request);
    host.connected = true;
    host.connectionEpoch = (host.connectionEpoch ?? 0) + 1;
    await retryReconnectableQueuedChatSends(host);
    expect(host.request).not.toHaveBeenCalled();

    settingsUpdate.resolve(true);
    await send;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "sending",
      text: "send after picker and reconnect",
    });
  });

  it("settles a picker-delayed send before an older FIFO head blocks transport", async () => {
    const settingsUpdate = createDeferred<boolean>();
    const replyTarget = {
      messageId: "picker-fifo-reply",
      sourceMessageId: "picker-fifo-source",
      text: "reply context",
      senderLabel: "User",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        },
      },
      chatFollowUpMode: "queue",
      chatMessage: "wait behind the active turn",
      chatQueue: [
        {
          id: "older-fifo-head",
          text: "older queued send",
          agentId: "main",
          createdAt: 1,
          sendRunId: "older-run",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
      ],
      chatReplyTarget: replyTarget,
      chatRunId: "active-run",
      pendingSettingsPatches: { "agent:main": settingsUpdate.promise },
    });
    admitHostQueueItems(host);
    expect(
      listStoredChatOutboxes(host).map((outbox) => outbox.queue.map((item) => item.id)),
    ).toEqual([["older-fifo-head"]]);

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(
      listStoredChatOutboxes(host).map((outbox) => outbox.queue.map((item) => item.id)),
    ).toEqual([["older-fifo-head", expect.any(String)]]);
    expect(host.chatQueue[1]).toMatchObject({
      sendState: "waiting-model",
      text: "wait behind the active turn",
    });

    settingsUpdate.resolve(true);
    await send;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toStrictEqual([]);
    expect(host.chatQueue[1]).toMatchObject({
      sendState: "waiting-idle",
      text: "wait behind the active turn",
    });
    expect(host.chatReplyTarget).toBeNull();
  });

  it("waits for a settings patch started in another split pane", async () => {
    const thinkingUpdate = createDeferred<unknown>();
    const sessionsResult = createSessionsResult([
      row("agent:work:main", {
        thinkingLevel: "low",
      }),
    ]);
    const request = makeRequestMock({
      "sessions.patch": () => thinkingUpdate.promise,
      "sessions.list": () => Promise.resolve(sessionsResult),
      "chat.send": () => Promise.resolve({ status: "started" }),
    });
    const client = clientWithRequest(request);
    const agentsList = { defaultId: "main", mainKey: "home" };
    const settingsPane = makeChatHost({
      agentsList,
      client,
      sessionKey: "agent:work:main",
      sessionsResult,
    });
    const sendPane = makeChatHost({
      agentsList,
      client,
      chatMessage: "wait for the other pane",
      sessionKey: "agent:work:home",
      sessions: settingsPane.sessions,
      sessionsResult,
    });
    const settingsHost: Parameters<typeof switchChatThinkingLevel>[0] = settingsPane;

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
    expect(findRequestPayload(request, "chat.send", "chat send payload")).toMatchObject({
      message: "wait for the other pane",
      sessionKey: "agent:work:home",
    });
  });

  it.each([
    { patchKey: "agent:main:main", sendKey: "agent:ops:work" },
    { patchKey: "agent:ops:work", sendKey: "agent:main:main" },
  ])("gates $sendKey on its default-main alias patch", async ({ patchKey, sendKey }) => {
    const settingsPatch = createDeferred<boolean>();

    const agentsList: AgentsListResult = {
      defaultId: "ops",
      mainKey: "work",
      scope: "per-sender",
      agents: [{ id: "ops" }],
    };
    const settingsPane = makeChatHost({
      agentsList,
      pendingSettingsPatches: { [patchKey]: settingsPatch.promise },
      sessionKey: patchKey,
    });
    const sendPane = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      agentsList,
      chatMessage: "wait for the legacy alias patch",
      sessionKey: sendKey,
      sessions: settingsPane.sessions,
    });

    const send = handleSendChat(sendPane);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(sendPane.request).not.toHaveBeenCalled();

    settingsPatch.resolve(false);
    await send;

    expect(sendPane.request).not.toHaveBeenCalled();
    expect(sendPane.chatMessage).toBe("wait for the legacy alias patch");
  });

  it("keeps a real main agent patch separate from a non-main default agent", async () => {
    const settingsPatch = createDeferred<boolean>();

    const agentsList: AgentsListResult = {
      defaultId: "ops",
      mainKey: "work",
      scope: "per-sender",
      agents: [{ id: "ops" }, { id: "main" }],
    };
    const mainPane = makeChatHost({
      agentsList,
      pendingSettingsPatches: { "agent:main:main": settingsPatch.promise },
      sessionKey: "agent:main:main",
    });
    const sendPane = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      agentsList,
      chatMessage: "send on the configured default agent",
      sessionKey: "agent:ops:work",
      sessions: mainPane.sessions,
    });

    await handleSendChat(sendPane);

    expect(sendPane.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(
      1,
    );
    settingsPatch.resolve(false);
  });

  it("does not gate an agent main send on a distinct per-sender global patch", async () => {
    const globalPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      assistantAgentId: "work",
      chatMessage: "send to the agent main session",
      hello: {
        ...gatewayHelloForMethods([], []),
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

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    globalPatch.resolve(false);
  });

  it("gates global-scope agent main aliases on the global patch", async () => {
    const globalPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
      assistantAgentId: "work",
      chatMessage: "wait for the global settings",
      pendingSettingsPatches: { global: globalPatch.promise },
      sessionKey: "agent:work:main",
    });

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    expect(host.request).not.toHaveBeenCalled();

    globalPatch.resolve(true);
    await send;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("parks a delayed global send after navigating to an agent main alias", async () => {
    const globalPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {},
      agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
      assistantAgentId: "work",
      chatMessage: "keep this on global",
      pendingSettingsPatches: { global: globalPatch.promise },
      sessionKey: "global",
    });

    const send = handleSendChat(host);
    expect(await raceWithMacrotask(send)).toBe("pending");
    writeChatQueueForScope(host, "global", host.chatQueue, "work");
    host.sessionKey = "agent:work:main";
    syncVisibleChatQueueProjection(host);

    globalPatch.resolve(true);
    await send;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(readChatQueueForScope(host, "global", "work")[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "keep this on global",
    });
  });

  it("keeps the draft unsent when a settings patch retires with its connection", async () => {
    const sessionsResult = createSessionsResult([
      row("agent:main", {
        thinkingLevel: "low",
      }),
    ]);
    const host = makeChatHost({
      requestHandlers: {},
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
    const settingsHost: Parameters<typeof switchChatThinkingLevel>[0] = host;

    const thinkingPatch = switchChatThinkingLevel(settingsHost, "high");
    const send = handleSendChat(host);

    await expect(thinkingPatch).resolves.toBe(false);
    await send;

    expect(host.request).not.toHaveBeenCalled();
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "keep typing";

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.sessionKey).toBe("agent:main");
    expect(payload.message).toBe("send this");
    expect(host.chatMessage).toBe("keep typing");
  });

  it("preserves attachment payloads for edited drafts after a delayed send", async () => {
    const switchUpdate = createDeferred<boolean>();

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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatAttachments: [attachment],
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "keep typing with the attachment";

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatAttachments: [originalAttachment],
      chatMessage: "send this",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatAttachments = [editedAttachment];

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
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

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
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

  it("sends pasted plain text attachments as file payloads", async () => {
    const text = "large paste\n" + "x".repeat(1100);
    const file = new File([text], "pasted-text-123.txt", { type: "text/plain" });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "pasted-text-att",
        mimeType: "text/plain",
        fileName: "pasted-text-123.txt",
        sizeBytes: file.size,
      },
      dataUrl: `data:text/plain;base64,${btoa(text)}`,
      file,
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatAttachments: [attachment],
      chatMessage: "summarize this",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.message).toBe("summarize this");
    expect(payload.attachments).toStrictEqual([
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "pasted-text-123.txt",
        content: btoa(text),
      },
    ]);
  });

  it("does not cross-gate case-distinct opaque Matrix sessions", async () => {
    const otherSessionSwitch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      sessionKey: "agent:main:matrix:group:!room:Example",
      chatMessage: "send in other session",
      pendingSettingsPatches: {
        "agent:main:matrix:group:!Room:Example": otherSessionSwitch.promise,
      },
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.sessionKey).toBe("agent:main:matrix:group:!room:Example");
    expect(payload.message).toBe("send in other session");
    otherSessionSwitch.resolve(false);
  });

  it("keeps the draft when a pending model picker update fails", async () => {
    const switchUpdate = createDeferred<boolean>();
    const replyTarget = {
      messageId: "picker-reply-source",
      text: "quoted picker context",
      senderLabel: "User",
    };

    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "do not send on rollback",
      chatReplyTarget: replyTarget,
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    switchUpdate.resolve(false);
    await send;

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("do not send on rollback");
    expect(host.chatReplyTarget).toEqual(replyTarget);
    expect(host.applySettings).not.toHaveBeenCalled();
  });

  it("does not mix a failed model-wait draft with a newer attachment-only draft", async () => {
    const switchUpdate = createDeferred<boolean>();
    const newerAttachment = registerChatAttachmentPayload({
      attachment: {
        id: "newer-picker-attachment",
        mimeType: "text/plain",
      },
      dataUrl: "data:text/plain;base64,bmV3ZXI=",
      file: new File(["newer"], "newer.txt", { type: "text/plain" }),
    });
    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "keep this send separate",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatAttachments = [newerAttachment];

    switchUpdate.resolve(false);
    await send;

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([newerAttachment]);
    expect(host.chatQueue[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text: "keep this send separate",
    });
    expect(getChatAttachmentDataUrl(newerAttachment)).toBe("data:text/plain;base64,bmV3ZXI=");
  });

  it("preserves every send when a shared picker patch fails", async () => {
    const switchUpdate = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {},
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

    expect(host.request).not.toHaveBeenCalled();
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
    const host = makeChatHost({
      requestHandlers: {},
      chatAttachments: [attachment],
      chatMessage: "send this attachment",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    host.chatMessage = "new unrelated draft";

    switchUpdate.resolve(false);
    await send;

    expect(host.request).not.toHaveBeenCalled();
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

    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "remove this pending send",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    const queued = expectDefined(host.chatQueue[0], "queued pending send");
    expect(queued.id).toEqual(expect.any(String));
    removeQueuedMessage(host, queued.id);

    switchUpdate.resolve(false);
    await send;

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
  });

  it("keeps resolved model-wait sends queued under the submitted session after switching", async () => {
    const switchUpdate = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        },
      },
      chatMessage: "send from session a",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue[0]?.text).toBe("send from session a");

    writeChatQueueForScope(host, "agent:main", host.chatQueue);
    host.sessionKey = "agent:other";
    syncVisibleChatQueueProjection(host);
    host.chatMessage = "session b draft";
    switchUpdate.resolve(true);
    await send;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatMessage).toBe("session b draft");
    expect(host.chatQueue).toStrictEqual([]);
    expect(readChatQueueForScope(host, "agent:main")[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "send from session a",
    });
  });

  it("continues a resolved model-wait send in its submitted session after switching", async () => {
    const switchUpdate = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "offscreen model-wait send");
          return { runId: String(payload.idempotencyKey), status: "ok" };
        },
      },
      chatMessage: "send from session a after settings",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    writeChatQueueForScope(host, "agent:main", host.chatQueue);
    host.sessionKey = "agent:other";
    syncVisibleChatQueueProjection(host);
    host.chatMessage = "session b draft";

    // Model the only settings event arriving before its follow-up refresh lets
    // the picker promise resolve. A waiting-model row cannot use that wakeup.
    await retryReconnectableQueuedChatSends(host);
    expect(host.request).not.toHaveBeenCalled();

    switchUpdate.resolve(true);
    await send;

    const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(1);
    expect(requireRecord(sends[0]?.[1], "offscreen model-wait payload")).toMatchObject({
      message: "send from session a after settings",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("session b draft");
    expect(host.chatQueue).toStrictEqual([]);
    expect(readChatQueueForScope(host, "agent:main")).toStrictEqual([]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps failed model-wait sends retryable under the submitted session after switching", async () => {
    const switchUpdate = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "send from session a",
      pendingSettingsPatches: { "agent:main": switchUpdate.promise },
      sessionKey: "agent:main",
    });

    const send = handleSendChat(host);
    await Promise.resolve();
    writeChatQueueForScope(host, "agent:main", host.chatQueue);
    host.sessionKey = "agent:other";
    syncVisibleChatQueueProjection(host);
    host.chatMessage = "";

    switchUpdate.resolve(false);
    await send;

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
    expect(host.chatQueue).toStrictEqual([]);
    expect(readChatQueueForScope(host, "agent:main")[0]).toMatchObject({
      sendError: "Chat settings update was interrupted. Review and retry when ready.",
      sendState: "failed",
      text: "send from session a",
    });
  });

  it("does not flush model-wait sends before the model picker update finishes", async () => {
    const switchUpdate = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
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
    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue[0]?.sendState).toBe("waiting-model");

    switchUpdate.resolve(true);
    await send;

    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.message).toBe("wait for selected model");
  });

  it("waits for pending settings before retrying a failed queued send", async () => {
    const settingsPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": { runId: "retry-run", status: "started" },
      },
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
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "agent:main" }),
    );
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-model",
      text: "retry with new settings",
    });

    settingsPatch.resolve(true);
    await retry;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendState: "sending",
        text: "retry with new settings",
      }),
    ]);
  });

  it("keeps a queued retry failed when its pending settings patch fails", async () => {
    const settingsPatch = createDeferred<boolean>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
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

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
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

    const original = {
      id: "memory-only-retry",
      text: "preserve this failed send",
      createdAt: 1,
      sendError: "previous failure",
      sendRunId: "original-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {},
      chatQueue: [original],
    });

    await retryQueuedChatMessage(host, original.id);

    syncVisibleChatQueueProjection(host);

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue).toStrictEqual([original]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it("does not volatile-retry a durable unconfirmed row when storage reads fail", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);

    const original = {
      id: "durable-unconfirmed-read-failure",
      text: "keep the durable claim",
      createdAt: 1,
      sendRunId: "durable-unconfirmed-run",
      sendState: "unconfirmed" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {},
      chatQueue: [original],
    });
    expect(admitQueuedMessageForSession(host, original.sessionKey, original)).toBe(true);
    const getItem = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    await retryQueuedChatMessage(host, original.id);

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue).toStrictEqual([original]);
    getItem.mockRestore();
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([original]);
  });

  it("does not acquire volatile provenance after repeated durable retry read failures", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);

    const original = {
      id: "durable-failed-repeat-read-failure",
      text: "never bypass the durable row",
      createdAt: 1,
      sendRunId: "durable-failed-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {},
      chatQueue: [original],
    });
    expect(admitQueuedMessageForSession(host, original.sessionKey, original)).toBe(true);
    const getItem = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("storage unavailable", "SecurityError");
    });

    await retryQueuedChatMessage(host, original.id);
    await retryQueuedChatMessage(host, original.id);

    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue).toStrictEqual([original]);
    getItem.mockRestore();
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([original]);
  });

  it("drains a foreground retry after the in-flight send fails", async () => {
    const foregroundAck = createDeferred<{ runId: string; status: "error" }>();
    const retryItem = {
      id: "retry-send",
      text: "retry after failure",
      createdAt: 1,
      sendError: "previous failure",
      sendRunId: "retry-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => Promise.resolve(idleChatHistory()),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "foreground retry send");
          return payload.message === "new foreground send"
            ? foregroundAck.promise
            : Promise.resolve({ runId: "retry-run", status: "started" });
        },
      },
      chatMessage: "new foreground send",
      chatQueue: [retryItem],
    });
    expect(admitQueuedMessageForSession(host, retryItem.sessionKey, retryItem)).toBe(true);

    const foreground = handleSendChat(host);
    await waitForFast(() => expect(host.request).toHaveBeenCalledTimes(1));
    await retryQueuedChatMessage(host, "retry-send");

    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.chatQueue.find((item) => item.id === "retry-send")?.sendState).toBe("waiting-idle");

    foregroundAck.resolve({ runId: "foreground-run", status: "error" });
    await foreground;
    await waitForFast(() =>
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(2),
    );

    const retriedSend = host.request.mock.calls.filter(([method]) => method === "chat.send")[1];
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": (params: unknown) => {
          const payload = requireRecord(params, "chat.history payload");
          return Promise.resolve({
            messages: [],
            sessionInfo: row(String(payload.sessionKey), {
              hasActiveRun: false,
              status: "done",
            }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat.send payload");
          sendPayloads.push(payload);
          return payload.sessionKey === "agent:main"
            ? foregroundAck.promise
            : Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
        },
      },
      pendingSettingsPatches: { "agent:other": settingsPatch.promise },
      sessionKey: "agent:main",
    });
    const replayItem = {
      id: "settings-gated-replay",
      text: "replay after settings",
      createdAt: 1,
      sendRunId: "settings-gated-run",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:other",
    };
    writeChatQueueForScope(host, replayItem.sessionKey, [replayItem]);
    expect(admitQueuedMessageForSession(host, replayItem.sessionKey, replayItem)).toBe(true);

    const replay = retryReconnectableQueuedChatSends(host);
    expect(await raceWithMacrotask(replay)).toBe("pending");
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "agent:other" }),
    );
    expect(sendPayloads).toStrictEqual([]);

    host.chatMessage = "independent foreground send";
    const foreground = handleSendChat(host);
    await waitForFast(() => expect(sendPayloads).toHaveLength(1));
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
      vi.fn<typeof fetch>().mockResolvedValue(createJsonResponse({}, { ok: false })),
    );

    const refreshCurrentSessionTools = vi.fn();
    const host = makeChatHost({
      requestHandlers: {
        "sessions.patch": {
          ok: true,
          key: "main",
          resolved: {
            modelProvider: "openai",
            model: "gpt-5-mini",
          },
        },
        "chat.history": { messages: [], thinkingLevel: null },
        "sessions.list": {
          ts: 0,
          path: "",
          count: 0,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [],
        },
        "models.list": {
          models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
        },
      },
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
      refreshCurrentSessionTools,
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(host.sessions.state.modelOverrides.main).toBe("openai/gpt-5-mini");
    expect(refreshCurrentSessionTools).toHaveBeenCalledTimes(1);
  });

  it("queues local slash commands while the gateway client is unavailable", async () => {
    const host = makeChatHost({
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

    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "/think",
      connected: true,
    });

    await handleSendChat(host);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(1);
    expect(host.chatMessage).toBe("");
    expect(host.lastError).toBe("dispatch failed");
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

  it("routes /btw to the session companion while a main run is active", async () => {
    const openSessionCompanion = vi.fn();
    const host = makeChatHost({
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/btw what changed?",
      openSessionCompanion,
    });

    await handleSendChat(host);

    expect(openSessionCompanion).toHaveBeenCalledWith("what changed?");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/btw what changed?");
  });

  it("sends /approve immediately while a main run is waiting without queueing it", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started" },
      },
      chatRunId: "run-main",
      chatStream: "Waiting for approval...",
      chatMessage: "/approve approval-123 allow-once",
    });

    await handleSendChat(host);

    const payload = findRequestPayload(host.request, "chat.send", "approval command payload");
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

  it("keeps a delayed approval failure recoverable in its submitted session", async () => {
    const ack = createDeferred<{ runId: string; status: "error" }>();
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "approval-session-attachment",
        mimeType: "text/plain",
        fileName: "approval.txt",
      },
      dataUrl: "data:text/plain;base64,YXBwcm92YWw=",
      file: new File(["approval"], "approval.txt", { type: "text/plain" }),
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => ack.promise,
      },
      chatAttachments: [attachment],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "run-main",
      chatStream: "Waiting for approval...",
      sessionKey: "agent:main:first",
    });

    const send = handleSendChat(host);
    await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
    host.sessionKey = "agent:main:second";
    host.chatMessage = "second session draft";
    host.lastError = "second session error";
    host.chatError = "second session error";

    ack.resolve({ runId: "approval-command", status: "error" });
    await send;

    expect(host.chatMessage).toBe("second session draft");
    expect(host.lastError).toBe("second session error");
    expect(host.chatError).toBe("second session error");

    const fallback = Object.values(host.chatComposerFallbackByScope)[0];
    expect(fallback?.message).toBe("/approve approval-123 allow-once");
    expect(fallback?.attachments).toEqual([expect.objectContaining({ id: attachment.id })]);
    expect(getChatAttachmentDataUrl(fallback!.attachments[0]!)).toBe(
      "data:text/plain;base64,YXBwcm92YWw=",
    );
  });

  it("fences a detached transport rejection when the composer and session changed", async () => {
    const settingsPatch = createDeferred<boolean>();
    const request = createDeferred<never>();
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => request.promise,
      },
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "run-main",
      chatStream: "Waiting for approval...",
      pendingSettingsPatches: { "agent:main:first": settingsPatch.promise },
      sessionKey: "agent:main:first",
    });

    const send = handleSendChat(host);
    host.chatMessage = "newer first-session draft";
    settingsPatch.resolve(true);
    await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
    host.sessionKey = "agent:main:second";
    host.chatMessage = "second session draft";
    host.lastError = "second session error";
    host.chatError = "second session error";

    request.reject(new Error("transport failed"));
    await send;

    expect(host.chatMessage).toBe("second session draft");
    expect(host.lastError).toBe("second session error");
    expect(host.chatError).toBe("second session error");
    expect(host.chatComposerFallbackByScope).toEqual({});
  });

  it("clears detached command recovery after offscreen success", async () => {
    const ack = createDeferred<{ runId: string; status: "started" }>();
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "successful-detached-attachment",
        mimeType: "text/plain",
      },
      dataUrl: "data:text/plain;base64,c3VjY2Vzcw==",
      file: new File(["success"], "success.txt", { type: "text/plain" }),
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => ack.promise,
      },
      chatAttachments: [attachment],
      chatMessage: "/approve approval-123 allow-once",
      chatRunId: "run-main",
      chatStream: "Waiting for approval...",
      sessionKey: "agent:main:first",
    });
    const scopeKey = storedChatOutboxScopeKey(resolveStoredChatOutboxScope(host, host.sessionKey));
    host.chatComposerFallbackByScope = {
      [scopeKey]: {
        message: host.chatMessage,
        attachments: [attachment],
        storageFailed: true,
        sequence: 42,
      },
    };

    const send = handleSendChat(host);
    await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
    host.sessionKey = "agent:main:second";
    host.chatMessage = "second session draft";

    ack.resolve({ runId: "approval-command", status: "started" });
    await send;

    expect(host.chatMessage).toBe("second session draft");
    expect(host.chatComposerFallbackByScope).toEqual({});
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("keeps a delayed local-command failure recoverable in its submitted session", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "redirect-session-attachment",
        mimeType: "text/plain",
        fileName: "redirect.txt",
      },
      dataUrl: "data:text/plain;base64,cmVkaXJlY3Q=",
      file: new File(["redirect"], "redirect.txt", { type: "text/plain" }),
    });
    const host = makeChatHost({
      chatAttachments: [attachment],
      chatMessage: "/redirect start over",
      client: clientWithRequest(vi.fn()),
      connectionEpoch: 1,
      sessionKey: "agent:main:first",
    });

    const send = handleSendChat(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledOnce());
    host.sessionKey = "agent:main:second";
    host.chatMessage = "second session draft";
    host.lastError = "second session error";
    host.chatError = "second session error";

    command.resolve({ content: "Redirect failed.", failed: true });
    await send;

    expect(host.chatMessage).toBe("second session draft");
    expect(host.lastError).toBe("second session error");
    expect(host.chatError).toBe("second session error");

    const fallback = Object.values(host.chatComposerFallbackByScope)[0];
    expect(fallback?.message).toBe("/redirect start over");
    expect(fallback?.attachments).toEqual([expect.objectContaining({ id: attachment.id })]);
    expect(getChatAttachmentDataUrl(fallback!.attachments[0]!)).toBe(
      "data:text/plain;base64,cmVkaXJlY3Q=",
    );
  });

  it("does not recover a delayed local command through a replaced connection", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "stale-connection-attachment",
        mimeType: "text/plain",
      },
      dataUrl: "data:text/plain;base64,c3RhbGU=",
      file: new File(["stale"], "stale.txt", { type: "text/plain" }),
    });
    const originalClient = clientWithRequest(vi.fn());
    const host = makeChatHost({
      chatAttachments: [attachment],
      chatMessage: "/redirect start over",
      client: originalClient,
      connectionEpoch: 1,
      sessionKey: "agent:main:first",
    });

    const send = handleSendChat(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledOnce());
    host.client = clientWithRequest(vi.fn());
    host.connectionEpoch = 2;
    host.chatMessage = "new connection draft";

    command.resolve({ content: "Redirect failed.", failed: true });
    await send;

    expect(host.chatMessage).toBe("new connection draft");
    expect(host.chatComposerFallbackByScope).toEqual({});
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("does not overwrite newer same-session input after a delayed command failure", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const host = makeChatHost({
      chatMessage: "/redirect start over",
      client: clientWithRequest(vi.fn()),
      connectionEpoch: 1,
      sessionKey: "agent:main:first",
    });

    const send = handleSendChat(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledOnce());
    host.chatMessage = "newer draft";

    command.resolve({ content: "Redirect failed.", failed: true });
    await send;

    expect(host.chatMessage).toBe("newer draft");
    expect(host.chatComposerFallbackByScope).toEqual({});
  });

  it("does not combine a failed command with a newer attachment-only draft", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const submittedAttachment = registerChatAttachmentPayload({
      attachment: {
        id: "submitted-command-attachment",
        mimeType: "text/plain",
      },
      dataUrl: "data:text/plain;base64,c3VibWl0dGVk",
      file: new File(["submitted"], "submitted.txt", { type: "text/plain" }),
    });
    const newerAttachment = registerChatAttachmentPayload({
      attachment: {
        id: "newer-draft-attachment",
        mimeType: "text/plain",
      },
      dataUrl: "data:text/plain;base64,bmV3ZXI=",
      file: new File(["newer"], "newer.txt", { type: "text/plain" }),
    });
    const host = makeChatHost({
      chatAttachments: [submittedAttachment],
      chatMessage: "/redirect start over",
      client: clientWithRequest(vi.fn()),
      connectionEpoch: 1,
      sessionKey: "agent:main:first",
    });

    const send = handleSendChat(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledOnce());
    host.chatAttachments = [newerAttachment];

    command.resolve({ content: "Redirect failed.", failed: true });
    await send;

    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([newerAttachment]);
    expect(host.chatComposerFallbackByScope).toEqual({});
    expect(getChatAttachmentDataUrl(submittedAttachment)).toBeNull();
    expect(getChatAttachmentDataUrl(newerAttachment)).toBe("data:text/plain;base64,bmV3ZXI=");
  });

  it("clears the owned fallback after a successful local command retry", async () => {
    executeSlashCommandMock.mockResolvedValueOnce({ content: "Redirected.", failed: false });
    const attachment = registerChatAttachmentPayload({
      attachment: {
        id: "successful-retry-attachment",
        mimeType: "text/plain",
      },
      dataUrl: "data:text/plain;base64,c3VjY2Vzcw==",
      file: new File(["success"], "success.txt", { type: "text/plain" }),
    });
    const host = makeChatHost({
      chatAttachments: [attachment],
      chatMessage: "/redirect start over",
      client: clientWithRequest(vi.fn()),
      connectionEpoch: 1,
      sessionKey: "agent:main:first",
    });
    const scopeKey = storedChatOutboxScopeKey(resolveStoredChatOutboxScope(host, host.sessionKey));
    host.chatComposerFallbackByScope = {
      [scopeKey]: {
        message: host.chatMessage,
        attachments: [attachment],
        storageFailed: false,
        sequence: 41,
      },
    };

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
    expect(host.chatComposerFallbackByScope).toEqual({});
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
  });

  it("routes /side through the same session companion path", async () => {
    const openSessionCompanion = vi.fn();
    const host = makeChatHost({
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/side what changed?",
      openSessionCompanion,
    });

    await handleSendChat(host);

    expect(openSessionCompanion).toHaveBeenCalledWith("what changed?");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.chatRunId).toBe("run-main");
  });

  it("routes /btw without adopting a main chat run when idle", async () => {
    const openSessionCompanion = vi.fn();
    const host = makeChatHost({
      chatMessage: "/btw summarize this",
      openSessionCompanion,
    });

    await handleSendChat(host);

    expect(openSessionCompanion).toHaveBeenCalledWith("summarize this");
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatMessage).toBe("");
    expect(navigateChatInputHistory(host, "up")).toBe(true);
    expect(host.chatMessage).toBe("/btw summarize this");
  });

  it("keeps queued normal messages recallable before transcript history catches up", async () => {
    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "queued while busy",
      chatRunId: "run-1",
      settings: { chatFollowUpMode: "queue" },
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

  it("lets a per-send steer override beat the effective queue setting", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "steer-run" },
      },
      chatMessage: "steer this queued follow-up now",
      chatRunId: "active-run",
      chatStream: "Working...",
      sessionKey: "agent:main:main",
      settings: { chatFollowUpMode: "queue" },
    });

    await handleSendChat(host, undefined, { followUpMode: "steer" });

    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          message: "steer this queued follow-up now",
          queueMode: "steer",
          sessionKey: "agent:main:main",
        }),
      ),
    );
    const payload = findRequestPayload(host.request, "chat.send", "steer override payload");
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
  });

  it("fails visibly when a busy send cannot be parked after durable admission", async () => {
    const storage = createStorageMock();
    const setItem = storage.setItem.bind(storage);
    let writes = 0;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes > 1) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      setItem(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const replyTarget = {
      messageId: "busy-storage-reply",
      text: "keep this reply target",
      senderLabel: "User",
    };
    const host = makeChatHost({
      requestHandlers: {},
      chatMessage: "queue behind the active run",
      chatReplyTarget: replyTarget,
      chatRunId: "run-1",
      settings: { chatFollowUpMode: "queue" },
    });

    await handleSendChat(host);

    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(host.chatReplyTarget).toEqual(replyTarget);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
    expect(host.applySettings).not.toHaveBeenCalled();
  });

  it("auto-steers messages sent during an active run with the default steer setting", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "steer-run" },
      },
      chatMessage: "tighten the plan",
      chatRunId: "run-1",
      chatDisplayedLeafEntryId: "leaf-active",
      chatStream: "Working...",
      sessionKey: "agent:main:main",
      settings: { chatFollowUpMode: "steer" },
    });

    await handleSendChat(host);

    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          sessionKey: "agent:main:main",
          message: "tighten the plan",
          deliver: false,
          queueMode: "steer",
        }),
      ),
    );
    expect(host.chatRunId).toBe("run-1");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        queueMode: "steer",
        sendState: "sending",
        text: "tighten the plan",
      }),
    ]);
    const payload = findRequestPayload(host.request, "chat.send", "default steer payload");
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
  });

  it("adopts a steer-mode ACK when no run is active", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "started-run" },
      },
      chatMessage: "start through steer mode",
    });

    await handleSendChat(host, undefined, { followUpMode: "steer" });

    expect(host.chatRunId).toBe("started-run");
  });

  it("sends a fresh mode-bearing row ahead of older outbox reconciliation", async () => {
    const older = {
      id: "older-reconciliation-head",
      text: "already delivered older turn",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "older-reconciliation-run",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          throw new Error("fresh active-run sends must not wait for older history");
        },
        "chat.send": { status: "started", runId: "fresh-steer-run" },
      },
      chatMessage: "steer without waiting for history",
      chatQueue: [older],
      chatRunId: "active-run",
      settings: { chatFollowUpMode: "steer" },
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, older)).toBe(true);

    await handleSendChat(host);

    const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.[1]).toMatchObject({
      message: "steer without waiting for history",
      queueMode: "steer",
    });
    expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
  });

  it("leaves active-run resolution to the Gateway while its effective mode is loading", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "gateway-resolved-run" },
      },
      chatMessage: "use the live server mode",
      chatRunId: "run-1",
      chatStream: "Working...",
      sessionKey: "agent:main:main",
    });

    await handleSendChat(host);

    await waitForFast(() => expect(host.request).toHaveBeenCalled());
    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.message).toBe("use the live server mode");
    expect(payload).not.toHaveProperty("queueMode");
  });

  it.each(["followup", "collect", "interrupt"] as const)(
    "preserves the inherited %s mode for active-run sends",
    async (queueMode) => {
      const host = makeChatHost({
        requestHandlers: {
          "chat.send": { status: "started", runId: `${queueMode}-run` },
        },
        chatFollowUpMode: queueMode,
        chatMessage: `send with ${queueMode}`,
        chatRunId: "run-1",
        chatStream: "Working...",
        sessionKey: "agent:main:main",
      });

      await handleSendChat(host);

      await waitForFast(() =>
        expect(host.request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({
            message: `send with ${queueMode}`,
            queueMode,
            sessionKey: "agent:main:main",
          }),
        ),
      );
      expect(host.chatQueue).toEqual([
        expect.objectContaining({
          queueMode,
          sendState: "sending",
          text: `send with ${queueMode}`,
        }),
      ]);
    },
  );

  it("honors the selected mode when only the session row reports an active run", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "interrupt-run" },
      },
      chatFollowUpMode: "interrupt",
      chatMessage: "replace the active run",
      chatRunId: null,
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([
        row("agent:main:main", {
          hasActiveRun: true,
          activeRunIds: ["active-run"],
          activeLeafEntryId: "leaf-active",
          status: "running",
        }),
      ]),
    });

    await handleSendChat(host);

    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          message: "replace the active run",
          queueMode: "interrupt",
          sessionKey: "agent:main:main",
        }),
      ),
    );
  });

  it("sends normally when only a descendant run is active", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "started", runId: "new-parent-run" },
      },
      chatMessage: "start another parent turn",
      chatRunId: null,
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([
        row("agent:main:main", {
          hasActiveRun: false,
          hasActiveSubagentRun: true,
          status: "done",
        }),
      ]),
      settings: { chatFollowUpMode: "steer" },
    });

    await handleSendChat(host);

    await waitForFast(() => expect(host.request).toHaveBeenCalled());
    const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
    expect(payload.message).toBe("start another parent turn");
    expect(payload).not.toHaveProperty("queueMode");
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(host.chatError).toBeNull();
  });

  it("keeps a steered message visible when only the session row reports an active run", async () => {
    let wireRunId: unknown;

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          wireRunId = requireRecord(params, "steered chat send payload").idempotencyKey;
          return { status: "started", runId: "steer-run" };
        },
      },
      chatMessage: "tighten the live plan",
      chatRunId: null,
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([
        row("agent:main:main", {
          hasActiveRun: true,
          activeRunIds: ["active-run"],
          activeLeafEntryId: "leaf-active",
          status: "running",
        }),
      ]),
      settings: { chatFollowUpMode: "steer" },
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]).toMatchObject({
      queueMode: "steer",
      sendState: "sending",
      sendRunId: wireRunId,
      text: "tighten the live plan",
    });
  });

  it("keeps busy sends queued in steer mode while disconnected", async () => {
    const host = makeChatHost({
      client: null,
      connected: false,
      chatMessage: "queued while offline",
      chatRunId: "run-1",
      chatDisplayedLeafEntryId: "leaf-active",
      settings: { chatFollowUpMode: "steer" },
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("queued while offline");
    expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
    expect(host.chatQueue[0]?.queueMode).toBe("steer");
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
    const host = makeChatHost({
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
    const request = makeRequestMock({
      "chat.history": () =>
        Promise.resolve({
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        }),
    });
    const host = makeChatHost({
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

    host.client = clientWithRequest(request);
    host.connected = true;
    host.chatRunId = null;
    await retryReconnectableQueuedChatSends(host);

    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toHaveLength(2);
  });

  it("skips the full-history reconcile for a never-attempted head behind a known active run", async () => {
    // Every transcript event re-runs the outbox resume; without the session-row
    // gate each wakeup issued a 1000-message chat.history only to learn the run
    // is still active.
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          throw new Error("reconcile must not fetch history while the session row is active");
        },
      },
      chatQueue: [
        {
          id: "queued-behind-run",
          text: "wait for the active run",
          createdAt: 1,
          sendRunId: "queued-behind-run-send",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
      ],
      sessionsResult: createSessionsResult([
        row("agent:main", { hasActiveRun: true, status: "running", updatedAt: 10 }),
      ]),
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]).toMatchObject({
      sendState: "waiting-idle",
      text: "wait for the active run",
    });

    // Once the row goes idle the same head reconciles through history again.
    const idleRow = row("agent:main", { hasActiveRun: false, status: "done", updatedAt: 11 });
    host.sessions.reconcile(idleRow);
    host.sessionsResult = createSessionsResult([idleRow]);
    host.request.mockImplementation((method: string) =>
      method === "chat.history"
        ? Promise.resolve(idleChatHistory("agent:main"))
        : Promise.resolve({ runId: "queued-behind-run-send", status: "ok" }),
    );
    await retryReconnectableQueuedChatSends(host);
    expect(
      host.request.mock.calls.filter(([method]) => method === "chat.history").length,
    ).toBeGreaterThan(0);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("serializes same-session sends from split panes in durable FIFO order", async () => {
    const firstAck = createDeferred<unknown>();
    const sendPayloads: Array<Record<string, unknown>> = [];
    const request = makeRequestMock({
      "chat.send": (params: unknown) => {
        const payload = requireRecord(params, "split-pane send payload");
        sendPayloads.push(payload);
        if (sendPayloads.length === 1) {
          return firstAck.promise;
        }
        return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
      },
    });
    const client = clientWithRequest(request);
    const firstHost = makeChatHost({ client });
    const secondHost = makeChatHost({ client });

    const firstSend = handleSendChat(firstHost, "first pane turn");
    await waitForFast(() => expect(sendPayloads).toHaveLength(1));
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": (params: unknown) => {
          const payload = requireRecord(params, "chat.history payload");
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
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat.send payload");
          sentSessions.push(String(payload.sessionKey));
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
      sessionKey: "agent:main:visible",
    });
    writeChatQueueForScope(host, slowItem.sessionKey, [slowItem]);
    writeChatQueueForScope(host, readyItem.sessionKey, [readyItem]);
    expect(admitQueuedMessageForSession(host, slowItem.sessionKey, slowItem)).toBe(true);
    expect(admitQueuedMessageForSession(host, readyItem.sessionKey, readyItem)).toBe(true);

    const resume = retryReconnectableQueuedChatSends(host);

    await waitForFast(() => expect(sentSessions).toContain(readyItem.sessionKey));
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": (params: unknown) => {
          const payload = requireRecord(params, "chat.history payload");
          return Promise.resolve({
            messages: [],
            sessionInfo: row(String(payload.sessionKey), {
              hasActiveRun: false,
              status: "done",
            }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat.send payload");
          const sessionKey = String(payload.sessionKey);
          sentSessions.push(sessionKey);
          return sessionKey === visibleSessionKey
            ? visibleAck.promise
            : Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
      sessionKey: visibleSessionKey,
    });

    const visibleSend = handleSendChat(host, "visible pending send");
    await waitForFast(() => expect(sentSessions).toContain(visibleSessionKey));
    expect(host.chatSending).toBe(true);

    const inactiveItem = {
      id: "inactive-send-finishes-first",
      text: "inactive send",
      createdAt: 2,
      sessionKey: inactiveSessionKey,
    };
    writeChatQueueForScope(host, inactiveSessionKey, [inactiveItem]);
    expect(admitQueuedMessageForSession(host, inactiveSessionKey, inactiveItem)).toBe(true);
    const resume = retryReconnectableQueuedChatSends(host);

    await waitForFast(() => expect(sentSessions).toContain(inactiveSessionKey));
    expect(host.chatSending).toBe(true);

    const visibleRunId = host.chatQueue[0]?.sendRunId;
    visibleAck.resolve({ runId: visibleRunId, status: "ok" });
    await Promise.all([visibleSend, resume]);

    expect(host.chatSending).toBe(false);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("does not block another agent's global outbox behind the selected agent's active run", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const historyAgentIds: unknown[] = [];
    let selectedAgentActive = true;
    const host = makeChatHost({
      requestHandlers: {
        "sessions.list": () =>
          createSessionsResult([
            row("global", {
              hasActiveRun: selectedAgentActive,
              status: selectedAgentActive ? "running" : "done",
            }),
          ]),
        "chat.history": (params: unknown) => {
          historyAgentIds.push(requireRecord(params, "agent-scoped history params").agentId);
          return Promise.resolve({
            messages: [],
            sessionInfo: row("global", { hasActiveRun: false, status: "done" }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat.send payload");
          sends.push(payload);
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
      assistantAgentId: "main",
      agentsList: { defaultId: "main", mainKey: "main" },
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
    writeChatQueueForScope(host, "global", [workItem], "work");
    expect(admitQueuedMessageForSession(host, "global", mainItem)).toBe(true);
    expect(admitQueuedMessageForSession(host, "global", workItem)).toBe(true);
    await host.sessions.refresh({ agentId: "main", force: true });
    expect(host.request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main" }),
    );
    expect(host.sessions.state.error).toBeNull();
    expect(host.sessions.state).toMatchObject({
      agentId: "main",
      result: { sessions: [expect.objectContaining({ hasActiveRun: true, key: "global" })] },
    });

    await retryReconnectableQueuedChatSends(host);

    expect(sends).toEqual([expect.objectContaining({ agentId: "work", message: "send as work" })]);
    expect(historyAgentIds).toEqual(["work"]);
    expect(listStoredChatOutboxes(host)).toEqual([
      expect.objectContaining({
        agentId: "main",
        queue: [expect.objectContaining({ id: mainItem.id })],
      }),
    ]);

    selectedAgentActive = false;
    await host.sessions.refresh({ agentId: "main", force: true });
    await retryReconnectableQueuedChatSends(host);

    expect(sends).toEqual([
      expect.objectContaining({ agentId: "work", message: "send as work" }),
      expect.objectContaining({ agentId: "main", message: "send as main" }),
    ]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("reconciles a restored undefined-state command before destructive execution", async () => {
    const item = createQueuedLocalCommand("restored-undefined-clear", "/clear");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        },
      },
      chatQueue: [item],
    });
    // Seed the persisted pre-fix shape without creating fresh-admission provenance.
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: item.sessionKey }),
    );
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(
      0,
    );
    expect(host.chatQueue).toEqual([expect.objectContaining({ id: item.id })]);
  });

  it("reconciles a waiting-idle row after restart before its durable claim", async () => {
    const item = {
      id: "restart-before-send-claim",
      text: "wait behind the server run",
      createdAt: 1,
      sendAttempts: 0,
      sendRunId: "restart-before-send-claim-run",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
        },
      },
      chatQueue: [item],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: item.sessionKey }),
    );
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toEqual([expect.objectContaining({ id: item.id })]);
  });

  it("claims one stored local command once across split panes", async () => {
    executeSlashCommandMock.mockResolvedValue({ content: "Thinking level set." });
    const request = makeRequestMock({
      "chat.history": () => idleChatHistory(),
    });
    const client = clientWithRequest(request);
    const item = createQueuedLocalCommand("shared-local-command", "/think high");
    const firstHost = makeChatHost({ client, chatQueue: [item] });
    const secondHost = makeChatHost({ client, chatQueue: [{ ...item }] });
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
    const request = makeRequestMock({
      "chat.history": () => idleChatHistory("agent:main:visible"),
    });
    const client = clientWithRequest(request);
    const sessionKey = "agent:main:visible";
    const items = [
      createQueuedLocalCommand("first-shared-local-command", "/think high", {
        sessionKey,
      }),
      createQueuedLocalCommand("second-shared-local-command", "/think low", {
        createdAt: 2,
        sessionKey,
      }),
    ];
    const visibleHost = makeChatHost({ client, chatQueue: items, sessionKey });
    const inactiveHost = makeChatHost({ client, chatQueue: [], sessionKey: "agent:main:inactive" });
    admitHostQueueItems(visibleHost);

    const visibleDrain = retryReconnectableQueuedChatSends(visibleHost);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));
    const inactiveDrain = retryReconnectableQueuedChatSends(inactiveHost);
    firstCommand.resolve({ content: "Thinking level set." });
    await Promise.all([visibleDrain, inactiveDrain]);

    expect(executeSlashCommandMock).toHaveBeenCalledTimes(2);
    expect(listStoredChatOutboxes(visibleHost)).toStrictEqual([]);
  });

  it("holds a row being edited against a drain owned by another pane", async () => {
    const request = makeRequestMock({ "chat.history": () => idleChatHistory() });
    const client = clientWithRequest(request);
    const item = {
      id: "edited-across-panes",
      text: "the text being rewritten",
      createdAt: 1,
      sessionKey: "agent:main",
    };
    // Two panes on one session: the composer holding the edit is pane-local, but
    // the outbox and the drain lane are shared, and either pane can own the lane.
    const editing = makeChatHost({ client, chatQueue: [item] });
    const peer = makeChatHost({ client, chatQueue: [] });
    const stopEditing = subscribeChatOutboxProjection(editing);
    const stopPeer = subscribeChatOutboxProjection(peer);
    expect(admitQueuedMessageForSession(editing, editing.sessionKey, item)).toBe(true);
    expect(beginQueuedMessageEdit(editing, item.id)).toBe("started");

    try {
      await retryReconnectableQueuedChatSends(peer);

      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
      expect(listStoredChatOutboxes(peer)[0]?.queue).toEqual([
        expect.objectContaining({ id: item.id, text: item.text }),
      ]);
    } finally {
      stopPeer();
      stopEditing();
    }
  });

  it("projects a running local command to panes that subscribe after execution starts", async () => {
    const command = createDeferred<{ content: string }>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const request = makeRequestMock({
      "chat.history": () => idleChatHistory(),
    });
    const item = createQueuedLocalCommand("slow-local-command", "/compact");
    const client = clientWithRequest(request);
    const host = makeChatHost({
      client,
      chatQueue: [item],
    });
    const peer = makeChatHost({ client, chatQueue: [] });
    const stopHost = subscribeChatOutboxProjection(host);
    let stopPeer = () => {};
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);

    try {
      const draining = retryReconnectableQueuedChatSends(host);
      await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));
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

  it("returns a confirmed clear to waiting-idle when a run starts during the dialog", async () => {
    const confirmation = createDeferred<boolean>();

    const item = createQueuedLocalCommand("clear-confirmation-race", "/clear");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
      chatQueue: [item],
      confirmConversationReset: vi.fn(async () => await confirmation.promise),
    });
    const reset = vi.spyOn(host.sessions, "reset");
    admitHostQueueItems(host);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("executing-command"));
    host.chatRunId = "run-started-during-confirmation";
    confirmation.resolve(true);
    await draining;

    expect(host.chatQueue[0]?.sendState).toBe("waiting-idle");
    expect(reset).not.toHaveBeenCalled();
  });

  it("cancels a queued reset when dashboard reset confirmation is rejected", async () => {
    const item = createQueuedLocalCommand("queued-reset-cancelled", "/reset");
    const confirmConversationReset = vi.fn(async () => false);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
      chatQueue: [item],
      confirmConversationReset,
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    expect(confirmConversationReset).toHaveBeenCalledOnce();
    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("preserves queued reset approval when a run starts during confirmation", async () => {
    const confirmation = createDeferred<boolean>();
    const sendPayloads: Array<Record<string, unknown>> = [];

    const item = createQueuedLocalCommand("queued-reset-approved-before-run", "/reset");
    const confirmConversationReset = vi.fn(async () => await confirmation.promise);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => Promise.resolve(idleChatHistory()),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "approved queued reset payload");
          sendPayloads.push(payload);
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
      chatQueue: [item],
      confirmConversationReset,
    });
    admitHostQueueItems(host);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(confirmConversationReset).toHaveBeenCalledOnce());
    host.chatRunId = "run-started-during-reset-confirmation";
    confirmation.resolve(true);
    await draining;

    const approvedReset = listStoredChatOutboxes(host)[0]?.queue[0];
    expect(approvedReset).toEqual(
      expect.objectContaining({
        id: item.id,
        localCommandName: "reset",
        sendState: "waiting-idle",
        text: "/reset",
      }),
    );

    host.chatRunId = null;
    await retryReconnectableQueuedChatSends(host);

    expect(confirmConversationReset).toHaveBeenCalledTimes(2);
    expect(sendPayloads.map((payload) => payload.message)).toEqual(["/reset"]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps a queued reset when its session changes during confirmation", async () => {
    const confirmation = createDeferred<boolean>();

    const item = createQueuedLocalCommand("queued-reset-route-switch", "/reset", {
      sessionKey: "agent:main:first",
    });
    const confirmConversationReset = vi.fn(async () => await confirmation.promise);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory("agent:main:first"),
      },
      chatQueue: [item],
      confirmConversationReset,
      sessionKey: item.sessionKey,
    });
    admitHostQueueItems(host);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(confirmConversationReset).toHaveBeenCalledOnce());
    host.sessionKey = "agent:main:second";
    confirmation.resolve(false);
    await draining;

    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(listStoredChatOutboxes(host)).toEqual([
      expect.objectContaining({
        sessionKey: item.sessionKey,
        queue: [expect.objectContaining({ id: item.id, sendState: "waiting-idle" })],
      }),
    ]);
  });

  it("does not convert a queued reset after the Gateway connection changes", async () => {
    const confirmation = createDeferred<boolean>();
    const replacementRequest = makeRequestMock({
      "chat.send": () => ({ status: "ok" }),
    });
    const item = createQueuedLocalCommand("queued-reset-reconnect", "/reset");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => ({ status: "ok" }),
      },
      chatQueue: [item],
      connectionEpoch: 1,
      confirmConversationReset: vi.fn(async () => await confirmation.promise),
      hello: gatewayHelloForMethods(["chat.send"]),
    });
    admitHostQueueItems(host);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(host.confirmConversationReset).toHaveBeenCalledOnce());
    host.client = clientWithRequest(replacementRequest);
    host.connectionEpoch = 2;
    confirmation.resolve(true);
    await draining;

    expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(replacementRequest).not.toHaveBeenCalledWith("chat.send", expect.anything());
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toEqual(
      expect.objectContaining({
        id: item.id,
        localCommandName: "reset",
        sendState: "failed",
      }),
    );
  });

  it("does not apply a queued reset acknowledgement from a replaced Gateway", async () => {
    const ack = createDeferred<{ runId: string; status: "ok" }>();
    const replacementRequest = makeRequestMock();
    const item = createQueuedLocalCommand("queued-reset-ack-reconnect", "/reset");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => ack.promise,
      },
      chatQueue: [item],
      connectionEpoch: 1,
      confirmConversationReset: vi.fn(async () => true),
      hello: gatewayHelloForMethods(["chat.send"]),
    });
    const refreshSessions = vi.spyOn(host.sessions, "refresh");
    admitHostQueueItems(host);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() =>
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1),
    );

    host.client = clientWithRequest(replacementRequest);
    host.connectionEpoch = 2;
    markQueuedChatSendsWaitingForReconnect(host);
    host.chatMessages = [{ role: "assistant", content: "Replacement Gateway transcript" }];
    host.chatRunId = "replacement-run";
    host.chatStream = "Replacement Gateway stream";
    host.chatSending = true;
    host.chatSendingScopeKey = storedChatOutboxScopeKey({
      sessionKey: item.sessionKey,
    });
    host.lastError = "Replacement Gateway error";
    host.chatError = "Replacement Gateway error";
    const replacementMessages = host.chatMessages;

    ack.resolve({ runId: "old-gateway-reset-run", status: "ok" });
    await draining;

    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toEqual(
      expect.objectContaining({
        id: item.id,
        localCommandName: "reset",
        sendState: "waiting-reconnect",
      }),
    );
    expect(host.chatMessages).toBe(replacementMessages);
    expect(host.chatRunId).toBe("replacement-run");
    expect(host.chatStream).toBe("Replacement Gateway stream");
    expect(host.chatSending).toBe(true);
    expect(host.chatSendingScopeKey).toBe(
      storedChatOutboxScopeKey({
        sessionKey: item.sessionKey,
      }),
    );
    expect(host.lastError).toBe("Replacement Gateway error");
    expect(host.chatError).toBe("Replacement Gateway error");
    expect(host.refreshSessionsAfterChat).toEqual(new Map());
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("retries an explicitly approved unconfirmed reset with the same run id", async () => {
    const runId = "unconfirmed-reset-run";
    const item = {
      ...createQueuedLocalCommand("unconfirmed-reset-retry", "/reset"),
      sendAttempts: 1,
      sendError: "Delivery could not be confirmed after reconnect.",
      sendRequestStartedAtMs: 10,
      sendRunId: runId,
      sendState: "unconfirmed" as const,
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "retried reset payload");
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      },
      chatQueue: [item],
      confirmConversationReset: vi.fn(async () => true),
      hello: gatewayHelloForMethods(["chat.send"]),
    });
    admitHostQueueItems(host);

    await retryQueuedChatMessage(host, item.id);

    expect(host.confirmConversationReset).toHaveBeenCalledOnce();
    expect(host.request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        idempotencyKey: runId,
        message: "/reset",
      }),
    );
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("retires a queued local command without applying its late result after a route switch", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);

    const item = createQueuedLocalCommand("route-switched-local-command", "/model gpt-5-mini", {
      sessionKey: "agent:main:first",
    });
    const refreshCurrentSessionTools = vi.fn(async () => undefined);
    const refreshCurrentChat = vi.fn(async () => undefined);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory("agent:main:first"),
      },
      connectionEpoch: 1,
      chatQueue: [item],
      refreshCurrentChat,
      refreshCurrentSessionTools,
      sessionKey: item.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));

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
    expect(host.sessions.state.modelOverrides[item.sessionKey]).toBeUndefined();
    expect(refreshCurrentSessionTools).not.toHaveBeenCalled();
    expect(refreshCurrentChat).not.toHaveBeenCalled();
  });

  it("does not apply a late model result after the Gateway connection changes", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);

    const item = createQueuedLocalCommand("reconnected-model-command", "/model gpt-5-mini", {
      sessionKey: "agent:main:first",
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(item.sessionKey),
      },
      connectionEpoch: 1,
      chatQueue: [item],
      sessionKey: item.sessionKey,
    });
    const setModelOverride = vi.spyOn(host.sessions, "setModelOverride");
    expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));

    host.client = clientWithRequest(makeRequestMock());
    host.connectionEpoch = 2;
    command.resolve({
      action: "refresh",
      content: "Model set to `gpt-5-mini`.",
      sessionPatch: {
        modelOverride: { kind: "qualified", value: "openai/gpt-5-mini" },
      },
    });
    await draining;

    expect(setModelOverride).not.toHaveBeenCalled();
    expect(host.sessions.state.modelOverrides[item.sessionKey]).toBeUndefined();
  });

  it.each([
    { sessionKey: "global", mainKey: "main" },
    { sessionKey: "agent:work:main", mainKey: "main" },
    { sessionKey: "agent:work:home", mainKey: "home" },
  ])(
    "does not apply a late selected-global model result after the selected agent changes for $sessionKey",
    async ({ sessionKey, mainKey }) => {
      const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
      executeSlashCommandMock.mockImplementationOnce(() => command.promise);

      const item = createQueuedLocalCommand("switched-global-model-command", "/model gpt-5-mini", {
        sessionKey,
      });
      const host = makeChatHost({
        requestHandlers: {
          "chat.history": () => idleChatHistory(item.sessionKey),
        },
        assistantAgentId: "work",
        agentsList: { defaultId: "main", mainKey },
        chatQueue: [item],
        sessionKey: item.sessionKey,
      });
      const setModelOverride = vi.spyOn(host.sessions, "setModelOverride");
      expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

      const draining = retryReconnectableQueuedChatSends(host);
      await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));

      host.assistantAgentId = "main";
      command.resolve({
        action: "refresh",
        content: "Model set to `gpt-5-mini`.",
        sessionPatch: {
          modelOverride: { kind: "qualified", value: "openai/gpt-5-mini" },
        },
      });
      await draining;

      expect(setModelOverride).not.toHaveBeenCalled();
      expect(host.sessions.state.modelOverrides[item.sessionKey]).toBeUndefined();
    },
  );

  it("does not borrow a replacement connection error for a stale queued command", async () => {
    const command = createDeferred<Awaited<ReturnType<ExecuteSlashCommand>>>();
    executeSlashCommandMock.mockImplementationOnce(() => command.promise);
    const firstClient = clientWithRequest(
      makeRequestMock({
        "chat.history": () => idleChatHistory("agent:main:first"),
      }),
    );
    const item = createQueuedLocalCommand("reconnected-local-command", "/model unavailable", {
      sessionKey: "agent:main:first",
    });
    const host = makeChatHost({
      client: firstClient,
      connectionEpoch: 1,
      chatQueue: [item],
      sessionKey: item.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, item.sessionKey, item)).toBe(true);

    const draining = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledTimes(1));

    host.client = clientWithRequest(makeRequestMock({}));
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
    const host = makeChatHost({ chatQueue: [item] });
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
    const sender = makeChatHost({ chatQueue: [item], sessionKey: item.sessionKey });
    const replacement = makeChatHost({ chatQueue: [], sessionKey: "agent:main:replacement" });
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
    const client = clientWithRequest(vi.fn());
    const visible = makeChatHost({
      chatQueue: [item],
      chatRunId: item.sendRunId,
      client,
      sessionKey: item.sessionKey,
    });
    const inactive = makeChatHost({
      chatQueue: [],
      client,
      sessionKey: "agent:main:inactive",
    });
    for (const host of [visible, inactive]) {
      Object.assign(host, {
        chatMessagesBySession: new Map(),
        connectionEpoch: 1,
        pendingSessionMessageReloadSessionKey: null,
        requestUpdate: vi.fn(),
      });
    }
    cacheEmptyChatSnapshot(inactive, item.sessionKey);
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

    handlePageGatewayEvent(asChatPageHost(inactive), event);
    handlePageGatewayEvent(asChatPageHost(visible), event);
    handlePageGatewayEvent(asChatPageHost(inactive), event);

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
    const client = clientWithRequest(vi.fn());
    const visible = makeChatHost({
      chatQueue: [item],
      chatRunId: item.sendRunId,
      client,
      sessionKey: item.sessionKey,
    });
    const inactive = makeChatHost({
      chatQueue: [],
      client,
      sessionKey: "agent:main:inactive",
    });
    for (const host of [visible, inactive]) {
      Object.assign(host, {
        chatMessagesBySession: new Map(),
        connectionEpoch: 1,
        pendingSessionMessageReloadSessionKey: null,
        requestUpdate: vi.fn(),
      });
    }
    cacheEmptyChatSnapshot(inactive, item.sessionKey);
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

    handlePageGatewayEvent(asChatPageHost(inactive), event);
    handlePageGatewayEvent(asChatPageHost(visible), event);

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

    const items = [
      createQueuedLocalCommand("queued-think-before-reset", "/think high"),
      createQueuedLocalCommand("queued-reset-after-think", "/reset", { createdAt: 2 }),
      {
        id: "queued-prompt-after-reset",
        text: "run only after reset",
        createdAt: 3,
        sessionKey: "agent:main",
      },
    ];
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => Promise.resolve(idleChatHistory()),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "queued reset send payload");
          sendPayloads.push(payload);
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
      chatQueue: items,
    });
    admitHostQueueItems(host);

    const completed = await completesWithin(retryReconnectableQueuedChatSends(host), 500);

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

    const item = {
      id: "offline-reset-with-history",
      text: "/reset",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "reset",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            messages: [{ role: "assistant", content: "older reply" }],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "offline queued reset payload");
          sendPayloads.push(payload);
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
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

    const item = createQueuedLocalCommand("local-command-claim-failure", "/think high");
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
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

    const item = createQueuedLocalCommand("retry-local-command-after-disconnect", "/think high");
    const following = {
      id: "prompt-after-retried-command",
      text: "use the new thinking level",
      createdAt: 2,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": () => {
          events.push("following-prompt");
          return { status: "ok" };
        },
      },
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

    const clear = createQueuedLocalCommand("uncertain-clear", "/clear");
    const successor = {
      id: "prompt-after-uncertain-clear",
      text: "send only after review",
      createdAt: 2,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => {
          throw new Error("post-commit lifecycle failed");
        },
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "successor send payload");
          sentMessages.push(String(payload.message));
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      },
      chatMessages: [{ role: "user", content: "possibly cleared" }],
      chatQueue: [clear, successor],
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, clear)).toBe(true);
    expect(admitQueuedMessageForSession(host, host.sessionKey, successor)).toBe(true);

    await retryReconnectableQueuedChatSends(host);

    expect(host.request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(
      1,
    );
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

    expect(host.request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(
      1,
    );
    expect(sentMessages).toEqual([]);

    await retryQueuedChatMessage(host, successor.id);

    expect(sentMessages).toEqual([successor.text]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("fails closed when history refresh rejects after an uncertain clear", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => {
          throw new Error("post-commit lifecycle failed");
        },
        "chat.history": () => {
          throw new Error("history unavailable");
        },
      },
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

    const clear = createQueuedLocalCommand("uncertain-clear-storage-barrier", "/clear");
    const successor = {
      id: "successor-storage-barrier",
      text: "must stay parked",
      createdAt: 2,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => {
          resetIssued = true;
          throw new Error("post-commit lifecycle failed");
        },
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        },
      },
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
    expect(host.request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(
      1,
    );
    expect(listStoredChatOutboxes(host)[0]?.queue).toEqual([
      expect.objectContaining({ id: clear.id, sendState: "unconfirmed" }),
      expect.objectContaining({ id: successor.id }),
    ]);

    await retryReconnectableQueuedChatSends(host);

    expect(host.request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(
      1,
    );
  });

  it("does not resurrect a send deleted by another pane before its ACK", async () => {
    const ack = createDeferred<unknown>();
    const request = makeRequestMock({
      "chat.send": () => ack.promise,
    });
    const client = clientWithRequest(request);
    const sendingHost = makeChatHost({ client });
    const staleHost = makeChatHost({ client });
    const send = handleSendChat(sendingHost, "delete before ack");
    await waitForFast(() => expect(sendingHost.chatQueue[0]?.sendState).toBe("sending"));
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
    const host = makeChatHost({ sessionKey: "agent:main:new-route" });
    writeChatQueueForScope(host, queuedSessionKey, [item]);
    expect(admitQueuedMessageForSession(host, queuedSessionKey, item)).toBe(true);

    expect(
      removeVisibleOrScopedQueuedMessageWithoutReleasing(host, item.id, queuedSessionKey),
    ).toMatchObject({ id: item.id });

    expect(readChatQueueForScope(host, queuedSessionKey)).toStrictEqual([]);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("does not project an outbox across gateways", () => {
    const source = makeChatHost({
      settings: { gatewayUrl: "ws://gateway-a.test/control" },
    });
    const otherGateway = makeChatHost({
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

  it("projects direct canonical store mutations into an open pane", () => {
    const source = makeChatHost();
    const peer = makeChatHost();
    const item = {
      id: "direct-store-projection",
      text: "refresh the already-open pane",
      createdAt: 1,
      sessionKey: source.sessionKey,
    };
    const stopPeer = subscribeChatOutboxProjection(peer);
    try {
      expect(admitStoredChatComposerQueueItem(source, source.sessionKey, item)).toBe(true);
      expect(peer.chatQueue).toEqual([expect.objectContaining({ id: item.id })]);

      expect(removeStoredChatComposerQueueItem(source, source.sessionKey, item.id, item)).toBe(
        true,
      );
      expect(peer.chatQueue).toStrictEqual([]);
    } finally {
      stopPeer();
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
    const source = makeChatHost({ chatQueue: [item], sessionKey });
    const cachedPane = makeChatHost({ sessionKey: "agent:main:other-session" });
    writeChatQueueForScope(cachedPane, sessionKey, [{ ...item }]);
    const stopSource = subscribeChatOutboxProjection(source);
    const stopCachedPane = subscribeChatOutboxProjection(cachedPane);
    try {
      expect(admitQueuedMessageForSession(source, sessionKey, item)).toBe(true);

      removeQueuedMessage(source, item.id);

      expect(readChatQueueForScope(cachedPane, sessionKey)).toStrictEqual([]);
      cachedPane.sessionKey = sessionKey;
      syncVisibleChatQueueProjection(cachedPane);
      expect(cachedPane.chatQueue).toStrictEqual([]);
    } finally {
      stopCachedPane();
      stopSource();
    }
  });

  it("clears a failed row in another pane when its durable item is removed", async () => {
    const item = {
      id: "failed-item-removed-elsewhere",
      text: "do not retry after another pane cancels",
      createdAt: 1,
      sendError: "previous failure",
      sendRunId: "failed-item-run",
      sendState: "failed" as const,
      sessionKey: "agent:main",
    };
    const source = makeChatHost({ chatQueue: [item], sessionKey: item.sessionKey });
    const peer = makeChatHost({
      requestHandlers: {},
      chatQueue: [{ ...item }],
      sessionKey: item.sessionKey,
    });
    const stopSource = subscribeChatOutboxProjection(source);
    const stopPeer = subscribeChatOutboxProjection(peer);
    try {
      expect(admitQueuedMessageForSession(source, item.sessionKey, item)).toBe(true);

      removeQueuedMessage(source, item.id);

      expect(peer.chatQueue).toStrictEqual([]);
      await retryQueuedChatMessage(peer, item.id);
      expect(peer.request).not.toHaveBeenCalled();
      expect(listStoredChatOutboxes(peer)).toStrictEqual([]);
    } finally {
      stopPeer();
      stopSource();
    }
  });

  it("coalesces duplicate in-flight chat submits before the gateway acknowledges them", async () => {
    const sent = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => sent.promise,
      },
    });

    const first = handleSendChat(host, "same prompt");
    const second = handleSendChat(host, "same prompt");

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("same prompt");
    expect(host.chatQueue[0]?.sendState).toBe("sending");
    expect(host.chatMessages).toStrictEqual([]);

    const queuedRunId = host.chatQueue[0]?.sendRunId;
    sent.resolve({ runId: queuedRunId, status: "started" });
    await Promise.all([first, second]);

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendState: "sending", text: "same prompt" }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" }),
    ]);
    expect(host.chatMessages).toStrictEqual([]);
  });

  it("keeps an acknowledged live send pending while durable history is briefly stale", async () => {
    let historyRequests = 0;
    let runId: string | undefined;
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          historyRequests += 1;
          return Promise.resolve({
            messages:
              historyRequests > 2
                ? [{ role: "user", __openclaw: { idempotencyKey: `${runId}:user` } }]
                : [],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "live send payload");
          runId = String(payload.idempotencyKey);
          return Promise.resolve({ runId, status: "started" });
        },
      },
    });

    await handleSendChat(host, "history will catch up");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({ sendState: "sending", text: "history will catch up" }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" }),
    ]);

    host.chatRunId = null;
    await flushChatQueueForEvent(host);

    expect(host.chatQueue[0]?.sendState).toBe("sending");
    expect(host.lastError).toBeNull();
    await waitForFast(() => expect(listStoredChatOutboxes(host)).toStrictEqual([]), {
      timeout: 1_000,
    });
    expect(historyRequests).toBeGreaterThanOrEqual(3);
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.lastError).toBeNull();
  });

  it("marks an acknowledged live send unconfirmed after history stays missing", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "live send payload");
          const runId = String(payload.idempotencyKey);
          return Promise.resolve({ runId, status: "started" });
        },
      },
    });

    await handleSendChat(host, "history never catches up");
    host.chatRunId = null;
    await flushChatQueueForEvent(host);

    expect(host.chatQueue[0]?.sendState).toBe("sending");
    expect(host.lastError).toBeNull();

    now += 5_001;
    await flushChatQueueForEvent(host);

    expect(host.chatQueue[0]).toMatchObject({
      sendError: UNCONFIRMED_CHAT_SEND_ERROR,
      sendState: "unconfirmed",
      text: "history never catches up",
    });
    expect(host.lastError).toBe(UNCONFIRMED_CHAT_SEND_ERROR);
  });

  it("starts a fresh confirmation grace after the prior outbox scope is removed", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "live send payload");
          const runId = String(payload.idempotencyKey);
          return Promise.resolve({ runId, status: "started" });
        },
      },
    });

    await handleSendChat(host, "reuse this delivery version");
    host.chatRunId = null;
    await flushChatQueueForEvent(host);

    const item = expectDefined(host.chatQueue[0], "queued live send");
    const sessionKey = expectDefined(item.sessionKey, "queued session key");
    expect(removeQueuedMessage(host, item.id)).toBe("removed");

    now = 5_500;
    expect(admitQueuedMessageForSession(host, sessionKey, item)).toBe(true);
    expect(setTransientQueuedMessageProjection(host, sessionKey, item)).toBe(true);
    await flushChatQueueForEvent(host);

    now = 6_001;
    await flushChatQueueForEvent(host);

    expect(host.chatQueue[0]).toMatchObject({
      id: item.id,
      sendState: "sending",
      text: "reuse this delivery version",
    });
    expect(host.lastError).toBeNull();
  });

  it("coalesces duplicate queued local commands while the first command is running", async () => {
    const command = createDeferred<{ content: string }>();
    executeSlashCommandMock.mockImplementation(() => command.promise);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory(),
      },
    });

    const first = handleSendChat(host, "/compact");
    await waitForFast(() => expect(executeSlashCommandMock).toHaveBeenCalledOnce());
    const duplicate = handleSendChat(host, "/compact");

    try {
      expect(host.chatQueue.filter((item) => item.localCommandName === "compact")).toHaveLength(1);
      expect(executeSlashCommandMock).toHaveBeenCalledOnce();
    } finally {
      command.resolve({ content: "Compaction complete." });
      await Promise.all([first, duplicate]);
    }

    expect(executeSlashCommandMock).toHaveBeenCalledOnce();
  });

  it("keeps normal prompt text visible as pending until chat.send is acknowledged", async () => {
    const sent = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => sent.promise,
      },
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
    const request = makeRequestMock({
      "chat.history": () => Promise.resolve(idleChatHistory()),
      "chat.send": () => sent.promise,
    });
    const client = clientWithRequest(request);
    const item = {
      id: "late-pane-live-send",
      text: "keep late panes read-only",
      createdAt: 1,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      client,
      chatQueue: [item],
    });
    const stalePeer = makeChatHost({ client, chatQueue: [{ ...item }] });
    expect(admitQueuedMessageForSession(host, host.sessionKey, item)).toBe(true);

    const send = retryReconnectableQueuedChatSends(host);
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1),
    );
    const runId = host.chatQueue[0]?.sendRunId;
    expect(runId).toMatch(uuidPattern);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue[0]?.sendState).toBe(
      "waiting-reconnect",
    );

    const latePeer = makeChatHost({ client, chatQueue: [] });
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => sent.promise,
      },
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

  it("sends replyToId instead of an inline quote when the reply target has a transcript id", async () => {
    const sent = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => sent.promise,
      },
      chatMessage: "continue",
      chatReplyTarget: {
        messageId: "id:transcript-abc",
        text: "quoted body",
        senderLabel: "Molty",
        sourceMessageId: "transcript-abc",
      },
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    expect(host.chatQueue[0]?.text).toBe("continue");
    expect(host.chatQueue[0]?.replyToId).toBe("transcript-abc");

    sent.resolve({ runId: host.chatQueue[0]?.sendRunId, status: "started" });
    await send;

    const sendCall = host.request.mock.calls.find(([method]) => method === "chat.send");
    expect(sendCall?.[1]).toMatchObject({ message: "continue", replyToId: "transcript-abc" });
    expect(host.chatReplyTarget).toBeNull();
  });

  it("keeps reply state when chat.send fails before acceptance", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => Promise.resolve({ runId: "run-failed", status: "error" }),
      },
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

  it("keeps delayed chat.send ACK effects scoped to the submitted session", async () => {
    const sent = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => sent.promise,
      },
      chatMessage: "stay with session A",
      sessionKey: "agent:a",
    });

    const send = handleSendChat(host);
    await Promise.resolve();

    const queuedRunId = host.chatQueue[0]?.sendRunId;
    expect(queuedRunId).toEqual(expect.any(String));

    writeChatQueueForScope(host, "agent:a", host.chatQueue);
    host.sessionKey = "agent:b";
    syncVisibleChatQueueProjection(host);
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
    expect(readChatQueueForScope(host, "agent:a")).toEqual([
      expect.objectContaining({ sendState: "sending", text: "stay with session A" }),
    ]);
  });

  it("keeps a pre-ack socket close recoverable with the same run id", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new Error("gateway closed (1006): network lost");
        },
      },
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

  it("keeps an acknowledged send pending when durable retirement fails", async () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    const remove = storage.removeItem.bind(storage);
    let rejectWrites = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (rejectWrites) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.spyOn(storage, "removeItem").mockImplementation((key) => {
      if (rejectWrites) {
        throw new DOMException("storage blocked", "SecurityError");
      }
      remove(key);
    });
    vi.stubGlobal("sessionStorage", storage);

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          rejectWrites = true;
          const payload = requireRecord(params, "acknowledged durable send payload");
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      },
      chatMessage: "keep until durable retirement succeeds",
    });

    await handleSendChat(host);

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendAttempts: 1,
        sendState: "sending",
        text: "keep until durable retirement succeeds",
      }),
    ]);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
    expect(host.applySettings).not.toHaveBeenCalled();
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

    const replyTarget = {
      messageId: "reply-before-ack",
      text: "quoted body",
      senderLabel: "User",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "chat send payload");
          attemptedRunId ??= payload.idempotencyKey;
          sendAttempts += 1;
          if (sendAttempts === 1) {
            rejectWrites = true;
            throw new Error("gateway closed (1006): network lost");
          }
          return { runId: payload.idempotencyKey, status: "started" };
        },
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        },
      },
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
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);

    rejectWrites = false;
    setItemSpy.mockRestore();
    await retryQueuedChatMessage(host, host.chatQueue[0]?.id ?? "missing");

    const sendPayloads = host.request.mock.calls
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new Error("gateway not connected");
        },
      },
      chatMessage: "safe to restore",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("safe to restore");
    expect(host.chatQueue).toStrictEqual([]);
    expect(host.request).toHaveBeenCalledTimes(1);
  });

  it("sends a connected attachment when browser quota rejects durable admission", async () => {
    const storage = createStorageMock();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    vi.stubGlobal("sessionStorage", storage);

    const attachment = {
      id: "large-connected-attachment",
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
      fileName: "large.pdf",
      mimeType: "application/pdf",
      sizeBytes: 20 * 1024 * 1024,
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "volatile connected send payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      chatAttachments: [attachment],
      chatMessage: "send the large file",
    });

    await handleSendChat(host);

    const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "volatile retry payload");
          runIds.push(payload.idempotencyKey);
          if (runIds.length === 1) {
            throw new Error("gateway closed (1006): network lost");
          }
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "failed volatile retry payload");
          runIds.push(payload.idempotencyKey);
          return runIds.length === 1
            ? firstAttempt.promise
            : Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
        },
      },
      chatMessage: "retry after definite failure",
    });

    const sending = handleSendChat(host);
    await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => volatileSend.promise,
      },
      chatMessage: "volatile first",
    });

    const firstSend = handleSendChat(host);
    await waitForFast(() => expect(host.request).toHaveBeenCalledOnce());
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
    const request = makeRequestMock({});
    const host = makeChatHost({
      connected: false,
      chatMessage: "durable first",
    });
    await handleSendChat(host);

    host.connected = true;
    host.client = clientWithRequest(request);
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          rejectWrites = true;
          return sent.promise;
        },
      },
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
    const host = makeChatHost({
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

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": {
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        },
        "chat.send": (params: unknown) => {
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
        },
      },
      chatMessage: "retry without disconnecting",
    });

    vi.useFakeTimers();
    try {
      await handleSendChat(host);

      expect(host.connected).toBe(true);
      expect(host.chatQueue[0]).toMatchObject({
        sendAttempts: 0,
        sendState: "waiting-reconnect",
      });
      expect(sendAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      // The retry timer only kicks off a fire-and-forget drain, so the resend
      // lands after the tick returns. Wait for the outcome, not the tick.
      await waitForFast(() => {
        expect(sendAttempts).toBe(2);
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      });
      expect(sendRunIds[1]).toBe(sendRunIds[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries reconnect history after a retryable response without a socket close", async () => {
    const host = makeChatHost({
      client: null,
      connected: false,
      chatMessage: "retry history while connected",
    });
    await handleSendChat(host);
    let historyAttempts = 0;
    let sendAttempts = 0;
    const request = makeRequestMock({
      "chat.history": () => {
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
      },
      "chat.send": (params: unknown) => {
        sendAttempts += 1;
        const payload = requireRecord(params, "history retry send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      },
    });
    host.client = clientWithRequest(request);
    host.connected = true;

    vi.useFakeTimers();
    try {
      await retryReconnectableQueuedChatSends(host);

      expect(historyAttempts).toBe(1);
      expect(sendAttempts).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      // Same fire-and-forget retry hand-off as the send-rejection case above.
      await waitForFast(() => {
        expect(sendAttempts).toBe(1);
        expect(historyAttempts).toBeGreaterThanOrEqual(2);
        expect(listStoredChatOutboxes(host)).toStrictEqual([]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists queueable local commands entered while disconnected", async () => {
    executeSlashCommandMock.mockResolvedValueOnce({ content: "Thinking level set." });
    const request = makeRequestMock({
      "chat.history": {
        messages: [],
        sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
      },
    });
    const attachment = {
      id: "offline-command-attachment",
      dataUrl: "data:text/plain;base64,dGVzdA==",
      fileName: "notes.txt",
      mimeType: "text/plain",
    };
    const host = makeChatHost({
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

    host.client = clientWithRequest(request);
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
    const request = makeRequestMock({
      "chat.history": () => {
        historyRequests += 1;
        if (historyRequests === 1) {
          return startupHistory.promise;
        }
        return Promise.resolve({
          messages: [],
          sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
        });
      },
    });
    const host = makeChatHost({
      client: null,
      connected: false,
      chatMessage: "/think high",
    });
    await handleSendChat(host);

    host.client = clientWithRequest(request);
    host.connected = true;
    const replay = retryReconnectableQueuedChatSends(host);
    await waitForFast(() => expect(historyRequests).toBe(1));
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
    const host = makeChatHost({
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
    const host = makeChatHost({
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
    const host = makeChatHost({
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
    const request = makeRequestMock({
      "chat.history": () =>
        Promise.resolve({
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        }),
      "chat.send": () => Promise.resolve({ runId: "run-work", status: "started" }),
    });
    const host = makeChatHost({
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
    host.client = clientWithRequest(request);
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    const payload = findRequestPayload(request, "chat.send", "queued global send payload");
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
    const request = makeRequestMock({
      "chat.history": () =>
        Promise.resolve({
          messages: [],
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        }),
      "chat.send": (params: unknown) => {
        const payload = requireRecord(params, "canonical alias payload");
        return Promise.resolve({ runId: payload.idempotencyKey, status: "started" });
      },
    });
    const host = makeChatHost({
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
    host.client = clientWithRequest(request);
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    expect(findRequestPayload(request, "chat.send", "canonical alias")).toMatchObject({
      agentId: "work",
      message: "survive alias canonicalization",
      sessionKey: "global",
    });
  });

  it("abandons stale reconnect history after the connection epoch changes", async () => {
    const history = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => history.promise,
      },
      assistantAgentId: "work",
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
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", expect.anything()),
    );
    host.connectionEpoch = 2;
    history.resolve({
      messages: [],
      sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
    });
    await retry;

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
  });

  it("reruns a stale in-flight drain when reconnect schedules the current epoch", async () => {
    const staleHistory = createDeferred<unknown>();
    let historyRequests = 0;

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          historyRequests += 1;
          if (historyRequests === 1) {
            return staleHistory.promise;
          }
          return Promise.resolve({
            messages: [],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "current epoch send payload");
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
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
    await waitForFast(() => expect(historyRequests).toBe(1));
    host.connectionEpoch = 2;
    const reconnectRetry = retryReconnectableQueuedChatSends(host);
    staleHistory.resolve({
      messages: [],
      sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
    });
    await Promise.all([staleRetry, reconnectRetry]);

    // Two reconciliation reads plus the post-delivery transcript refresh.
    expect(historyRequests).toBe(3);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("reruns blocked history when a terminal wakeup arrives during reconciliation", async () => {
    const activeHistory = createDeferred<unknown>();
    let historyRequests = 0;

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          historyRequests += 1;
          if (historyRequests === 1) {
            return activeHistory.promise;
          }
          return Promise.resolve({
            messages: [],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          });
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "terminal wakeup send payload");
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
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
    await waitForFast(() => expect(historyRequests).toBe(1));
    const terminalWakeup = flushChatQueueForEvent(host);
    activeHistory.resolve({
      messages: [],
      sessionInfo: row("agent:main", { hasActiveRun: true, status: "running" }),
    });
    await Promise.all([initialDrain, terminalWakeup]);

    // Two reconciliation reads plus the post-delivery transcript refresh.
    expect(historyRequests).toBe(3);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("keeps a reconnect send queued when attempt persistence fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
      },
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
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.lastError).toBe(
      "Could not store this message for reconnect. Free browser storage or reconnect before sending.",
    );
  });

  it.each(["waiting-reconnect", "unconfirmed"] as const)(
    "removes a %s send with history proof before stale local busy state blocks it",
    async (sendState) => {
      const host = makeChatHost({
        requestHandlers: {
          "chat.history": () =>
            Promise.resolve({
              messages: [
                {
                  role: "user",
                  __openclaw: { idempotencyKey: "ambiguous-run:user" },
                },
              ],
              sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
            }),
        },
        chatRunId: "ambiguous-run",
        chatQueue: [
          {
            id: "ambiguous-delivered",
            text: "already delivered",
            createdAt: 1,
            sendAttempts: 1,
            sendRunId: "ambiguous-run",
            sendState,
            sessionKey: "agent:main",
          },
        ],
      });
      admitHostQueueItems(host);

      await retryReconnectableQueuedChatSends(host);

      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
      expect(host.chatQueue).toStrictEqual([]);
    },
  );

  it("rechecks an idle history snapshot before parking a delivered send", async () => {
    let historyRequests = 0;

    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
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
        },
      },
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
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("stops delivered-send reconciliation when durable removal fails", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const remove = storage.removeItem.bind(storage);

    const item = {
      id: "delivered-removal-failure",
      text: "already delivered but still durable",
      createdAt: 1,
      sendAttempts: 1,
      sendRunId: "delivered-removal-failure",
      sendState: "waiting-reconnect" as const,
      sessionKey: "agent:main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            messages: [
              {
                role: "user",
                __openclaw: { idempotencyKey: "delivered-removal-failure:user" },
              },
            ],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
      },
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

    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(failedDeletes).toBe(1);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.id).toBe(item.id);
  });

  it("parks an ambiguous reconnect send when idle history cannot prove delivery", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            messages: [],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
      },
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

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            messages: [],
            sessionInfo: row("agent:main", { hasActiveRun: true, status: "done" }),
          }),
      },
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

    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue[0]?.sendState).toBe("waiting-reconnect");
  });

  it("skips a manually failed head when replaying a later reconnect send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () =>
          Promise.resolve({
            messages: [],
            sessionInfo: row("agent:main", { hasActiveRun: false, status: "done" }),
          }),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "reconnect tail payload");
          return Promise.resolve({ runId: payload.idempotencyKey, status: "ok" });
        },
      },
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

    expect(findRequestPayload(host.request, "chat.send", "tail")).toMatchObject({
      idempotencyKey: "reconnect-tail-run",
      message: "safe automatic tail",
    });
    expect(host.chatQueue.map((item) => item.id)).toEqual(["manual-head"]);
  });

  it("keeps the sole failed queue item when an offline manual retry cannot persist", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("sessionStorage", storage);
    const host = makeChatHost({
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
    const request = makeRequestMock({
      "chat.history": () =>
        Promise.resolve({
          sessionInfo: row("global", { kind: "global", hasActiveRun: false, status: "done" }),
        }),
      "chat.send": () => Promise.resolve({ runId: "run-work", status: "started" }),
    });
    const host = makeChatHost({
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
    host.client = clientWithRequest(request);
    host.connected = true;
    await retryReconnectableQueuedChatSends(host);

    const payload = findRequestPayload(request, "chat.send", "queued global send payload");
    expect(payload.sessionKey).toBe("global");
    expect(payload.agentId).toBe("work");
    expect(loadChatComposerSnapshot({ ...host, assistantAgentId: "main" }, "global")).toBeNull();
    expect(
      loadChatComposerSnapshot({ ...host, assistantAgentId: "work" }, "global")?.queue,
    ).toEqual([expect.objectContaining({ sendAttempts: 1, sendState: "waiting-reconnect" })]);
  });

  it("marks saved session queued sends waiting after a disconnect", () => {
    const host = makeChatHost({ chatQueue: [] });
    writeChatQueueForScope(host, "agent:a", [
      {
        id: "pending-send-a",
        text: "pending",
        createdAt: 1,
        sendRunId: "run-a",
        sendState: "sending",
        sessionKey: "agent:a",
      },
    ]);

    markQueuedChatSendsWaitingForReconnect(host);

    expect(readChatQueueForScope(host, "agent:a")[0]).toMatchObject({
      sendRunId: "run-a",
      sendState: "waiting-reconnect",
    });
  });

  it("keeps the rendered-history leaf after a background branch refresh", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.branches.list": {
          branches: [
            {
              leafEntryId: "leaf-server-new",
              headline: "New active branch",
              messageCount: 3,
              active: true,
            },
          ],
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "foreground send payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      chatDisplayedLeafEntryId: "leaf-rendered",
      chatBranches: [],
      chatBranchesSessionKey: "agent:main",
      chatBranchesConnectionEpoch: 0,
      connectionEpoch: 0,
      chatMessage: "stay on this branch",
    });

    await loadChatBranches(host);
    expect(host.chatBranches).toEqual([
      expect.objectContaining({ leafEntryId: "leaf-server-new", active: true }),
    ]);
    expect(host.chatDisplayedLeafEntryId).toBe("leaf-rendered");

    await handleSendChat(host);

    expect(findRequestPayload(host.request, "chat.send", "foreground send")).toMatchObject({
      expectedLeafEntryId: "leaf-rendered",
    });
  });

  it("attaches an authoritative empty displayed leaf to a foreground send", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "empty-leaf send payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      chatDisplayedLeafEntryId: null,
      chatMessage: "first message",
    });

    await handleSendChat(host);

    expect(findRequestPayload(host.request, "chat.send", "empty-leaf send")).toHaveProperty(
      "expectedLeafEntryId",
      null,
    );
  });

  it("waits for terminal history reconciliation before sending a follow-up", async () => {
    const history = createDeferred<unknown>();
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => history.promise,
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "reconciled follow-up payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      chatDisplayedLeafEntryId: "leaf-before-terminal",
      chatMessage: "immediate follow-up",
    });
    const historyLoad = loadChatHistory(host);

    const sending = handleSendChat(host);
    await Promise.resolve();
    const sendsBeforeHistory = host.request.mock.calls.filter(
      ([method]) => method === "chat.send",
    ).length;
    history.resolve({
      messages: [],
      sessionInfo: {
        activeLeafEntryId: "leaf-after-terminal",
        key: "agent:main",
        sessionId: "session-main",
      },
    });
    await Promise.all([historyLoad, sending]);

    expect(sendsBeforeHistory).toBe(0);
    expect(findRequestPayload(host.request, "chat.send", "follow-up send")).toMatchObject({
      expectedLeafEntryId: "leaf-after-terminal",
    });
  });

  it("omits the active leaf when draining a restored outbox", async () => {
    const host = makeChatHost({
      client: null,
      connected: false,
      chatDisplayedLeafEntryId: "leaf-current",
      chatBranches: [
        { leafEntryId: "leaf-current", headline: "Current", messageCount: 2, active: true },
      ],
      chatBranchesSessionKey: "agent:main",
      chatMessage: "send after reconnect",
    });
    await handleSendChat(host);

    const request = makeRequestMock({
      "chat.history": idleChatHistory(),
      "chat.send": (params: unknown) => {
        const payload = requireRecord(params, "restored send payload");
        return { runId: payload.idempotencyKey, status: "ok" };
      },
    });
    host.client = clientWithRequest(request);
    host.connected = true;

    await retryReconnectableQueuedChatSends(host);

    expect(findRequestPayload(request, "chat.send", "restored send")).not.toHaveProperty(
      "expectedLeafEntryId",
    );
  });

  it("preserves a foreground leaf past an earlier outbox row", async () => {
    const sends: Record<string, unknown>[] = [];
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": idleChatHistory(),
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "queued foreground send payload");
          sends.push(payload);
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      },
      chatDisplayedLeafEntryId: "leaf-before-queue",
      chatBranches: [
        { leafEntryId: "leaf-before-queue", headline: "Current", messageCount: 2, active: true },
      ],
      chatBranchesSessionKey: "agent:main",
      chatMessage: "second message",
      chatQueue: [
        {
          id: "earlier-row",
          text: "first message",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "earlier-run",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await handleSendChat(host);

    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ message: "second message" });
    expect(sends[1]).toMatchObject({ expectedLeafEntryId: "leaf-before-queue" });
  });

  it("parks an active-leaf rejection, restores the draft, and refreshes branch state", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "active branch changed; review and resend",
            details: { reason: "active-leaf-changed" },
          });
        },
        "chat.history": idleChatHistory(),
        "sessions.branches.list": { branches: [] },
      },
      chatDisplayedLeafEntryId: "leaf-stale",
      chatBranches: [
        { leafEntryId: "leaf-stale", headline: "Stale", messageCount: 2, active: true },
      ],
      chatBranchesSessionKey: "agent:main",
      chatMessage: "stale branch prompt",
    });

    await handleSendChat(host);
    await waitForFast(() => {
      expect(host.request).toHaveBeenCalledWith("chat.history", {
        sessionKey: "agent:main",
        limit: 100,
      });
      expect(host.request).toHaveBeenCalledWith("sessions.branches.list", {
        sessionKey: "agent:main",
      });
    });

    expect(host.chatMessage).toBe("stale branch prompt");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        sendError: "The session switched branches — review and resend.",
        sendState: "failed",
      }),
    ]);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });

  it("marks validation failures visible and restores the composer", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": () => {
          throw new Error("send blocked by session policy");
        },
      },
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

  it("clears chat state when /clear resets chat history", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": {
          messages: [],
          thinkingLevel: null,
          sessionInfo: { activeLeafEntryId: null },
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "post-clear send payload");
          return { runId: payload.idempotencyKey, status: "started" };
        },
      },
      sessionKey: "main",
      chatDisplayedLeafEntryId: "leaf-before-clear",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatRunError: { summary: "Error: previous run failed" },
    });

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: "main" });
    expect(host.chatMessages).toStrictEqual([]);
    expect(host.chatRunError).toBeNull();
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
    expect(host.chatDisplayedLeafEntryId).toBeUndefined();

    host.chatMessage = "after clear";
    await handleSendChat(host);

    expect(findRequestPayload(host.request, "chat.send", "post-clear send")).not.toHaveProperty(
      "expectedLeafEntryId",
    );
  });

  it("preserves the replacement route leaf when post-clear history resolves late", async () => {
    const history = createDeferred<unknown>();
    const sourceSessionKey = "agent:main:source";
    const replacementSessionKey = "agent:main:replacement";
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": () => history.promise,
      },
      sessionKey: sourceSessionKey,
      chatDisplayedLeafEntryId: "source-leaf",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
    });

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", {
        sessionKey: sourceSessionKey,
        limit: 100,
      }),
    );
    host.sessionKey = replacementSessionKey;
    host.chatDisplayedLeafEntryId = "replacement-leaf";
    history.resolve({
      messages: [],
      sessionInfo: { activeLeafEntryId: null },
      thinkingLevel: null,
    });
    await clearing;

    expect(host.chatDisplayedLeafEntryId).toBe("replacement-leaf");
  });

  it("preserves the replacement connection leaf when post-clear history resolves late", async () => {
    const history = createDeferred<unknown>();
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": () => history.promise,
      },
      connectionEpoch: 1,
      chatDisplayedLeafEntryId: "source-leaf",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
    });

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.history", {
        sessionKey: "agent:main",
        limit: 100,
      }),
    );
    host.client = clientWithRequest(makeRequestMock());
    host.connectionEpoch = 2;
    host.chatDisplayedLeafEntryId = "replacement-leaf";
    history.resolve({
      messages: [],
      sessionInfo: { activeLeafEntryId: null },
      thinkingLevel: null,
    });
    await clearing;

    expect(host.chatDisplayedLeafEntryId).toBe("replacement-leaf");
  });

  it("keeps the prior branch precondition when post-clear history cannot verify reset state", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": () => {
          throw new Error("history unavailable");
        },
      },
      chatDisplayedLeafEntryId: "leaf-before-clear",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
    });

    await handleSendChat(host);

    expect(host.chatDisplayedLeafEntryId).toBe("leaf-before-clear");
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);
  });

  it("scopes /clear resets for selected-agent global sessions", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": { ok: true },
        "chat.history": { messages: [], thinkingLevel: null },
      },
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatMessagesBySession: new Map(),
    });
    const cache = requireChatMessageCache(host);
    cacheChatMessages(cache, host, { sessionKey: "global", agentId: "work" }, [
      { role: "assistant", content: "work history" },
    ]);
    cacheChatMessages(cache, host, { sessionKey: "global", agentId: "main" }, [
      { role: "assistant", content: "main history" },
    ]);

    await handleSendChat(host);

    expect(host.request).toHaveBeenCalledWith("sessions.reset", {
      key: "global",
      agentId: "work",
    });
    expect(host.request).toHaveBeenCalledWith("chat.history", {
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

    const sourceSessionKey = "agent:main:source";
    const visibleSessionKey = "agent:main:visible";
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => reset.promise,
      },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
      chatMessagesBySession: new Map(),
      chatRunId: null,
      sessionKey: sourceSessionKey,
    });
    const cache = requireChatMessageCache(host);
    cacheChatMessages(cache, host, { sessionKey: sourceSessionKey }, [
      { role: "user", content: "source history" },
    ]);
    cacheChatMessages(cache, host, { sessionKey: visibleSessionKey }, [
      { role: "user", content: "visible history" },
    ]);

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: sourceSessionKey }),
    );
    writeChatQueueForScope(host, sourceSessionKey, host.chatQueue);
    host.sessionKey = visibleSessionKey;
    syncVisibleChatQueueProjection(host);
    host.chatMessages = [{ role: "user", content: "visible history" }];
    host.chatRunId = "visible-run";
    reset.resolve({ ok: true });
    await clearing;

    expect(host.chatMessages).toEqual([{ role: "user", content: "visible history" }]);
    expect(host.chatRunId).toBe("visible-run");
    expect(host.chatMessagesBySession?.has(sourceSessionKey)).toBe(false);
    expect(
      readChatMessagesFromCache(host.chatMessagesBySession ?? new Map(), host, {
        sessionKey: visibleSessionKey,
      }),
    ).toEqual([{ role: "user", content: "visible history" }]);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("invalidates the captured session cache without replacing the visible route error", async () => {
    const reset = createDeferred<unknown>();

    const sourceSessionKey = "agent:main:source";
    const visibleSessionKey = "agent:main:visible";
    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => reset.promise,
      },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "source history" }],
      chatMessagesBySession: new Map(),
      sessionKey: sourceSessionKey,
    });
    const cache = requireChatMessageCache(host);
    cacheChatMessages(cache, host, { sessionKey: sourceSessionKey }, [
      { role: "user", content: "cached source history" },
    ]);
    cacheChatMessages(cache, host, { sessionKey: visibleSessionKey }, [
      { role: "user", content: "cached visible history" },
    ]);

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: sourceSessionKey }),
    );
    writeChatQueueForScope(host, sourceSessionKey, host.chatQueue);
    host.sessionKey = visibleSessionKey;
    syncVisibleChatQueueProjection(host);
    host.chatMessages = [{ role: "user", content: "visible history" }];
    host.lastError = "Visible session error";
    host.chatError = "Visible session error";
    reset.reject(new Error("post-commit lifecycle failed"));
    await clearing;

    expect(host.chatMessagesBySession?.has(sourceSessionKey)).toBe(false);
    expect(
      readChatMessagesFromCache(host.chatMessagesBySession ?? new Map(), host, {
        sessionKey: visibleSessionKey,
      }),
    ).toEqual([{ role: "user", content: "cached visible history" }]);
    expect(host.chatMessages).toEqual([{ role: "user", content: "visible history" }]);
    expect(host.lastError).toBe("Visible session error");
    expect(host.chatError).toBe("Visible session error");
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("retires an uncertain clear and refreshes replacement history without retrying", async () => {
    const reset = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => reset.promise,
      },
      connectionEpoch: 1,
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "do not clear ambiguously" }],
    });

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: "agent:main" }),
    );
    const queuedId = host.chatQueue[0]?.id ?? "missing-clear";
    const replacementRequest = makeRequestMock({
      "chat.history": {
        messages: [{ role: "assistant", content: "newer replacement history" }],
        thinkingLevel: null,
      },
    });
    host.client = clientWithRequest(replacementRequest);
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

    expect(host.request.mock.calls.filter(([method]) => method === "sessions.reset")).toHaveLength(
      1,
    );
    expect(
      replacementRequest.mock.calls.filter(([method]) => method === "sessions.reset"),
    ).toHaveLength(0);
  });

  it.each(["route", "connection"] as const)(
    "does not apply uncertain clear feedback after a %s change during history refresh",
    async (change) => {
      const reset = createDeferred<unknown>();
      const history = createDeferred<unknown>();
      const sourceSessionKey = "agent:main:source";
      const replacementRequest = makeRequestMock({
        "chat.history": () => history.promise,
      });
      const host = makeChatHost({
        requestHandlers: {
          "sessions.reset": () => reset.promise,
        },
        connectionEpoch: 1,
        chatMessage: "/clear",
        chatMessages: [{ role: "user", content: "source history" }],
        sessionKey: sourceSessionKey,
      });

      const clearing = handleSendChat(host);
      await waitForFast(() =>
        expect(host.request).toHaveBeenCalledWith("sessions.reset", { key: sourceSessionKey }),
      );
      host.client = clientWithRequest(replacementRequest);
      host.connectionEpoch = 2;
      reset.resolve({ ok: true });
      await waitForFast(() =>
        expect(replacementRequest).toHaveBeenCalledWith("chat.history", {
          sessionKey: sourceSessionKey,
          limit: 100,
        }),
      );
      const scrollGeneration = host.chatScrollGeneration;

      if (change === "route") {
        host.sessionKey = "agent:main:replacement";
      } else {
        host.client = clientWithRequest(makeRequestMock());
        host.connectionEpoch = 3;
      }
      host.lastError = "Replacement session error";
      host.chatError = "Replacement session error";
      history.resolve({ messages: [], thinkingLevel: null });
      await clearing;

      expect(host.lastError).toBe("Replacement session error");
      expect(host.chatError).toBe("Replacement session error");
      expect(host.chatScrollGeneration).toBe(scrollGeneration);
    },
  );

  it("clears a canonically equivalent alias that becomes visible while reset is pending", async () => {
    const reset = createDeferred<unknown>();

    const host = makeChatHost({
      requestHandlers: {
        "sessions.reset": () => reset.promise,
        "chat.history": () =>
          Promise.resolve({
            messages: [{ role: "assistant", content: "canonical refreshed history" }],
            thinkingLevel: null,
          }),
      },
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "alias history" }],
    });

    const clearing = handleSendChat(host);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("sessions.reset", {
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
    expect(host.request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "global",
      agentId: "work",
      limit: 100,
    });
    expect(listStoredChatOutboxes(host)).toStrictEqual([]);
  });

  it("shows a visible pending item for /steer on the active run", async () => {
    const host = makeChatHost({
      client: clientWithRequest(
        makeRequestMock({
          "chat.send": { status: "started", runId: "run-1", messageSeq: 2 },
        }),
      ),
      chatRunId: "run-1",
      chatMessage: "/steer tighten the plan",
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([
        row("agent:main:main", {
          activeLeafEntryId: "leaf-active",
          activeRunIds: ["run-1"],
          hasActiveRun: true,
          status: "running",
        }),
      ]),
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.text).toBe("/steer tighten the plan");
    expect(host.chatQueue[0]?.pendingRunId).toBe("run-1");
  });

  it("sends a queued row through the generic outbox with only its durable steer mode", async () => {
    const ack = createDeferred<unknown>();
    const original = {
      id: "queued-steer",
      text: "tighten the plan",
      createdAt: 1,
      sendRunId: "stable-steer-send",
      sendState: "waiting-idle" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeChatHost({
      requestHandlers: { "chat.send": () => ack.promise },
      chatRunId: "active-run",
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    const sending = steerQueuedChatMessage(host, original.id);
    await waitForFast(() =>
      expect(host.request).toHaveBeenCalledWith("chat.send", expect.anything()),
    );

    const payload = findRequestPayload(host.request, "chat.send", "queued steer payload");
    expect(payload).toMatchObject({
      sessionKey: original.sessionKey,
      message: original.text,
      queueMode: "steer",
      idempotencyKey: original.sendRunId,
    });
    expect(payload).not.toHaveProperty("expectedRunId");
    expect(payload).not.toHaveProperty("expectedLeafEntryId");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: original.id,
        queueMode: "steer",
        sendRunId: original.sendRunId,
        sendState: "sending",
      }),
    ]);
    expect(loadChatComposerSnapshot(host, host.sessionKey)?.queue).toEqual([
      expect.objectContaining({
        id: original.id,
        queueMode: "steer",
        sendRunId: original.sendRunId,
        sendState: "waiting-reconnect",
      }),
    ]);

    ack.resolve({ runId: original.sendRunId, status: "started" });
    await sending;
  });

  it("retries a failed steer row generically with the same idempotency key", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const original = {
      id: "failed-steer",
      text: "try again",
      createdAt: 1,
      queueMode: "steer" as const,
      sendAttempts: 1,
      sendError: "rejected",
      sendRunId: "stable-steer-send",
      sendState: "failed" as const,
      sessionKey: "agent:main:main",
      agentId: "main",
    };
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": (params: unknown) => {
          payloads.push(requireRecord(params, "retried steer payload"));
          return { runId: original.sendRunId, status: "ok" };
        },
      },
      chatQueue: [original],
      sessionKey: original.sessionKey,
    });
    expect(admitQueuedMessageForSession(host, host.sessionKey, original)).toBe(true);

    await retryQueuedChatMessage(host, original.id);

    expect(payloads).toEqual([
      expect.objectContaining({
        idempotencyKey: original.sendRunId,
        message: original.text,
        queueMode: "steer",
      }),
    ]);
    expect(payloads[0]).not.toHaveProperty("expectedRunId");
    expect(payloads[0]).not.toHaveProperty("expectedLeafEntryId");
  });

  it("removes generic pending-run indicators when the run finishes", () => {
    const host = makeChatHost({
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
    const host = makeChatHost({
      requestHandlers: {
        "chat.send": { status: "ok", runId: "run-1" },
      },
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
        __openclaw: { idempotencyKey: expect.stringMatching(/:user$/) },
      },
    ]);
  });

  it("releases queued attachment payloads once across duplicate removal", () => {
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
    const host = makeChatHost({
      chatQueue: [
        { id: "queued", text: "later", createdAt: 1, attachments: [attachment] },
        { id: "sibling", text: "keep me", createdAt: 2 },
      ],
    });

    expect(removeQueuedMessage(host, "queued")).toBe("removed");
    expect(removeQueuedMessage(host, "queued")).toBe("absent");

    expect(host.chatQueue).toEqual([expect.objectContaining({ id: "sibling" })]);
    expect(getChatAttachmentDataUrl(attachment)).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:queued");
  });

  it("surfaces a terminal send failure through the global toast when the pane is not visible", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": idleChatHistory("agent:other"),
        "chat.send": () => {
          throw new GatewayRequestError({
            code: "UNAUTHORIZED",
            message: "gateway auth failed",
            retryable: false,
          });
        },
      },
      chatQueue: [
        {
          id: "hidden-terminal-failure",
          text: "fails while another session is visible",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "hidden-terminal-run",
          sendState: "waiting-idle",
          sessionKey: "agent:other",
          agentId: "other",
        },
      ],
      sessionKey: "agent:main",
      sessionsResult: createSessionsResult([
        row("agent:other", { hasActiveRun: false, status: "done" }),
      ]),
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    // The invisible pane's inline error stays untouched; the failure surfaces globally.
    expect(host.lastError).toBeNull();
    await waitForFast(() => expect(document.body.textContent).toContain("gateway auth failed"));
    expect(
      listStoredChatOutboxes(host)
        .flatMap((outbox) => outbox.queue)
        .find((entry) => entry.id === "hidden-terminal-failure"),
    ).toMatchObject({ sendState: "failed", sendError: "gateway auth failed" });
    document.body.replaceChildren();
  });

  it("fails a never-attempted head visibly and unblocks the lane when head reconcile is rejected as non-retryable", async () => {
    const sends: string[] = [];
    let historyCalls = 0;
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          historyCalls += 1;
          if (historyCalls === 1) {
            throw new GatewayRequestError({
              code: "UNAUTHORIZED",
              message: "gateway auth failed",
              retryable: false,
            });
          }
          return idleChatHistory();
        },
        "chat.send": (params: unknown) => {
          const payload = requireRecord(params, "post-unblock send payload");
          sends.push(String(payload.message));
          return { runId: payload.idempotencyKey, status: "ok" };
        },
      },
      chatQueue: [
        {
          id: "wedged-head",
          text: "head the gateway rejects",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "wedged-head-run",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
        {
          id: "queued-behind-head",
          text: "message stuck behind the head",
          createdAt: 2,
          sendAttempts: 0,
          sendRunId: "queued-behind-run",
          sendState: "waiting-idle",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);
    const surfacedErrors: (string | null)[] = [];
    let trackedError: string | null = host.lastError ?? null;
    Object.defineProperty(host, "lastError", {
      get: () => trackedError,
      set: (value: string | null) => {
        trackedError = value;
        surfacedErrors.push(value);
      },
    });

    await retryReconnectableQueuedChatSends(host);

    // Pre-fix: the head stayed silently "blocked" forever and nothing surfaced.
    expect(surfacedErrors).toContain("gateway auth failed");
    const stored = listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue);
    expect(stored.find((entry) => entry.id === "wedged-head")).toMatchObject({
      sendState: "failed",
      sendError: "gateway auth failed",
    });
    // The lane moved past the terminally failed head instead of wedging.
    await waitForFast(() => expect(sends).toContain("message stuck behind the head"));
  });

  it("parks an attempted head as unconfirmed instead of failing it on a non-retryable reconcile rejection", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => {
          throw new GatewayRequestError({
            code: "UNAUTHORIZED",
            message: "gateway auth failed",
            retryable: false,
          });
        },
      },
      chatQueue: [
        {
          id: "attempted-head",
          text: "head that may have reached the server",
          createdAt: 1,
          sendAttempts: 1,
          sendRunId: "attempted-head-run",
          sendState: "waiting-reconnect",
          sessionKey: "agent:main",
        },
      ],
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    // An attempted head may already be a server-side turn; it must park for
    // review rather than fail-and-release, and the outcome must be visible.
    expect(host.lastError).toBe(
      "Delivery could not be confirmed after reconnect. Check the conversation before retrying.",
    );
    const stored = listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue);
    expect(stored.find((entry) => entry.id === "attempted-head")).toMatchObject({
      sendState: "unconfirmed",
    });
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  });

  it("surfaces a failed local command globally after a route switch", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const item = createQueuedLocalCommand("route-switched-command", "/think", {
      sessionKey: "agent:main:first",
    });
    // The dispatcher reports failure after the operator navigated away, so its
    // stale-scope guard withholds the inline error.
    executeSlashCommandMock.mockImplementation(async () => {
      host.sessionKey = "agent:main:second";
      return { failed: true, content: "think mode rejected" };
    });
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": () => idleChatHistory("agent:main:first"),
      },
      chatQueue: [item],
      sessionKey: item.sessionKey,
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    // Pre-fix: the failure was recorded on the queue item with no visible outcome.
    expect(host.lastError).toBeNull();
    await waitForFast(() => expect(document.body.textContent).toContain("Command /think failed."));
    expect(listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue)).toEqual([
      expect.objectContaining({ id: item.id, sendState: "failed" }),
    ]);
    document.body.replaceChildren();
  });

  it("names the failed agent's global session in the toast, not another agent's row", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    const host = makeChatHost({
      requestHandlers: {
        "chat.history": idleChatHistory("global"),
        "chat.send": () => {
          throw new GatewayRequestError({
            code: "UNAUTHORIZED",
            message: "gateway auth failed",
            retryable: false,
          });
        },
      },
      chatQueue: [
        {
          id: "global-agent-scoped-failure",
          text: "fails on the second agent's global session",
          createdAt: 1,
          sendAttempts: 0,
          sendRunId: "global-agent-scoped-run",
          sendState: "waiting-idle",
          sessionKey: "global",
          agentId: "writer",
        },
      ],
      sessionKey: "agent:main:elsewhere",
      sessionsResult: createSessionsResult([
        row("global", { agentId: "main", label: "Main global chat" }),
        row("global", { agentId: "writer", label: "Writer global chat" }),
      ]),
    });
    admitHostQueueItems(host);

    await retryReconnectableQueuedChatSends(host);

    await waitForFast(() => expect(document.body.textContent).toContain("gateway auth failed"));
    // Global rows share one key; the toast must borrow the failed agent's label.
    expect(document.body.textContent).toContain("Writer global chat");
    expect(document.body.textContent).not.toContain("Main global chat");
    document.body.replaceChildren();
  });
});

describe("handleAbortChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  it("preserves the draft for connected toolbar aborts", async () => {
    const host = makeChatHost({
      requestHandlers: {
        "chat.abort": { aborted: true },
      },
      chatRunId: "run-main",
      chatMessage: "next prompt",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(host.request).toHaveBeenCalledWith("chat.abort", {
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("next prompt");
    expect(host.chatRunId).toBe("run-main");
  });

  it("aborts the exact selected session when no browser run id exists", async () => {
    const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
    const sessionKey = "agent:main:openclaw-weixin:direct:wechat-user";
    const host = makeChatHost({
      client: clientWithRequest(request),
      chatRunId: null,
      chatMessage: "/stop",
      sessionKey,
      sessionsResult: createSessionsResult([
        row(sessionKey, { hasActiveRun: true, status: "running" }),
      ]),
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: sessionKey,
      clearQueued: true,
    });
    expect(request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    expect(host.chatMessage).toBe("");
  });

  it("keeps selected global aborts on the compatible key-only request", async () => {
    const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
    const host = makeChatHost({
      client: clientWithRequest(request),
      chatRunId: null,
      chatMessage: "/stop",
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      sessionsResult: createSessionsResult([
        row("global", { hasActiveRun: true, agentId: "work" } as Partial<GatewaySessionRow>),
      ]),
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", {
      key: "global",
      agentId: "work",
    });
  });

  it.each([
    {
      name: "clears queues for a per-sender agent main session",
      scope: "per-sender",
      expected: {
        key: "agent:work:main",
        agentId: "work",
        clearQueued: true,
      },
    },
    {
      name: "keeps a global-scope agent main alias on the compatible request",
      scope: "global",
      expected: {
        key: "agent:work:main",
        agentId: "work",
      },
    },
  ] as const)("$name", async ({ scope, expected }) => {
    const request = vi.fn(async () => ({ abortedRunId: null, status: "aborted" }));
    const sessionKey = "agent:work:main";
    const host = makeChatHost({
      client: clientWithRequest(request),
      chatRunId: null,
      sessionKey,
      agentsList: { defaultId: "main", mainKey: "main", scope },
      sessionsResult: createSessionsResult([
        row(sessionKey, { hasActiveRun: true, status: "running" }),
      ]),
    });

    await handleAbortChat(host);

    expect(request).toHaveBeenCalledWith("sessions.abort", expected);
  });

  it.each(["/stop", "stop", "esc", "abort", "wait", "exit"])(
    "clears the typed stop command %s after aborting the active run",
    async (message) => {
      const host = makeChatHost({
        requestHandlers: {
          "chat.abort": { aborted: true },
        },
        chatRunId: "run-main",
        chatMessage: message,
        sessionKey: "agent:main",
      });

      await handleSendChat(host);

      expect(host.request).toHaveBeenCalledWith("chat.abort", {
        runId: "run-main",
        sessionKey: "agent:main",
      });
      expect(host.chatMessage).toBe("");
    },
  );

  it("blocks a typed stop before aborting when the operator lacks write scope", async () => {
    const host = makeChatHost({
      requestHandlers: {},
      chatRunId: "run-main",
      chatMessage: "/stop",
      hello: gatewayHelloForMethods(["chat.abort"], ["operator.read"]),
      sessionKey: "agent:main",
      chatRunError: { summary: "Previous run failed" },
    });

    await handleSendChat(host);

    expect(host.request).not.toHaveBeenCalled();
    expect(host.lastError).toBeTruthy();
    expect(host.chatError).toBe(host.lastError);
    expect(host.chatMessage).toBe("/stop");
    expect(host.chatRunError).toEqual({ summary: "Previous run failed" });
  });

  it("queues a typed exact-run stop while disconnected", async () => {
    const request = vi.fn();
    const client = clientWithRequest(request);
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "/stop",
      sessionKey: "agent:main",
    });

    await handleSendChat(host);

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("queues the active run abort while disconnected", async () => {
    const client = clientWithRequest(vi.fn());
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "draft",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("");
    expect(host.chatRunId).toBe("run-main");
  });

  it("preserves the draft when queueing a toolbar abort while disconnected", async () => {
    const client = clientWithRequest(vi.fn());
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: "run-main",
      chatMessage: "draft",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host, { preserveDraft: true });

    expect(host.pendingAbort).toEqual({
      sourceClient: client,
      runId: "run-main",
      sessionKey: "agent:main",
    });
    expect(host.chatMessage).toBe("draft");
    expect(host.chatRunId).toBe("run-main");
  });

  it("does not queue an unversioned session stop while disconnected", async () => {
    const request = vi.fn();
    const client = clientWithRequest(request);
    const sessionKey = "agent:main:telegram:direct:queued-user";
    const host = makeChatHost({
      client,
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
      sessionKey,
      sessionsResult: createSessionsResult([
        row(sessionKey, { hasActiveRun: true }),
        row("agent:other", { hasActiveRun: true }),
      ]),
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not queue an unversioned global stop while disconnected", async () => {
    const request = vi.fn();
    const client = clientWithRequest(request);
    const host = makeChatHost({
      client,
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

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "ignores stale active-run flags once the current session is terminal",
      selected: { hasActiveRun: true, status: "done" as const },
    },
    {
      name: "ignores stale running status once the gateway reports no active run",
      selected: { hasActiveRun: false, status: "running" as const },
    },
  ])("$name", ({ selected }) => {
    const host = makeChatHost({
      chatRunId: null,
      sessionKey: "agent:main",
      sessionsResult: createSessionsResult([
        row("agent:main", selected),
        row("agent:other", { hasActiveRun: true, status: "running" }),
      ]),
    });

    expect(hasAbortableSessionRun(host)).toBe(false);
  });

  it("keeps the draft when disconnected without an active run", async () => {
    const host = makeChatHost({
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
