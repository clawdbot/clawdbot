// Imessage tests cover monitor.last route plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { loadIMessageCatchupCursor } from "./monitor/catchup.js";
import {
  clearCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

type DispatchInboundMessageParams = {
  ctx: MsgContext;
  replyOptions?: {
    suppressDefaultToolProgressMessages?: boolean;
    allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
    onReplyStart?: () => Promise<void> | void;
    onTypingCleanup?: () => void;
    onTypingController?: (typing: {
      startTypingLoop: () => Promise<void>;
      refreshTypingTtl: () => void;
      isActive: () => boolean;
      markRunComplete: () => void;
      markDispatchIdle: () => void;
      cleanup: () => void;
    }) => void;
    onToolStart?: (payload: { name?: string; phase?: string }) => Promise<void> | void;
  };
};

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const recordInboundSessionMock = vi.hoisted(() => vi.fn(async (_params: unknown) => {}));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (_params: DispatchInboundMessageParams) =>
      ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }) as const,
  ),
);
const debouncerControl = vi.hoisted(() => ({
  holdEntries: false,
  entries: [] as unknown[],
  flush: undefined as undefined | (() => Promise<void>),
  reset() {
    this.holdEntries = false;
    this.entries = [];
    this.flush = undefined;
  },
}));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    recordInboundSession: recordInboundSessionMock,
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn((opts) => ({
      debouncer: {
        enqueue: async (entry: unknown) => {
          if (!debouncerControl.holdEntries) {
            await opts.onFlush([entry]);
            return;
          }
          debouncerControl.entries.push(entry);
          debouncerControl.flush = async () => {
            const entries = debouncerControl.entries.splice(0);
            await opts.onFlush(entries);
          };
        },
      },
    })),
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

