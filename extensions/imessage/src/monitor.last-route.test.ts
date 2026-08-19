// Imessage tests cover monitor.last route plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import {
  advanceIMessageRecoveryCursor,
  loadIMessageRecoveryCursor,
  resolveIMessageRecoveryCursorDbIdentity,
} from "./monitor/recovery-cursor.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import {
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const DEFAULT_SENDER = "+15550001111";
const ANCHOR_REPAIR_GUID = "11111111-1111-4111-8111-111111111111";
const WATCH_SUBSCRIBE_PARAMS = { attachments: false, include_reactions: true } as const;
const WATCH_SUBSCRIBE_OPTIONS = { timeoutMs: 10_000 } as const;
const EMPTY_DISPATCH_RESULT = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
} as const;

type IMessageTestRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type IMessageTestRequestResult =
  | Record<string, unknown>
  | ((params?: Record<string, unknown>) => unknown);
type ChatDbMessage = Required<
  Pick<IMessagePayload, "id" | "guid" | "sender" | "text" | "created_at">
>;
type MonitorRunParams = {
  accountId?: string;
  imessage?: Record<string, unknown>;
  session?: Record<string, unknown>;
  messages?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  runtime?: MonitorIMessageOpts["runtime"];
  allowlist?: boolean;
};
type ReplyDispatchParams = Parameters<typeof dispatchReplyWithBufferedBlockDispatcher>[0];
type WatchClientParams = {
  requests?: Record<string, IMessageTestRequestResult>;
  auxiliaryRequests?: Record<string, IMessageTestRequestResult>;
  message?: IMessagePayload;
  messages?: IMessagePayload[];
  onClose?: (notify: (message: IMessagePayload) => void) => Promise<void>;
  afterNotify?: () => Promise<void>;
};

function createIMessageTestRequest(
  results: Record<string, IMessageTestRequestResult>,
): IMessageTestRequest {
  return async (method, params) => {
    if (!Object.hasOwn(results, method)) {
      throw new Error(`unexpected imsg method ${method}`);
    }
    const result = results[method];
    return typeof result === "function" ? await result(params) : result;
  };
}

