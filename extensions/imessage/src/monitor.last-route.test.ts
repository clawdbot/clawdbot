// Imessage tests cover monitor.last route plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
        Pick<IMessagePayload, "chat_id" | "sender" | "is_from_me" | "is_group" | "created_at">
      >,
  ): IMessagePayload {
    return {
      id: message.id,
      guid: message.guid,
      chat_id: message.chat_id ?? 123,
      sender: message.sender ?? "+15550001111",
      is_from_me: message.is_from_me ?? false,
      text: message.text,
      is_group: message.is_group ?? false,
      created_at: message.created_at ?? new Date().toISOString(),
    };
  }

  function createIMessageWatchClient(
    params: {
      request?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
      message?: () => IMessagePayload;
      onClose?: (notify: (message: IMessagePayload) => void) => Promise<void>;
    } = {},
  ) {
    let onNotification:
      | NonNullable<NonNullable<Parameters<typeof createIMessageRpcClient>[0]>["onNotification"]>
      | undefined;
    const notify = (message: IMessagePayload) => {
      onNotification?.({ method: "message", params: { message } });
    };
    const message = params.message;
    const onClose =
      params.onClose ??
      (message
        ? async (notifyMessage: (message: IMessagePayload) => void) => {
            notifyMessage(message());
            await Promise.resolve();
            await Promise.resolve();
          }
        : undefined);
    const client = {
      request: vi.fn(params.request ?? (async () => ({ subscription: 1 }))),
      waitForClose: vi.fn(() => onClose?.(notify) ?? Promise.resolve()),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (clientParams) => {
      if (!clientParams?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = clientParams.onNotification;
      return client as never;
    });
    return client;
  }

  async function runIMessageMonitor(
    params: {
      accountId?: string;
      imessage?: Record<string, unknown>;
      session?: Record<string, unknown>;
      messages?: Record<string, unknown>;
      agents?: Record<string, unknown>;
      runtime?: MonitorIMessageOpts["runtime"];
      allowlist?: boolean;
    } = {},
  ): Promise<void> {
    await monitorIMessageProvider({
      ...(params.accountId ? { accountId: params.accountId } : {}),
      config: {
        channels: {
          imessage: {
            ...(params.allowlist === false
              ? {}
              : { dmPolicy: "allowlist", allowFrom: ["+15550001111"] }),
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

  async function seedChatDb(dbPath: string, label = "boundary"): Promise<void> {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, label);
    } finally {
      database.close();
    }
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
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
    });

    const client = createIMessageWatchClient({
      request: async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "typing") {
          return { ok: true };
        }
        throw new Error(`unexpected imsg method ${method}`);
      },
      message: () =>
        createInboundMessage({
          id: 7,
          guid: "typing-keepalive-guid-7",
          text: "run a long script",
        }),
    });

    await runIMessageMonitor({ imessage: { sendReadReceipts: false } });

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
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
    });

    const client = createIMessageWatchClient({
      request: async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "typing") {
          throw new Error("typing should not start without native typing support");
        }
        throw new Error(`unexpected imsg method ${method}`);
      },
      message: () =>
        createInboundMessage({
          id: 13,
          guid: "typing-unsupported-guid-13",
          text: "run a long script without native typing",
        }),
    });

    await runIMessageMonitor({ imessage: { sendReadReceipts: false } });

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

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const earlyTypingClient = {
      request: vi.fn(async (method: string) => {
        if (method === "typing") {
          return { ok: true };
        }
        throw new Error(`unexpected imsg typing-client method ${method}`);
      }),
      stop: vi.fn(async () => {}),
    };
    const watchClient = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "typing") {
          return { ok: true };
        }
        throw new Error(`unexpected imsg watch-client method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: createInboundMessage({
              id: 12,
              guid: "typing-early-guid-12",
              text: "respond after a slow context build",
            }),
          },
        });
        await vi.waitFor(() => {
          expect(earlyTypingClient.request).toHaveBeenCalledWith(
            "typing",
            expect.objectContaining({ typing: true, to: "+15550001111" }),
            expect.any(Object),
          );
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        });
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (params?.onNotification) {
        onNotification = params.onNotification;
        return watchClient as never;
      }
      return earlyTypingClient as never;
    });
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async () => {
      expect(earlyTypingClient.request).toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true, to: "+15550001111" }),
        expect.any(Object),
      );
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
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

  it.each(["never", "message", "thinking"] as const)(
    "does not start direct tool typing when typingMode is %s",
    async (typingMode) => {
      setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing"]);
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
        expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
        expect(
          params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed,
        ).toBeUndefined();
        expect(params.replyOptions?.onToolStart).toBeUndefined();
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
      });

      const client = createIMessageWatchClient({
        request: async (method: string) => {
          if (method === "watch.subscribe") {
            return { subscription: 1 };
          }
          if (method === "typing") {
            throw new Error("typing should not start from tool activity");
          }
          throw new Error(`unexpected imsg method ${method}`);
        },
        message: () =>
          createInboundMessage({
            id: 8,
            guid: `typing-mode-${typingMode}-guid-8`,
            text: "run a long script",
          }),
      });

      await runIMessageMonitor({
        imessage: { sendReadReceipts: false },
        agents: { defaults: { typingMode } },
      });

      await vi.waitFor(() => {
        expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      });
      expect(client.request).not.toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true }),
        expect.anything(),
      );
    },
  );

  it("does not start direct tool typing when sendPolicy denies source delivery", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing"]);
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
      expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
      expect(
        params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed,
      ).toBeUndefined();
      expect(params.replyOptions?.onToolStart).toBeUndefined();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
    });

    const client = createIMessageWatchClient({
      request: async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "typing") {
          throw new Error("typing should not start under sendPolicy deny");
        }
        throw new Error(`unexpected imsg method ${method}`);
      },
      message: () =>
        createInboundMessage({
          id: 9,
          guid: "send-policy-guid-9",
          text: "run a long script",
        }),
    });

    await runIMessageMonitor({
      imessage: { sendReadReceipts: false },
      session: { sendPolicy: { default: "deny" } },
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

  it("does not wait for read receipts before dispatching the inbound turn", async () => {
    setAvailablePrivateApiMethods(["watch.subscribe", "read"]);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const readClient = {
      request: vi.fn((method: string) => {
        if (method === "read") {
          return new Promise(() => {});
        }
        return Promise.reject(new Error(`unexpected imsg read-client method ${method}`));
      }),
      stop: vi.fn(async () => {}),
    };
    const watchClient = {
      request: vi.fn((method: string) => {
        if (method === "watch.subscribe") {
          return Promise.resolve({ subscription: 1 });
        }
        return Promise.reject(new Error(`unexpected imsg watch-client method ${method}`));
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: createInboundMessage({
              id: 11,
              guid: "read-receipt-guid-11",
              text: "respond without waiting for read receipt",
            }),
          },
        });
        await vi.waitFor(() => {
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        });
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (params?.onNotification) {
        onNotification = params.onNotification;
        return watchClient as never;
      }
      return readClient as never;
    });

    await runIMessageMonitor();

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
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
        expect(params.replyOptions?.disableBlockStreaming).toBe(expectedDisable);
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
      });

      createIMessageWatchClient({
        request: async (method: string) => {
          if (method === "watch.subscribe") {
            return { subscription: 1 };
          }
          throw new Error(`unexpected imsg method ${method}`);
        },
        message: () =>
          createInboundMessage({
            id: 10,
            guid: `block-streaming-${label}-guid-10`,
            text: "stream blocks before the final",
          }),
      });

      await runIMessageMonitor({ imessage: { sendReadReceipts: false, ...imessagePatch } });

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
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
        expect(params.replyOptions?.disableBlockStreaming).toBe(expectedDisable);
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
      });

      createIMessageWatchClient({
        request: async (method: string) => {
          if (method === "watch.subscribe") {
            return { subscription: 1 };
          }
          throw new Error(`unexpected imsg method ${method}`);
        },
        message: () =>
          createInboundMessage({
            id: 11,
            guid: `account-block-streaming-${label}-guid-11`,
            text: "stream blocks before the final",
          }),
      });

      await runIMessageMonitor({
        accountId: "personal",
        imessage: {
          sendReadReceipts: false,
          streaming: { block: { enabled: channelBlockEnabled } },
          accounts: {
            personal: {
              streaming: { block: { enabled: accountBlockEnabled } },
            },
          },
        },
      });

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
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async (params) => {
        expect(params.replyOptions?.disableBlockStreaming).toBe(false);
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
      });

      createIMessageWatchClient({
        request: async (method: string) => {
          if (method === "watch.subscribe") {
            return { subscription: 1 };
          }
          throw new Error(`unexpected imsg method ${method}`);
        },
        message: () =>
          createInboundMessage({
            id: 11,
            guid: `account-streaming-${label}-guid-11`,
            text: "stream blocks before the final",
          }),
      });

      await runIMessageMonitor({
        accountId: "personal",
        imessage: {
          sendReadReceipts: false,
          streaming: { block: { enabled: true } },
          accounts: {
            personal: {
              streaming: accountStreaming,
            },
          },
        },
      });

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
    createIMessageWatchClient({
      message: () =>
        createInboundMessage({
          id: 1,
          guid: "last-route-guid-1",
          text: "hello from imessage",
        }),
    });

    await runIMessageMonitor({
      session: { dmScope: "per-channel-peer", store: configuredStore },
      runtime: { error: runtimeErrorMock, exit: vi.fn(), log: vi.fn() },
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
            to: "imessage:+15550001111",
            accountId: "default",
          },
          route: {
            channel: "imessage",
            accountId: "default",
            target: { to: "imessage:+15550001111" },
          },
        },
      });
    });
    expect(getSessionEntry({ storePath, sessionKey: "agent:main:main" })).toBeUndefined();
  });

  it("suppresses stale backlog rows but dispatches fresh live rows", async () => {
    // Dates are relative to real now so the age fence sees the intended ages
    // (the live debouncer also flushes on a real 0ms timer here).
    const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const freshCreatedAt = new Date().toISOString();

    const client = createIMessageWatchClient({
      onClose: async (notify) => {
        // Stale backlog row (old send date) Apple delivered after a recovery —
        // must be suppressed by the age fence.
        notify(
          createInboundMessage({
            id: 2023,
            guid: "OLD-GUID-2023",
            text: "old backlog row",
            created_at: staleCreatedAt,
          }),
        );
        // Fresh live row — must dispatch.
        notify(
          createInboundMessage({
            id: 3001,
            guid: "LIVE-GUID-2026",
            text: "current row",
            created_at: freshCreatedAt,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      },
    });

    await runIMessageMonitor({
      imessage: {
        // Unreadable dbPath => no startup rowid watermark, so this test
        // isolates the age-fence behavior on the live path.
        dbPath: path.join(os.tmpdir(), `openclaw-missing-chat-${Date.now()}.db`),
      },
    });

    // No readable db => watch.subscribe carries no since_rowid; the age fence
    // suppresses stale backlog on the live path instead.
    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      { timeoutMs: 10_000 },
    );
    // Only the fresh row dispatches; the stale backlog row is suppressed.
    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
  });

  it("passes the startup rowid watermark as since_rowid when chat.db is readable", async () => {
    // Regression guard: the watermark is captured before the transport-ready
    // probe so messages that land during the startup window are not skipped by
    // imsg's self-fence at subscribe time.
    const stateDir = createTestStateDir("openclaw-imsg-startup-rowid-");
    const dbPath = path.join(stateDir, "chat.db");
    await seedChatDb(dbPath, "watermark");
    const client = createIMessageWatchClient();

    await runIMessageMonitor({ imessage: { dbPath } });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 5000 },
      { timeoutMs: 10_000 },
    );
  });

  it("recovers over a remote cliPath: replays from the cursor even without a local chat.db boundary", async () => {
    advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ remoteHost: "user@gateway-host" }),
      4990,
    );
    const client = createIMessageWatchClient();

    await runIMessageMonitor({
      imessage: {
        // remoteHost set => no local chat.db boundary; recovery must still
        // drive since_rowid from the persisted cursor over the RPC client.
        remoteHost: "user@gateway-host",
      },
    });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 4990 },
      { timeoutMs: 10_000 },
    );
  });

  it("routes legacy catchup through durable ingress and rejects a live GUID overlap", async () => {
    const stateDir = createTestStateDir("openclaw-imsg-catchup-window-");
    const dbPath = path.join(stateDir, "chat.db");
    await seedChatDb(dbPath);
    const createdAt = new Date().toISOString();
    const historyMessage = createInboundMessage({
      id: 4995,
      guid: "CATCHUP-LIVE-OVERLAP-GUID",
      text: "caught up exactly once",
      created_at: createdAt,
    });
    const client = createIMessageWatchClient({
      request: async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [{ id: 123, last_message_at: createdAt }] };
        }
        if (method === "messages.history") {
          return { messages: [historyMessage] };
        }
        throw new Error(`unexpected request ${method}`);
      },
      onClose: async (notify) => {
        notify({ ...historyMessage, id: 5001 });
      },
    });

    await runIMessageMonitor({
      imessage: { dbPath, catchup: { enabled: true, perRunLimit: 25, maxAgeMinutes: 60 } },
    });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      { timeoutMs: 10_000 },
    );
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
    const stateDir = createTestStateDir("openclaw-imsg-recovery-");
    const dbPath = path.join(stateDir, "chat.db");
    advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
      4990,
    );
    await seedChatDb(dbPath);
    // 30 min old: inside the 2h recovery window, outside the 15min live fence.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = createIMessageWatchClient({
      onClose: async (notify) => {
        // Recovery replay row (rowid <= boundary 5000): missed during downtime,
        // delivered despite being 30min old.
        notify(
          createInboundMessage({
            id: 4995,
            guid: "RECOVERY-GUID-4995",
            text: "missed during downtime",
            created_at: thirtyMinAgo,
          }),
        );
        // Live row (rowid > boundary) with the same old date: this is the
        // #89237 Push-flush backlog shape, suppressed at the live fence.
        notify(
          createInboundMessage({
            id: 5001,
            guid: "LIVE-OLD-GUID-5001",
            text: "live backlog bomb",
            created_at: thirtyMinAgo,
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      },
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    // since_rowid replays from the persisted cursor, not the boundary.
    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 4990 },
      { timeoutMs: 10_000 },
    );
    // The recovery replay row dispatches; the live old row is suppressed.
    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not treat startup-boundary rows as recovery replay without a prior cursor", async () => {
    const stateDir = createTestStateDir("openclaw-imsg-first-run-boundary-");
    const dbPath = path.join(stateDir, "chat.db");
    await seedChatDb(dbPath);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = createIMessageWatchClient({
      message: () =>
        createInboundMessage({
          id: 4995,
          guid: "FIRST-RUN-HISTORY-GUID-4995",
          text: "already existed before first monitor start",
          created_at: thirtyMinAgo,
        }),
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 5000 },
      { timeoutMs: 10_000 },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
  });

  it("records a suppressed live row so a later replay of the same row is deduped, not delivered", async () => {
    const stateDir = createTestStateDir("openclaw-imsg-suppress-record-");
    const dbPath = path.join(stateDir, "chat.db");
    await seedChatDb(dbPath);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    createIMessageWatchClient({
      onClose: async (notify) => {
        // Live row (rowid > boundary), 30min old -> suppressed by the live fence
        // AND recorded in the dedupe.
        notify(
          createInboundMessage({
            id: 5001,
            guid: "SUPPRESSED-GUID",
            text: "stale live backlog",
            created_at: thirtyMinAgo,
          }),
        );
        // Same GUID re-emitted fresh (as a restart replay would): must be
        // dropped as a duplicate, not delivered under the recovery window.
        notify(
          createInboundMessage({
            id: 5001,
            guid: "SUPPRESSED-GUID",
            text: "stale live backlog",
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
      },
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
  });

  it("advances the recovery cursor after durable enqueue before dispatch", async () => {
    debouncerControl.holdEntries = true;
    const stateDir = createTestStateDir("openclaw-imsg-recovery-failed-");
    const dbPath = path.join(stateDir, "chat.db");
    advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
      4990,
    );
    await seedChatDb(dbPath);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = createIMessageWatchClient({
      onClose: async (notify) => {
        for (const id of [4995, 4996]) {
          notify({
            id,
            guid: `FAILED-REPLAY-GUID-${id}`,
            chat_id: 123,
            sender: "+15550001111",
            is_from_me: false,
            text: `missed during downtime ${id}`,
            is_group: false,
            created_at: thirtyMinAgo,
          });
        }
      },
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 4990 },
      { timeoutMs: 10_000 },
    );
    await vi.waitFor(() => {
      expect(debouncerControl.entries).toHaveLength(2);
    });
    expect(
      loadIMessageRecoveryCursor("default", resolveIMessageRecoveryCursorDbIdentity({ dbPath })),
    ).toBe(4996);
  });

  it("keeps the durable recovery cursor independent of later dispatch order", async () => {
    debouncerControl.holdEntries = true;
    const stateDir = createTestStateDir("openclaw-imsg-recovery-ordered-");
    const dbPath = path.join(stateDir, "chat.db");
    advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
      4990,
    );
    await seedChatDb(dbPath);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    createIMessageWatchClient({
      onClose: async (notify) => {
        for (const id of [4995, 4996]) {
          notify({
            id,
            guid: `OUT-OF-ORDER-REPLAY-GUID-${id}`,
            chat_id: 123,
            sender: "+15550001111",
            is_from_me: false,
            text: `missed during downtime ${id}`,
            is_group: false,
            created_at: thirtyMinAgo,
          });
        }
      },
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    await vi.waitFor(() => {
      expect(debouncerControl.entries).toHaveLength(2);
    });
    expect(
      loadIMessageRecoveryCursor("default", resolveIMessageRecoveryCursorDbIdentity({ dbPath })),
    ).toBe(4996);
  });

  it("repairs anchorless group watch payloads before routing or cursor updates", async () => {
    openClawStates.push(
      await createOpenClawTestState({
        layout: "state-only",
        prefix: "openclaw-imsg-anchor-repair-",
      }),
    );

    createIMessageWatchClient({
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [{ id: 349 }] };
        }
        if (method === "messages.history") {
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
        }
        throw new Error(`unexpected imsg method ${method}`);
      },
      message: () => ({
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
      }),
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

  it("repairs anchorless direct watch payloads so reply routing targets the authoritative remote peer (#104136)", async () => {
    const issueGuid = "11111111-1111-4111-8111-111111111111";
    const anchorlessNotification = {
      id: 9500,
      guid: issueGuid,
      chat_id: 0,
      chat_guid: "",
      chat_identifier: "",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
      is_from_me: false,
      is_group: false,
      service: "iMessage",
      text: "hello from broken anchor",
      created_at: new Date().toISOString(),
    };
    const authoritativeHistory = {
      id: 9500,
      guid: issueGuid,
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      destination_caller_id: "+15550000001",
      is_from_me: false,
      is_group: false,
      service: "iMessage",
    };

    createIMessageWatchClient({
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [{ id: 42 }] };
        }
        if (method === "messages.history") {
          expect(params?.chat_id).toBe(42);
          return { messages: [authoritativeHistory] };
        }
        throw new Error(`unexpected imsg method ${method}`);
      },
      message: () => anchorlessNotification,
    });

    await runIMessageMonitor({ imessage: { allowFrom: ["+15550000002"] } });

    await vi.waitFor(() => {
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
    });
    const dispatchParams = dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.at(0)?.[0];
    expect(dispatchParams?.ctx.To).toBe("imessage:+15550000002");
    expect(dispatchParams?.ctx.To).not.toBe("imessage:+15550000001");

    console.log(
      [
        "[L3 proof #104136] scenario: stale local sender repaired to remote peer",
        `[L3 proof #104136] anchorless notification sender: ${anchorlessNotification.sender}`,
        `[L3 proof #104136] authoritative history sender: ${authoritativeHistory.sender}`,
        `[L3 proof #104136] monitor dispatch ctx.To: ${dispatchParams?.ctx.To}`,
      ].join("\n"),
    );
  });

  it("suppresses anchorless watch payloads when authoritative history is from-me (#104136)", async () => {
    const issueGuid = "11111111-1111-4111-8111-111111111111";
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const anchorlessNotification = {
      id: 9501,
      guid: issueGuid,
      chat_id: 0,
      chat_guid: "",
      chat_identifier: "",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
      is_from_me: false,
      is_group: false,
      service: "iMessage",
      text: "outgoing row with broken direction",
      created_at: new Date().toISOString(),
    };
    const authoritativeHistory = {
      id: 9501,
      guid: issueGuid,
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      destination_caller_id: "+15550000001",
      is_from_me: true,
      is_group: false,
      service: "iMessage",
    };

    createIMessageWatchClient({
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [{ id: 42 }] };
        }
        if (method === "messages.history") {
          expect(params?.chat_id).toBe(42);
          return { messages: [authoritativeHistory] };
        }
        throw new Error(`unexpected imsg method ${method}`);
      },
      message: () => anchorlessNotification,
    });

    await runIMessageMonitor({ imessage: { allowFrom: ["+15550000002"] }, runtime });

    await vi.waitFor(() => {
      expect(runtime.error).toHaveBeenCalled();
    });
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "recovered authoritative row is from-me",
    );

    console.log(
      [
        "[L3 proof #104136] scenario: authoritative from-me row suppressed before dispatch",
        `[L3 proof #104136] notification is_from_me: ${anchorlessNotification.is_from_me}`,
        `[L3 proof #104136] history is_from_me: ${authoritativeHistory.is_from_me}`,
        `[L3 proof #104136] monitor dispatch count: ${dispatchReplyWithBufferedBlockDispatcherMock.mock.calls.length}`,
        `[L3 proof #104136] runtime error: ${runtime.error.mock.calls.at(-1)?.[0]}`,
      ].join("\n"),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