describe("iMessage monitor last-route updates", () => {
  const tempDirs: string[] = [];

  async function createMessagesDbWithMaxRowid(maxRowid: number, dbPath?: string): Promise<string> {
    let resolvedDbPath = dbPath;
    if (!resolvedDbPath) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-watch-watermark-"));
      tempDirs.push(stateDir);
      resolvedDbPath = path.join(stateDir, "chat.db");
    }
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(resolvedDbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(maxRowid, "watermark");
    } finally {
      database.close();
    }
    return resolvedDbPath;
  }

  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    recordInboundSessionMock.mockClear();
    dispatchInboundMessageMock.mockClear();
    debouncerControl.reset();
    clearCachedIMessagePrivateApiStatus();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps native typing alive when tool activity arrives before reply text", async () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: ["watch.subscribe", "send", "typing"],
    });
    dispatchInboundMessageMock.mockImplementationOnce(async (params) => {
      expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
      expect(params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      let active = false;
      let runComplete = false;
      let dispatchIdle = false;
      const stopIfSettled = () => {
        if (active && runComplete && dispatchIdle) {
          active = false;
          params.replyOptions?.onTypingCleanup?.();
        }
      };
      const typingController = {
        startTypingLoop: async () => {
          active = true;
          await params.replyOptions?.onReplyStart?.();
        },
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
          params.replyOptions?.onTypingCleanup?.();
        },
      };
      params.replyOptions?.onTypingController?.(typingController);
      await params.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      typingController.markRunComplete();
      typingController.markDispatchIdle();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
    });

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "typing") {
          return { ok: true };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 7,
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "run a long script",
              is_group: false,
              created_at: new Date().toISOString(),
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
            sendReadReceipts: false,
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
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

  it.each(["never", "message", "thinking"] as const)(
    "does not start direct tool typing when typingMode is %s",
    async (typingMode) => {
      setCachedIMessagePrivateApiStatus("imsg", {
        available: true,
        v2Ready: true,
        selectors: {},
        rpcMethods: ["watch.subscribe", "send", "typing"],
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (params) => {
        expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
        expect(
          params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed,
        ).toBeUndefined();
        expect(params.replyOptions?.onToolStart).toBeUndefined();
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
      });

      let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
      const client = {
        request: vi.fn(async (method: string) => {
          if (method === "watch.subscribe") {
            return { subscription: 1 };
          }
          if (method === "typing") {
            throw new Error("typing should not start from tool activity");
          }
          throw new Error(`unexpected imsg method ${method}`);
        }),
        waitForClose: vi.fn(async () => {
          onNotification?.({
            method: "message",
            params: {
              message: {
                id: 8,
                chat_id: 123,
                sender: "+15550001111",
                is_from_me: false,
                text: "run a long script",
                is_group: false,
                created_at: new Date().toISOString(),
              },
            },
          });
          await Promise.resolve();
          await Promise.resolve();
        }),
        stop: vi.fn(async () => {}),
      };
      createIMessageRpcClientMock.mockImplementation(async (params) => {
        if (!params?.onNotification) {
          throw new Error("expected iMessage notification handler");
        }
        onNotification = params.onNotification;
        return client as never;
      });

      await monitorIMessageProvider({
        config: {
          channels: {
            imessage: {
              dmPolicy: "allowlist",
              allowFrom: ["+15550001111"],
              sendReadReceipts: false,
            },
          },
          messages: { inbound: { debounceMs: 0 } },
          session: { mainKey: "main", typingMode },
        } as never,
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      });

      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      });
      expect(client.request).not.toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true }),
        expect.anything(),
      );
    },
  );

  it("does not start direct tool typing when sendPolicy denies source delivery", async () => {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: ["watch.subscribe", "send", "typing"],
    });
    dispatchInboundMessageMock.mockImplementationOnce(async (params) => {
      expect(params.replyOptions?.suppressDefaultToolProgressMessages).toBeUndefined();
      expect(
        params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed,
      ).toBeUndefined();
      expect(params.replyOptions?.onToolStart).toBeUndefined();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } } as const;
    });

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "typing") {
          throw new Error("typing should not start under sendPolicy deny");
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 9,
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "run a long script",
              is_group: false,
              created_at: new Date().toISOString(),
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
            sendReadReceipts: false,
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main", sendPolicy: { default: "deny" } },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    });
    expect(client.request).not.toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.anything(),
    );
  });

  it("keeps per-channel-peer direct-message last-route writes on the isolated session", async () => {
    const runtimeErrorMock = vi.fn();
    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 1,
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "hello from imessage",
              is_group: false,
              created_at: new Date().toISOString(),
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { dmScope: "per-channel-peer", mainKey: "main" },
      } as never,
      runtime: { error: runtimeErrorMock, exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1);
    });
    expect(runtimeErrorMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
    });
    const recordParams = recordInboundSessionMock.mock.calls.at(0)?.[0] as
      | {
          sessionKey?: string;
          updateLastRoute?: {
            channel?: string;
            mainDmOwnerPin?: unknown;
            sessionKey?: string;
            to?: string;
          };
        }
      | undefined;
    expect(recordParams?.sessionKey).toBe("agent:main:imessage:direct:+15550001111");
    expect(recordParams?.updateLastRoute?.sessionKey).toBe(recordParams?.sessionKey);
    expect(recordParams?.updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(recordParams?.updateLastRoute?.channel).toBe("imessage");
    expect(recordParams?.updateLastRoute?.to).toBe("imessage:+15550001111");
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });

  it("drops historical watch notifications on startup when catchup is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T05:23:18.000Z"));
    const dbPath = await createMessagesDbWithMaxRowid(3000);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 2023,
              guid: "OLD-GUID-2023",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "old row from another account",
              is_group: false,
              created_at: "2023-08-09T03:45:59.000Z",
            },
          },
        });
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dbPath, dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 3000 },
      { timeoutMs: 10_000 },
    );
    expect(recordInboundSessionMock).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("uses the default local chat.db path for the startup watermark", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-default-home-"));
    tempDirs.push(homeDir);
    vi.stubEnv("HOME", homeDir);
    await createMessagesDbWithMaxRowid(4000, path.join(homeDir, "Library", "Messages", "chat.db"));
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async () => client as never);

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 4000 },
      { timeoutMs: 10_000 },
    );
  });

  it("accepts live watch notifications after startup when catchup is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T05:23:18.000Z"));
    const dbPath = await createMessagesDbWithMaxRowid(3000);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 3001,
              guid: "LIVE-GUID-2026",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "current row",
              is_group: false,
              created_at: "2023-08-09T03:45:59.000Z",
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dbPath, dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("subscribes without a startup watermark when the configured dbPath is not readable", async () => {
    const dbPath = path.join(os.tmpdir(), `openclaw-missing-chat-${Date.now()}.db`);
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async () => client as never);

    await monitorIMessageProvider({
      config: {
        channels: { imessage: { dbPath, dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      { timeoutMs: 10_000 },
    );
  });

  it("subscribes without a startup watermark when node sqlite is unavailable", async () => {
    vi.doMock("node:sqlite", () => {
      throw new Error("node:sqlite unavailable");
    });
    vi.resetModules();
    try {
      const { monitorIMessageProvider: monitorWithoutSqlite } = await import("./monitor.js");
      const client = {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      createIMessageRpcClientMock.mockImplementation(async () => client as never);

      await monitorWithoutSqlite({
        config: {
          channels: { imessage: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
          messages: { inbound: { debounceMs: 0 } },
          session: { mainKey: "main" },
        } as never,
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      });

      expect(client.request).toHaveBeenCalledWith(
        "watch.subscribe",
        { attachments: false, include_reactions: true },
        { timeoutMs: 10_000 },
      );
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
  });

  it("advances the catchup cursor after startup catchup succeeds and a live row is handled", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-live-cursor-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [] };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 77,
              guid: "LIVE-GUID-77",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "hello after catchup",
              is_group: false,
              created_at: "2026-05-22T15:30:00.000Z",
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            catchup: { enabled: true },
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(async () => {
      expect((await loadIMessageCatchupCursor("default"))?.lastSeenRowid).toBe(77);
    });
  });

  it("flushes live cursor advancement for rows handled while startup catchup is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T15:31:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-live-during-catchup-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return {
            chats: [{ id: 1, last_message_at: "2026-05-22T15:15:00.000Z" }],
          };
        }
        if (method === "messages.history") {
          onNotification?.({
            method: "message",
            params: {
              message: {
                id: 77,
                guid: "LIVE-GUID-77",
                chat_id: 123,
                sender: "+15550001111",
                is_from_me: false,
                text: "hello during catchup",
                is_group: false,
                created_at: "2026-05-22T15:30:00.000Z",
              },
            },
          });
          await vi.waitFor(() => {
            expect(dispatchInboundMessageMock).toHaveBeenCalled();
          });
          const p = params as { chat_id: number };
          expect(p.chat_id).toBe(1);
          return {
            messages: [
              {
                id: 10,
                guid: "CATCHUP-GUID-10",
                chat_id: 1,
                sender: "+15550001111",
                is_from_me: false,
                text: "catchup row",
                is_group: false,
                created_at: "2026-05-22T15:15:00.000Z",
              },
            ],
          };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            catchup: { enabled: true },
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(async () => {
      expect((await loadIMessageCatchupCursor("default"))?.lastSeenRowid).toBe(77);
    });
  });

  it("repairs anchorless group watch payloads before routing or cursor updates", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-anchor-repair-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
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
                is_group: true,
              },
            ],
          };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
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
              created_at: "2026-05-22T15:30:00.000Z",
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            catchup: { enabled: true },
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
        messages: {
          groupChat: { mentionPatterns: ["@openclaw"] },
          inbound: { debounceMs: 0 },
        },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    });
    const dispatchParams = dispatchInboundMessageMock.mock.calls.at(0)?.[0];
    expect(dispatchParams?.ctx.To).toBe("chat_id:349");
    expect(dispatchParams?.ctx.From).toBe("imessage:group:349");
    expect(dispatchParams?.ctx.ChatType).toBe("group");
    expect(dispatchParams?.ctx.SessionKey).toBe("agent:main:imessage:group:349");
    expect(dispatchParams?.ctx.To).not.toBe("imessage:+15550001111");
  });

  it("does not advance the live cursor after partial startup catchup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T15:31:00.000Z"));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-partial-cursor-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string, params: unknown) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return {
            chats: [
              { id: 1, last_message_at: "2026-05-22T15:15:00.000Z" },
              { id: 2, last_message_at: "2026-05-22T15:15:00.000Z" },
            ],
          };
        }
        if (method === "messages.history") {
          const p = params as { chat_id: number };
          if (p.chat_id === 1) {
            throw new Error("chat history unavailable");
          }
          return {
            messages: [
              {
                id: 10,
                guid: "CATCHUP-GUID-10",
                chat_id: 2,
                sender: "+15550001111",
                is_from_me: false,
                text: "catchup row",
                is_group: false,
                created_at: "2026-05-22T15:15:00.000Z",
              },
            ],
          };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 77,
              guid: "LIVE-GUID-77",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "hello after partial catchup",
              is_group: false,
              created_at: "2026-05-22T15:30:00.000Z",
            },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            catchup: { enabled: true },
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(async () => {
      expect((await loadIMessageCatchupCursor("default"))?.lastSeenRowid).toBe(10);
    });
  });

  it("advances a coalesced live bucket to the highest source row", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-coalesced-cursor-"));
    tempDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    debouncerControl.holdEntries = true;

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [] };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        for (const row of [
          { id: 77, guid: "LIVE-GUID-77", text: "Dump", created_at: "2026-05-22T15:30:00.000Z" },
          {
            id: 78,
            guid: "LIVE-GUID-78",
            text: "https://example.com",
            created_at: "2026-05-22T15:30:01.000Z",
          },
        ]) {
          onNotification?.({
            method: "message",
            params: {
              message: {
                ...row,
                chat_id: 123,
                sender: "+15550001111",
                is_from_me: false,
                is_group: false,
              },
            },
          });
        }
        await vi.waitFor(() => {
          expect(debouncerControl.flush).toBeDefined();
        });
        await debouncerControl.flush?.();
        await Promise.resolve();
      }),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      if (!params?.onNotification) {
        throw new Error("expected iMessage notification handler");
      }
      onNotification = params.onNotification;
      return client as never;
    });

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            catchup: { enabled: true },
            coalesceSameSenderDms: true,
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 2500 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await vi.waitFor(async () => {
      expect((await loadIMessageCatchupCursor("default"))?.lastSeenRowid).toBe(78);
    });
  });
});