async function settleNotifications(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function withChatDb<T>(dbPath: string, run: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(dbPath);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

function createChatDbMessage(
  id: number,
  guid: string,
  text: string,
  createdAt = new Date().toISOString(),
): ChatDbMessage {
  return { id, guid, sender: DEFAULT_SENDER, text, created_at: createdAt };
}

const CHAT_DB_SCHEMA = "CREATE TABLE message (guid TEXT, sender TEXT, text TEXT, created_at TEXT);";
const CHAT_DB_INSERT =
  "INSERT INTO message(rowid, guid, sender, text, created_at) VALUES (?, ?, ?, ?, ?)";

function createChatDb(dbPath: string, messages: ChatDbMessage[] = []): void {
  withChatDb(dbPath, (database) => {
    database.exec(CHAT_DB_SCHEMA);
    const insert = database.prepare(CHAT_DB_INSERT);
    for (const message of messages) {
      insert.run(message.id, message.guid, message.sender, message.text, message.created_at);
    }
  });
}

function insertChatDbMessage(dbPath: string, message: ChatDbMessage): void {
  withChatDb(dbPath, (database) => {
    database
      .prepare(CHAT_DB_INSERT)
      .run(message.id, message.guid, message.sender, message.text, message.created_at);
  });
}

function readChatDbMessagesAfter(dbPath: string, rowid: number): IMessagePayload[] {
  return withChatDb(dbPath, (database) => {
    const messages = database
      .prepare(
        "SELECT rowid AS id, guid, sender, text, created_at FROM message WHERE rowid > ? ORDER BY rowid",
      )
      .all(rowid) as ChatDbMessage[];
    return messages.map((message) =>
      Object.assign(message, { chat_id: 123, is_from_me: false, is_group: false }),
    );
  });
}

function expireCachedPrivateApiStatus(): void {
  setCachedIMessagePrivateApiStatus(
    "imsg",
    { available: false, v2Ready: false, selectors: {}, rpcMethods: [] },
    1,
  );
  getCachedIMessagePrivateApiStatus("imsg");
}

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const dispatchReplyWithBufferedBlockDispatcherMock = vi.hoisted(() =>
  vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
);
const debouncerControl = vi.hoisted(() => ({
  holdEntries: false,
  entries: [] as unknown[],
  flush: undefined as undefined | (() => Promise<void>),
  flushEach: undefined as undefined | (() => Promise<void>),
  reset() {
    this.holdEntries = false;
    this.entries = [];
    this.flush = undefined;
    this.flushEach = undefined;
  },
}));
const createChannelInboundDebouncerMock = vi.hoisted(() =>
  vi.fn(
    (opts: {
      onFlush: (
        entries: unknown[],
        createFlush: typeof createTestInboundDebounceFlush,
      ) => { completion: Promise<void> };
    }) => ({
      debouncer: {
        enqueue: async (entry: unknown) => {
          if (!debouncerControl.holdEntries) {
            await opts.onFlush([entry], createTestInboundDebounceFlush).completion;
            return;
          }
          debouncerControl.entries.push(entry);
          debouncerControl.flush = async () => {
            const entries = debouncerControl.entries.splice(0);
            await opts.onFlush(entries, createTestInboundDebounceFlush).completion;
          };
          // Flush each collected entry as its own single-entry bucket, modeling
          // the real non-debounced path (shouldDebounceTextInbound is mocked to
          // false here) where every row dispatches individually.
          debouncerControl.flushEach = async () => {
            const entries = debouncerControl.entries.splice(0);
            for (const queued of entries) {
              await opts.onFlush([queued], createTestInboundDebounceFlush).completion;
            }
          };
        },
        flushKey: async () => {},
        cancelKey: () => false,
        drain: async () => {},
      },
    }),
  ),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: createChannelInboundDebouncerMock,
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

type RunChannelInboundEventParams = Parameters<typeof channelInbound.runChannelInboundEvent>[0];
const runChannelInboundEventActual = channelInbound.runChannelInboundEvent;

async function runChannelInboundEventForLastRouteTest(params: RunChannelInboundEventParams) {
  return await runChannelInboundEventActual({
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (input, eventClass, preflight) => {
        const turn = await params.adapter.resolveTurn(input, eventClass, preflight);
        if (!("route" in turn) || !("delivery" in turn)) {
          throw new Error("expected assembled iMessage channel turn plan");
        }
        const { route, ...resolvedTurn } = turn;
        return {
          ...resolvedTurn,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath: resolveStorePath(turn.cfg.session?.store, { agentId: route.agentId }),
          recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
        };
      },
    },
  });
}

describe("iMessage monitor last-route updates", () => {
  const tempDirs: string[] = [];
  const openClawStates: OpenClawTestState[] = [];

  beforeEach(() => {
    vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(
      runChannelInboundEventForLastRouteTest as typeof channelInbound.runChannelInboundEvent,
    );
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
    createChannelInboundDebouncerMock.mockClear();
    debouncerControl.reset();
    expireCachedPrivateApiStatus();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(openClawStates.splice(0).map((state) => state.cleanup()));
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function setAvailablePrivateApiMethods(rpcMethods: string[]): void {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods,
    });
  }

  function createInboundMessage(
    message: Pick<IMessagePayload, "id" | "guid" | "text"> &
      Partial<
        Pick<
          IMessagePayload,
          | "chat_id"
          | "chat_guid"
          | "chat_identifier"
          | "sender"
          | "is_from_me"
          | "is_group"
          | "created_at"
        >
      >,
  ): IMessagePayload {
    return {
      id: message.id,
      guid: message.guid,
      chat_id: message.chat_id ?? 123,
      chat_guid: message.chat_guid,
      chat_identifier: message.chat_identifier,
      sender: message.sender ?? DEFAULT_SENDER,
      is_from_me: message.is_from_me ?? false,
      text: message.text,
      is_group: message.is_group ?? false,
      created_at: message.created_at ?? new Date().toISOString(),
    };
  }

  it.each([
    {
      label: "SMS chat with service unset",
      configuredService: undefined,
      chatGuid: "SMS;-;+15550001111",
      expectedService: "sms",
    },
    {
      label: "SMS chat with service auto",
      configuredService: "auto",
      chatGuid: "SMS;-;+15550001111",
      expectedService: "sms",
    },
    {
      label: "iMessage chat with service unset",
      configuredService: undefined,
      chatGuid: "iMessage;-;+15550001111",
      expectedService: "imessage",
    },
    {
      label: "explicit SMS override for an iMessage chat",
      configuredService: "sms",
      chatGuid: "iMessage;-;+15550001111",
      expectedService: "sms",
    },
    {
      label: "explicit iMessage override for an SMS chat",
      configuredService: "imessage",
      chatGuid: "SMS;-;+15550001111",
      expectedService: "imessage",
    },
    {
      label: "unknown direct chat service",
      configuredService: undefined,
      chatGuid: "any;-;+15550001111",
      expectedService: "auto",
    },
    {
      label: "absent direct chat GUID",
      configuredService: undefined,
      chatGuid: undefined,
      expectedService: "auto",
    },
  ] as const)(
    "preserves the inbound direct service through early typing, final delivery, and last-route ($label)",
    async ({ label, configuredService, chatGuid, expectedService }) => {
      setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing", "read"]);
      const stateDir = createTestStateDir(
        `openclaw-imsg-direct-route-${label.replaceAll(" ", "-")}-`,
      );
      const configuredStore = path.join(stateDir, "sessions.json");
      const storePath = resolveStorePath(configuredStore, { agentId: "main" });
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver(
          { text: "reply over the originating service" },
          {
            kind: "final",
          },
        );
        return EMPTY_DISPATCH_RESULT;
      });
      const client = await runMessageCase({
        auxiliaryRequests: {
          read: { ok: true },
          send: { guid: "sms-reply-guid" },
          typing: { ok: true },
        },
        message: createInboundMessage({
          id: 101,
          guid: `direct-route-${expectedService}-${label}`,
          chat_guid: chatGuid,
          chat_identifier: "+15550001111",
          text: "reply to this direct chat",
        }),
        monitor: {
          imessage: configuredService ? { service: configuredService } : {},
          session: { dmScope: "per-channel-peer", store: configuredStore },
        },
      });
      const auxiliaryClient = client.auxiliaryClient!;

      await vi.waitFor(() => {
        expect(auxiliaryClient.request).toHaveBeenCalledWith(
          "typing",
          expect.objectContaining({ service: expectedService, to: DEFAULT_SENDER, typing: true }),
          expect.any(Object),
        );
      });
      const expectedReadTarget = chatGuid ? { chat_guid: chatGuid } : { to: DEFAULT_SENDER };
      expect(auxiliaryClient.request).toHaveBeenCalledWith(
        "read",
        expect.objectContaining(expectedReadTarget),
        expect.any(Object),
      );
      expect(auxiliaryClient.request).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          service: expectedService,
          text: "reply over the originating service",
          to: DEFAULT_SENDER,
        }),
        expect.any(Object),
      );
      const dispatchParams = dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.at(0)?.[0];
      expect(dispatchParams?.ctx).toMatchObject({
        From: `${expectedService}:${DEFAULT_SENDER}`,
        To: `${expectedService}:${DEFAULT_SENDER}`,
      });
      await vi.waitFor(() => {
        expect(
          getSessionEntry({
            storePath,
            sessionKey: `agent:main:imessage:direct:${DEFAULT_SENDER}`,
          }),
        ).toMatchObject({
          delivery: {
            context: { channel: "imessage", to: `${expectedService}:${DEFAULT_SENDER}` },
            route: { target: { to: `${expectedService}:${DEFAULT_SENDER}` } },
          },
        });
      });
    },
  );

  it("keeps group chat_id routing unchanged through final delivery", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing", "read"]);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver({ text: "group reply" }, { kind: "final" });
      return EMPTY_DISPATCH_RESULT;
    });
    const client = await runMessageCase({
      auxiliaryRequests: {
        read: { ok: true },
        send: { guid: "group-reply-guid" },
        typing: { ok: true },
      },
      message: createInboundMessage({
        id: 103,
        guid: "group-route-guid",
        chat_id: 456,
        chat_guid: "iMessage;+;chat456",
        is_group: true,
        text: "reply to this group",
      }),
      monitor: { allowlist: false, imessage: { groupPolicy: "open" } },
    });
    const auxiliaryClient = client.auxiliaryClient!;

    expect(auxiliaryClient.request).toHaveBeenCalledWith(
      "send",
      expect.objectContaining({ chat_id: 456, service: "auto", text: "group reply" }),
      expect.any(Object),
    );
    const dispatchParams = dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.at(0)?.[0];
    expect(dispatchParams?.ctx).toMatchObject({
      ChatType: "group",
      From: "imessage:group:456",
      To: "chat_id:456",
    });
  });

  function createAnchorlessDirectPair(id: number, text: string, isFromMe: boolean) {
    return {
      notification: {
        id,
        guid: ANCHOR_REPAIR_GUID,
        chat_id: 0,
        chat_guid: "",
        chat_identifier: "",
        sender: "+15550000001",
        destination_caller_id: "+15550000001",
        is_from_me: false,
        is_group: false,
        service: "iMessage",
        text,
        created_at: new Date().toISOString(),
      },
      history: {
        id,
        guid: ANCHOR_REPAIR_GUID,
        chat_id: 42,
        chat_guid: "iMessage;-;+15550000002",
        chat_identifier: "+15550000002",
        sender: "+15550000002",
        destination_caller_id: "+15550000001",
        is_from_me: isFromMe,
        is_group: false,
        service: "iMessage",
      },
    };
  }

  function createIMessageWatchClient(params: WatchClientParams = {}) {
    let onNotification:
      | NonNullable<NonNullable<Parameters<typeof createIMessageRpcClient>[0]>["onNotification"]>
      | undefined;
    const notify = (message: IMessagePayload) => {
      onNotification?.({ method: "message", params: { message } });
    };
    const messages = params.messages ?? (params.message ? [params.message] : undefined);
    const onClose =
      params.onClose ??
      (messages
        ? async (notifyMessage: (message: IMessagePayload) => void) => {
            for (const message of messages) {
              notifyMessage(message);
            }
            await settleNotifications();
            await params.afterNotify?.();
          }
        : undefined);
    const auxiliaryClient = params.auxiliaryRequests
      ? {
          request: vi.fn(createIMessageTestRequest(params.auxiliaryRequests)),
          stop: vi.fn(async () => {}),
        }
      : undefined;
    const client = {
      request: vi.fn(
        createIMessageTestRequest(params.requests ?? { "watch.subscribe": { subscription: 1 } }),
      ),
      waitForClose: vi.fn(() => onClose?.(notify) ?? Promise.resolve()),
      stop: vi.fn(async () => {}),
      auxiliaryClient,
    };
    createIMessageRpcClientMock.mockImplementation(async (clientParams) => {
      if (clientParams?.onNotification) {
        onNotification = clientParams.onNotification;
        return client as never;
      }
      if (auxiliaryClient) {
        return auxiliaryClient as never;
      }
      throw new Error("expected iMessage notification handler");
    });
    return client;
  }

  async function runIMessageMonitor(params: MonitorRunParams = {}): Promise<void> {
    await monitorIMessageProvider({
      ...(params.accountId ? { accountId: params.accountId } : {}),
      config: {
        channels: {
          imessage: {
            ...(params.allowlist === false
              ? {}
              : { dmPolicy: "allowlist", allowFrom: [DEFAULT_SENDER] }),
            ...params.imessage,
          },
        },
        messages: { inbound: { debounceMs: 0 }, ...params.messages },
        ...(params.agents ? { agents: params.agents } : {}),
        session: { mainKey: "main", ...params.session },
      } as never,
      runtime: params.runtime ?? { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });
  }

  function createTestStateDir(prefix: string): string {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(stateDir);
    return stateDir;
  }

  function seedChatDb(dbPath: string, label = "boundary"): void {
    withChatDb(dbPath, (database) => {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, label);
    });
  }

  function recoveryCursorIdentity(dbPath: string): string {
    return resolveIMessageRecoveryCursorDbIdentity({ dbPath });
  }

  function createRecoveryChatDb(prefix: string, cursor?: number, label = "boundary"): string {
    const dbPath = path.join(createTestStateDir(prefix), "chat.db");
    if (cursor !== undefined) {
      advanceIMessageRecoveryCursor("default", recoveryCursorIdentity(dbPath), cursor);
    }
    seedChatDb(dbPath, label);
    return dbPath;
  }

  function loadRecoveryCursor(dbPath: string): number | null {
    return loadIMessageRecoveryCursor("default", recoveryCursorIdentity(dbPath));
  }

  async function runMessageCase(
    params: WatchClientParams & { monitor?: MonitorRunParams },
  ): Promise<ReturnType<typeof createIMessageWatchClient>> {
    const { monitor, ...clientParams } = params;
    const client = createIMessageWatchClient(clientParams);
    await runIMessageMonitor(monitor);
    return client;
  }

  function expectWatchSubscription(
    client: ReturnType<typeof createIMessageWatchClient>,
    sinceRowid?: number,
  ): void {
    const params =
      sinceRowid === undefined
        ? WATCH_SUBSCRIBE_PARAMS
        : { ...WATCH_SUBSCRIBE_PARAMS, since_rowid: sinceRowid };
    expect(client.request).toHaveBeenCalledWith("watch.subscribe", params, WATCH_SUBSCRIBE_OPTIONS);
  }

  async function runBlockStreamingCase(
    message: Pick<IMessagePayload, "id" | "guid">,
    monitorParams: MonitorRunParams,
  ): Promise<ReplyDispatchParams> {
    let dispatchParams: ReplyDispatchParams | undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
      dispatchParams = params;
      return EMPTY_DISPATCH_RESULT;
    });
    createIMessageWatchClient({
      message: createInboundMessage({ ...message, text: "stream blocks before the final" }),
    });
    await runIMessageMonitor(monitorParams);
    return dispatchParams as ReplyDispatchParams;
  }

  it("keeps native typing alive when tool activity arrives before reply text", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing"]);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
      expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
      expect(params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      const onReplyStart =
        params.dispatcherOptions.onReplyStart ??
        params.dispatcherOptions.typingCallbacks?.onReplyStart;
      const onTypingCleanup =
        params.dispatcherOptions.onCleanup ?? params.dispatcherOptions.typingCallbacks?.onCleanup;
      let active = false;
      let runComplete = false;
      let dispatchIdle = false;
      const stopIfSettled = () => {
        if (active && runComplete && dispatchIdle) {
          active = false;
          onTypingCleanup?.();
        }
      };
      const typingController = {
        onReplyStart: async () => {
          await onReplyStart?.();
        },
        startTypingLoop: async () => {
          active = true;
          await onReplyStart?.();
        },
        startTypingOnText: async () => {},
        refreshTypingTtl: () => {},
        isActive: () => active,
        markRunComplete: () => {
          runComplete = true;
          stopIfSettled();
        },
        markDispatchIdle: () => {
          dispatchIdle = true;
          stopIfSettled();
        },
        cleanup: () => {
          active = false;
          onTypingCleanup?.();
        },
      };
      params.replyOptions?.onTypingController?.(typingController);
      await params.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      const onToolResult = params.replyOptions?.onToolResult;
      expect(onToolResult).toBeTypeOf("function");
      await onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      typingController.markRunComplete();
      typingController.markDispatchIdle();
      return EMPTY_DISPATCH_RESULT;
    });

    const client = await runMessageCase({
      requests: {
        "watch.subscribe": { subscription: 1 },
        typing: { ok: true },
      },
      message: createInboundMessage({
        id: 7,
        guid: "typing-keepalive-guid-7",
        text: "run a long script",
      }),
      monitor: { imessage: { sendReadReceipts: false } },
    });

    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true }),
        expect.any(Object),
      );
    });
    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: false }),
        expect.any(Object),
      );
    });
  });

  it("keeps direct progress options when imsg lacks native typing support", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "send", "read"]);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
      expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
      expect(params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      expect(params.replyOptions?.onToolStart).toBeUndefined();
      const onToolResult = params.replyOptions?.onToolResult;
      expect(onToolResult).toBeTypeOf("function");
      await onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return EMPTY_DISPATCH_RESULT;
    });

    const client = await runMessageCase({
      requests: { "watch.subscribe": { subscription: 1 } },
      message: createInboundMessage({
        id: 13,
        guid: "typing-unsupported-guid-13",
        text: "run a long script without native typing",
      }),
      monitor: { imessage: { sendReadReceipts: false } },
    });

    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
    expect(client.request).not.toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.anything(),
    );
    expect(client.request).not.toHaveBeenCalledWith("send", expect.anything(), expect.anything());
  });

  it("starts direct typing before dispatching the inbound turn", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing"]);
    const watchClient = createIMessageWatchClient({
      requests: {
        "watch.subscribe": { subscription: 1 },
        typing: { ok: true },
      },
      auxiliaryRequests: { typing: { ok: true } },
      message: createInboundMessage({
        id: 12,
        guid: "typing-early-guid-12",
        text: "respond after a slow context build",
      }),
      afterNotify: async () => {
        await vi.waitFor(() => {
          expect(earlyTypingClient.request).toHaveBeenCalledWith(
            "typing",
            expect.objectContaining({ typing: true, to: "+15550001111" }),
            expect.any(Object),
          );
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        });
      },
    });
    const earlyTypingClient = watchClient.auxiliaryClient!;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async () => {
      expect(earlyTypingClient.request).toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true, to: "+15550001111" }),
        expect.any(Object),
      );
      return EMPTY_DISPATCH_RESULT;
    });

    await runIMessageMonitor({ imessage: { sendReadReceipts: false } });

    expect(watchClient.request).not.toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.anything(),
    );
    await vi.waitFor(() => {
      expect(earlyTypingClient.request).toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: false, to: "+15550001111" }),
        expect.any(Object),
      );
    });
  });

  for (const { name, id, guid, monitor } of [
    ...(["never", "message", "thinking"] as const).map((typingMode) => ({
      name: `does not start direct tool typing when typingMode is ${typingMode}`,
      id: 8,
      guid: `typing-mode-${typingMode}-guid-8`,
      monitor: {
        imessage: { sendReadReceipts: false },
        agents: { defaults: { typingMode } },
      },
    })),
    {
      name: "does not start direct tool typing when sendPolicy denies source delivery",
      id: 9,
      guid: "send-policy-guid-9",
      monitor: {
        imessage: { sendReadReceipts: false },
        session: { sendPolicy: { default: "deny" } },
      },
    },
  ]) {
    it(name, async () => {
      setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing"]);
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
        expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
        expect(
          params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed,
        ).toBeUndefined();
        expect(params.replyOptions?.onToolStart).toBeUndefined();
        return EMPTY_DISPATCH_RESULT;
      });

      const client = await runMessageCase({
        requests: { "watch.subscribe": { subscription: 1 } },
        message: createInboundMessage({ id, guid, text: "run a long script" }),
        monitor,
      });

      await vi.waitFor(() => {
        expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      });
      expect(client.request).not.toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true }),
        expect.anything(),
      );
    });
  }

  it("does not wait for read receipts before dispatching the inbound turn", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "read"]);
    const watchClient = await runMessageCase({
      auxiliaryRequests: { read: () => new Promise(() => {}) },
      message: createInboundMessage({
        id: 11,
        guid: "read-receipt-guid-11",
        text: "respond without waiting for read receipt",
      }),
      afterNotify: async () => {
        await vi.waitFor(() => {
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        });
      },
    });
    const readClient = watchClient.auxiliaryClient!;

    expect(readClient.request).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ to: "+15550001111" }),
      expect.any(Object),
    );
    expect(watchClient.request).not.toHaveBeenCalledWith(
      "read",
      expect.anything(),
      expect.anything(),
    );
    expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "nested true",
      imessagePatch: { streaming: { block: { enabled: true } } },
      expectedDisable: false,
    },
    {
      label: "nested false",
      imessagePatch: { streaming: { block: { enabled: false } } },
      expectedDisable: true,
    },
    { label: "unset", imessagePatch: {}, expectedDisable: undefined },
  ] as const)(
    "passes iMessage block streaming config ($label) through to reply dispatch",
    async ({ label, imessagePatch, expectedDisable }) => {
      const params = await runBlockStreamingCase(
        { id: 10, guid: `block-streaming-${label}-guid-10` },
        { imessage: { sendReadReceipts: false, ...imessagePatch } },
      );
      expect(params.replyOptions?.disableBlockStreaming).toBe(expectedDisable);
      await vi.waitFor(() => {
        expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.each([
    {
      label: "account nested false overrides channel nested true",
      channelBlockEnabled: true,
      accountBlockEnabled: false,
      expectedDisable: true,
    },
    {
      label: "account nested true overrides channel nested false",
      channelBlockEnabled: false,
      accountBlockEnabled: true,
      expectedDisable: false,
    },
  ] as const)(
    "preserves account-level block streaming opt-outs when inheriting channel streaming ($label)",
    async ({ label, channelBlockEnabled, accountBlockEnabled, expectedDisable }) => {
      const params = await runBlockStreamingCase(
        { id: 11, guid: `account-block-streaming-${label}-guid-11` },
        {
          accountId: "personal",
          imessage: {
            sendReadReceipts: false,
            streaming: { block: { enabled: channelBlockEnabled } },
            accounts: {
              personal: { streaming: { block: { enabled: accountBlockEnabled } } },
            },
          },
        },
      );
      expect(params.replyOptions?.disableBlockStreaming).toBe(expectedDisable);
      await vi.waitFor(() => {
        expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.each([
    {
      label: "chunkMode",
      accountStreaming: { chunkMode: "length" },
    },
    {
      label: "block coalesce",
      accountStreaming: { block: { coalesce: { idleMs: 1 } } },
    },
  ] as const)(
    "preserves channel-level nested block streaming when an account overrides $label",
    async ({ label, accountStreaming }) => {
      const params = await runBlockStreamingCase(
        { id: 11, guid: `account-streaming-${label}-guid-11` },
        {
          accountId: "personal",
          imessage: {
            sendReadReceipts: false,
            streaming: { block: { enabled: true } },
            accounts: {
              personal: { streaming: accountStreaming },
            },
          },
        },
      );
      expect(params.replyOptions?.disableBlockStreaming).toBe(false);
      await vi.waitFor(() => {
        expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      });
    },
  );

  it("keeps per-channel-peer direct-message last-route writes on the isolated session", async () => {
    const stateDir = createTestStateDir("openclaw-imsg-last-route-");
    const configuredStore = path.join(stateDir, "sessions.json");
    const storePath = resolveStorePath(configuredStore, { agentId: "main" });
    const sessionKey = "agent:main:imessage:direct:+15550001111";
    const runtimeErrorMock = vi.fn();
    await runMessageCase({
      message: createInboundMessage({
        id: 1,
        guid: "last-route-guid-1",
        text: "hello from imessage",
      }),
      monitor: {
        session: { dmScope: "per-channel-peer", store: configuredStore },
        runtime: { error: runtimeErrorMock, exit: vi.fn(), log: vi.fn() },
      },
    });

    await vi.waitFor(() => {
      expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1);
    });
    expect(runtimeErrorMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
        delivery: {
          kind: "external",
          context: {
            channel: "imessage",
            to: "auto:+15550001111",
            accountId: "default",
          },
          route: {
            channel: "imessage",
            accountId: "default",
            target: { to: "auto:+15550001111" },
          },
        },
      });
    });
    expect(getSessionEntry({ storePath, sessionKey: "agent:main:main" })).toBeUndefined();
  });

  it("suppresses stale backlog rows but dispatches fresh live rows", async () => {
    const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const freshCreatedAt = new Date().toISOString();

    const client = await runMessageCase({
      messages: [
        createInboundMessage({
          id: 2023,
          guid: "OLD-GUID-2023",
          text: "old backlog row",
          created_at: staleCreatedAt,
        }),
        createInboundMessage({
          id: 3001,
          guid: "LIVE-GUID-2026",
          text: "current row",
          created_at: freshCreatedAt,
        }),
      ],
      monitor: {
        imessage: {
          dbPath: path.join(os.tmpdir(), `openclaw-missing-chat-${Date.now()}.db`),
        },
      },
    });

    expectWatchSubscription(client);
    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
  });

  it("passes the startup rowid watermark as since_rowid when chat.db is readable", async () => {
    const dbPath = createRecoveryChatDb("openclaw-imsg-startup-rowid-", undefined, "watermark");
    const client = await runMessageCase({ monitor: { imessage: { dbPath } } });

    expectWatchSubscription(client, 5000);
  });

  it("recovers over a remote cliPath: replays from the cursor even without a local chat.db boundary", async () => {
    advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ remoteHost: "user@gateway-host" }),
      4990,
    );
    const client = await runMessageCase({
      monitor: {
        imessage: {
          remoteHost: "user@gateway-host",
        },
      },
    });

    expectWatchSubscription(client, 4990);
  });

  it("routes legacy catchup through durable ingress and rejects a live GUID overlap", async () => {
    const dbPath = createRecoveryChatDb("openclaw-imsg-catchup-window-");
    const createdAt = new Date().toISOString();
    const historyMessage = createInboundMessage({
      id: 4995,
      guid: "CATCHUP-LIVE-OVERLAP-GUID",
      text: "caught up exactly once",
      created_at: createdAt,
    });
    const client = await runMessageCase({
      requests: {
        "watch.subscribe": { subscription: 1 },
        "chats.list": { chats: [{ id: 123, last_message_at: createdAt }] },
        "messages.history": { messages: [historyMessage] },
      },
      message: { ...historyMessage, id: 5001 },
      monitor: {
        imessage: { dbPath, catchup: { enabled: true, perRunLimit: 25, maxAgeMinutes: 60 } },
      },
    });

    expectWatchSubscription(client);
    expect(client.request).toHaveBeenCalledWith(
      "chats.list",
      { limit: 200 },
      { timeoutMs: 30_000 },
    );
    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
  });

  it("recovers downtime messages: replays from the cursor and delivers replay rows older than the live fence", async () => {
    const dbPath = createRecoveryChatDb("openclaw-imsg-recovery-", 4990);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = await runMessageCase({
      messages: [
        createInboundMessage({
          id: 4995,
          guid: "RECOVERY-GUID-4995",
          text: "missed during downtime",
          created_at: thirtyMinAgo,
        }),
        createInboundMessage({
          id: 5001,
          guid: "LIVE-OLD-GUID-5001",
          text: "live backlog bomb",
          created_at: thirtyMinAgo,
        }),
      ],
      monitor: { imessage: { dbPath } },
    });

    expectWatchSubscription(client, 4990);
    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not treat startup-boundary rows as recovery replay without a prior cursor", async () => {
    const dbPath = createRecoveryChatDb("openclaw-imsg-first-run-boundary-");
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = await runMessageCase({
      message: createInboundMessage({
        id: 4995,
        guid: "FIRST-RUN-HISTORY-GUID-4995",
        text: "already existed before first monitor start",
        created_at: thirtyMinAgo,
      }),
      monitor: { imessage: { dbPath } },
    });

    expectWatchSubscription(client, 5000);
    await settleNotifications();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
  });

  it("records a suppressed live row so a later replay of the same row is deduped, not delivered", async () => {
    const dbPath = createRecoveryChatDb("openclaw-imsg-suppress-record-");
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await runMessageCase({
      messages: [
        createInboundMessage({
          id: 5001,
          guid: "SUPPRESSED-GUID",
          text: "stale live backlog",
          created_at: thirtyMinAgo,
        }),
        createInboundMessage({
          id: 5001,
          guid: "SUPPRESSED-GUID",
          text: "stale live backlog",
        }),
      ],
      monitor: { imessage: { dbPath } },
    });

    await settleNotifications();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
  });

  it("advances the recovery cursor after durable enqueue before dispatch", async () => {
    debouncerControl.holdEntries = true;
    const dbPath = createRecoveryChatDb("openclaw-imsg-recovery-failed-", 4990);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = await runMessageCase({
      messages: [4995, 4996].map((id) =>
        createInboundMessage({
          id,
          guid: `FAILED-REPLAY-GUID-${id}`,
          text: `missed during downtime ${id}`,
          created_at: thirtyMinAgo,
        }),
      ),
      monitor: { imessage: { dbPath } },
    });

    expectWatchSubscription(client, 4990);
    await vi.waitFor(() => {
      expect(debouncerControl.entries).toHaveLength(2);
    });
    expect(loadRecoveryCursor(dbPath)).toBe(4996);
  });

  it("keeps the durable recovery cursor independent of later dispatch order", async () => {
    debouncerControl.holdEntries = true;
    const dbPath = createRecoveryChatDb("openclaw-imsg-recovery-ordered-", 4990);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await runMessageCase({
      messages: [4995, 4996].map((id) =>
        createInboundMessage({
          id,
          guid: `OUT-OF-ORDER-REPLAY-GUID-${id}`,
          text: `missed during downtime ${id}`,
          created_at: thirtyMinAgo,
        }),
      ),
      monitor: { imessage: { dbPath } },
    });

    await vi.waitFor(() => {
      expect(debouncerControl.entries).toHaveLength(2);
    });
    expect(loadRecoveryCursor(dbPath)).toBe(4996);
  });

  const replacedDatabaseCases = [
    {
      name: "tails a chat.db replaced at the same path instead of suppressing every row below the stale cursor",
      prefix: "openclaw-imsg-db-replaced-",
      seededRowid: 5,
      liveRowid: 6,
      expectedSinceRowid: 5,
    },
    {
      name: "tails a chat.db rebuilt empty at the same path instead of suppressing its first rows",
      prefix: "openclaw-imsg-db-rebuilt-",
      seededRowid: null,
      liveRowid: 1,
      expectedSinceRowid: -1,
    },
  ];

  for (const replacedDatabase of replacedDatabaseCases) {
    it(replacedDatabase.name, async () => {
      const stateDir = createTestStateDir(replacedDatabase.prefix);
      const dbPath = path.join(stateDir, "chat.db");
      advanceIMessageRecoveryCursor(
        "default",
        resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
        9000,
      );
      createChatDb(
        dbPath,
        replacedDatabase.seededRowid === null
          ? []
          : [
              createChatDbMessage(
                replacedDatabase.seededRowid,
                `RESTORED-GUID-${replacedDatabase.seededRowid}`,
                "restored history",
                new Date(Date.now() - 30 * 60 * 1000).toISOString(),
              ),
            ],
      );

      let sinceRowid: unknown;
      const client = createIMessageWatchClient({
        requests: {
          "watch.subscribe": (params) => {
            sinceRowid = params?.since_rowid;
            return { subscription: 1 };
          },
        },
        onClose: async (notify) => {
          insertChatDbMessage(
            dbPath,
            createChatDbMessage(
              replacedDatabase.liveRowid,
              `REPLACEMENT-GUID-${replacedDatabase.liveRowid}`,
              "sent after the restore",
            ),
          );
          for (const message of readChatDbMessagesAfter(
            dbPath,
            typeof sinceRowid === "number" ? sinceRowid : 0,
          )) {
            notify(message);
          }
          await settleNotifications();
        },
      });

      await runIMessageMonitor({ imessage: { dbPath } });

      expectWatchSubscription(client, replacedDatabase.expectedSinceRowid);
      await vi.waitFor(() => {
        expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      });
      expect(
        loadIMessageRecoveryCursor("default", resolveIMessageRecoveryCursorDbIdentity({ dbPath })),
      ).toBe(replacedDatabase.liveRowid);
    });
  }

  it("does not self-fence past the first row inserted while an empty rebuilt chat.db starts", async () => {
    const stateDir = createTestStateDir("openclaw-imsg-db-rebuilt-startup-race-");
    const dbPath = path.join(stateDir, "chat.db");
    advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
      9000,
    );
    createChatDb(dbPath);

    let effectiveWatcherCursor: number | undefined;
    const client = createIMessageWatchClient({
      requests: {
        "watch.subscribe": async (params) => {
          insertChatDbMessage(
            dbPath,
            createChatDbMessage(1, "REBUILT-STARTUP-GUID-1", "sent while the watcher starts"),
          );
          const requestedCursor = params?.since_rowid;
          const maxRowid = withChatDb(
            dbPath,
            (database) =>
              (
                database.prepare("SELECT MAX(ROWID) AS maxRowid FROM message").get() as {
                  maxRowid: number;
                }
              ).maxRowid,
          );
          // Match imsg's MessageWatcher.start contract: cursor 0 self-fences to
          // the subscribe-time maximum, while any other explicit cursor is kept.
          effectiveWatcherCursor =
            requestedCursor === 0
              ? maxRowid
              : typeof requestedCursor === "number"
                ? requestedCursor
                : maxRowid;
          return { subscription: 1 };
        },
      },
      onClose: async (notify) => {
        for (const message of readChatDbMessagesAfter(dbPath, effectiveWatcherCursor ?? 0)) {
          notify(message);
        }
        await settleNotifications();
      },
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    expectWatchSubscription(client, -1);
    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
    expect(
      loadIMessageRecoveryCursor("default", resolveIMessageRecoveryCursorDbIdentity({ dbPath })),
    ).toBe(1);
  });

  it("repairs anchorless group watch payloads before routing or cursor updates", async () => {
    openClawStates.push(
      await createOpenClawTestState({
        layout: "state-only",
        prefix: "openclaw-imsg-anchor-repair-",
      }),
    );

    createIMessageWatchClient({
      requests: {
        "watch.subscribe": { subscription: 1 },
        "chats.list": { chats: [{ id: 349 }] },
        "messages.history": (params) => {
          expect(params?.chat_id).toBe(349);
          return {
            messages: [
              {
                id: 9500,
                guid: "ANCHORLESS-GROUP-GUID",
                chat_id: 349,
                chat_guid: "iMessage;+;chat349",
                chat_identifier: "chat349",
                chat_name: "Project group",
                participants: ["+15550001111", "+15550002222"],
                sender: "+15550001111",
                destination_caller_id: "+15550001111",
                is_from_me: false,
                is_group: true,
              },
            ],
          };
        },
      },
      message: {
        id: 9500,
        guid: "ANCHORLESS-GROUP-GUID",
        chat_id: 0,
        sender: "+15550001111",
        is_from_me: false,
        text: "@openclaw check this https://example.com",
        is_group: false,
        chat_guid: "",
        chat_identifier: "",
        chat_name: "",
        participants: null,
        created_at: new Date().toISOString(),
      },
    });

    await runIMessageMonitor({
      imessage: { groupPolicy: "open", groups: { "*": { requireMention: true } } },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      allowlist: false,
    });

    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
    const dispatchParams = dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.at(0)?.[0];
    expect(dispatchParams?.ctx.To).toBe("chat_id:349");
    expect(dispatchParams?.ctx.From).toBe("imessage:group:349");
    expect(dispatchParams?.ctx.ChatType).toBe("group");
    expect(dispatchParams?.ctx.SessionKey).toBe("agent:main:imessage:group:349");
    expect(dispatchParams?.ctx.To).not.toBe("imessage:+15550001111");
  });

  for (const { name, id, text, isFromMe } of [
    {
      name: "repairs anchorless direct watch payloads so reply routing targets the authoritative remote peer (#104136)",
      id: 9500,
      text: "hello from broken anchor",
      isFromMe: false,
    },
    {
      name: "suppresses anchorless watch payloads when authoritative history is from-me (#104136)",
      id: 9501,
      text: "outgoing row with broken direction",
      isFromMe: true,
    },
  ]) {
    it(name, async () => {
      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
      const { notification, history } = createAnchorlessDirectPair(id, text, isFromMe);

      await runMessageCase({
        requests: {
          "watch.subscribe": { subscription: 1 },
          "chats.list": { chats: [{ id: 42 }] },
          "messages.history": (params) => {
            expect(params?.chat_id).toBe(42);
            return { messages: [history] };
          },
        },
        message: notification,
        monitor: {
          imessage: { allowFrom: ["+15550000002"] },
          ...(isFromMe ? { runtime } : {}),
        },
      });

      if (isFromMe) {
        await vi.waitFor(() => {
          expect(runtime.error).toHaveBeenCalled();
        });
        expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
        expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
          "recovered authoritative row is from-me",
        );
      } else {
        await vi.waitFor(() => {
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        });
        const dispatchParams = dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.at(0)?.[0];
        expect(dispatchParams?.ctx.To).toBe("imessage:+15550000002");
        expect(dispatchParams?.ctx.To).not.toBe("imessage:+15550000001");
      }
    });
  }
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
