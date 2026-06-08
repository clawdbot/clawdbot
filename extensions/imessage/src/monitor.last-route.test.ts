// Imessage tests cover monitor.last route plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import {
  advanceIMessageRecoveryCursor,
  loadIMessageRecoveryCursor,
} from "./monitor/recovery-cursor.js";
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

  it("suppresses stale backlog rows but dispatches fresh live rows", async () => {
    // Dates are relative to real now so the age fence sees the intended ages
    // (the live debouncer also flushes on a real 0ms timer here).
    const staleCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const freshCreatedAt = new Date().toISOString();

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        // Stale backlog row (old send date) Apple delivered after a recovery —
        // must be suppressed by the age fence.
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 2023,
              guid: "OLD-GUID-2023",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "old backlog row",
              is_group: false,
              created_at: staleCreatedAt,
            },
          },
        });
        // Fresh live row — must dispatch.
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
              created_at: freshCreatedAt,
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
            // Unreadable dbPath => no startup rowid watermark, so this test
            // isolates the age-fence behavior on the live path.
            dbPath: path.join(os.tmpdir(), `openclaw-missing-chat-${Date.now()}.db`),
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
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
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("passes the startup rowid watermark as since_rowid when chat.db is readable", async () => {
    // Regression guard: the watermark is captured before the transport-ready
    // probe so messages that land during the startup window are not skipped by
    // imsg's self-fence at subscribe time.
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-startup-rowid-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "watermark");
    } finally {
      database.close();
    }
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
      { attachments: false, include_reactions: true, since_rowid: 5000 },
      { timeoutMs: 10_000 },
    );
  });

  it("recovers over a remote cliPath: replays from the cursor even without a local chat.db boundary", async () => {
    advanceIMessageRecoveryCursor("default", 4990);
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async () => client as never);

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            // remoteHost set => no local chat.db boundary; recovery must still
            // drive since_rowid from the persisted cursor over the RPC client.
            remoteHost: "user@gateway-host",
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 4990 },
      { timeoutMs: 10_000 },
    );
  });

  it("preserves enabled legacy catchup as the startup replay path", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-catchup-window-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    } finally {
      database.close();
    }
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        if (method === "chats.list") {
          return { chats: [] };
        }
        throw new Error(`unexpected request ${method}`);
      }),
      waitForClose: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    createIMessageRpcClientMock.mockImplementation(async () => client as never);

    await monitorIMessageProvider({
      config: {
        channels: {
          imessage: {
            dbPath,
            catchup: { enabled: true, perRunLimit: 25, maxAgeMinutes: 60 },
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
          },
        },
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
    expect(client.request).toHaveBeenCalledWith(
      "chats.list",
      { limit: 200 },
      { timeoutMs: 30_000 },
    );
  });

  it("recovers downtime messages: replays from the cursor and delivers replay rows older than the live fence", async () => {
    advanceIMessageRecoveryCursor("default", 4990);
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-recovery-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    } finally {
      database.close();
    }
    // 30 min old: inside the 2h recovery window, outside the 15min live fence.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        // Recovery replay row (rowid <= boundary 5000): missed during downtime,
        // delivered despite being 30min old.
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 4995,
              guid: "RECOVERY-GUID-4995",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "missed during downtime",
              is_group: false,
              created_at: thirtyMinAgo,
            },
          },
        });
        // Live row (rowid > boundary) with the same old date: this is the
        // #89237 Push-flush backlog shape, suppressed at the live fence.
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 5001,
              guid: "LIVE-OLD-GUID-5001",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "live backlog bomb",
              is_group: false,
              created_at: thirtyMinAgo,
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

    // since_rowid replays from the persisted cursor, not the boundary.
    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 4990 },
      { timeoutMs: 10_000 },
    );
    // The recovery replay row dispatches; the live old row is suppressed.
    await vi.waitFor(() => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not treat startup-boundary rows as recovery replay without a prior cursor", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-first-run-boundary-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    } finally {
      database.close();
    }
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 4995,
              guid: "FIRST-RUN-HISTORY-GUID-4995",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "already existed before first monitor start",
              is_group: false,
              created_at: thirtyMinAgo,
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

    expect(client.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true, since_rowid: 5000 },
      { timeoutMs: 10_000 },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("records a suppressed live row so a later replay of the same row is deduped, not delivered", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-suppress-record-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    } finally {
      database.close();
    }
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        // Live row (rowid > boundary), 30min old -> suppressed by the live fence
        // AND recorded in the dedupe.
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 5001,
              guid: "SUPPRESSED-GUID",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "stale live backlog",
              is_group: false,
              created_at: thirtyMinAgo,
            },
          },
        });
        // Same GUID re-emitted fresh (as a restart replay would): must be
        // dropped as a duplicate, not delivered under the recovery window.
        onNotification?.({
          method: "message",
          params: {
            message: {
              id: 5001,
              guid: "SUPPRESSED-GUID",
              chat_id: 123,
              sender: "+15550001111",
              is_from_me: false,
              text: "stale live backlog",
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
        channels: { imessage: { dbPath, dmPolicy: "allowlist", allowFrom: ["+15550001111"] } },
        messages: { inbound: { debounceMs: 0 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("does not advance the recovery cursor past a failed replay row", async () => {
    advanceIMessageRecoveryCursor("default", 4990);
    debouncerControl.holdEntries = true;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-recovery-failed-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    } finally {
      database.close();
    }
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    dispatchInboundMessageMock
      .mockRejectedValueOnce(new Error("dispatch failed"))
      .mockResolvedValue({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        for (const id of [4995, 4996]) {
          onNotification?.({
            method: "message",
            params: {
              message: {
                id,
                guid: `FAILED-REPLAY-GUID-${id}`,
                chat_id: 123,
                sender: "+15550001111",
                is_from_me: false,
                text: `missed during downtime ${id}`,
                is_group: false,
                balloon_bundle_id: "com.apple.messages.Handwriting",
                created_at: thirtyMinAgo,
              },
            },
          });
        }
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
      { attachments: false, include_reactions: true, since_rowid: 4990 },
      { timeoutMs: 10_000 },
    );
    await vi.waitFor(() => {
      expect(debouncerControl.entries).toHaveLength(2);
    });
    await debouncerControl.flush?.();
    await vi.waitFor(() => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(loadIMessageRecoveryCursor("default")).toBe(4994);
  });

  it("advances the recovery cursor after lower pending replay rows complete", async () => {
    advanceIMessageRecoveryCursor("default", 4990);
    debouncerControl.holdEntries = true;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imsg-recovery-ordered-"));
    tempDirs.push(stateDir);
    const dbPath = path.join(stateDir, "chat.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath);
    try {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    } finally {
      database.close();
    }
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({ subscription: 1 })),
      waitForClose: vi.fn(async () => {
        for (const id of [4995, 4996]) {
          onNotification?.({
            method: "message",
            params: {
              message: {
                id,
                guid: `OUT-OF-ORDER-REPLAY-GUID-${id}`,
                chat_id: 123,
                sender: "+15550001111",
                is_from_me: false,
                text: `missed during downtime ${id}`,
                is_group: false,
                balloon_bundle_id: "com.apple.messages.Handwriting",
                created_at: thirtyMinAgo,
              },
            },
          });
        }
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
      expect(debouncerControl.entries).toHaveLength(2);
    });
    debouncerControl.entries.reverse();
    await debouncerControl.flush?.();
    await vi.waitFor(() => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    });
    expect(loadIMessageRecoveryCursor("default")).toBe(4996);
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

  it("legacy-merges coalesce buckets when imsg emits no balloon metadata (older builds)", async () => {
    // Back-compat: older imsg builds emit no balloon_bundle_id, so a Dump + URL
    // split-send arrives as two fieldless rows. We cannot structurally tell that
    // apart from separate sends, so we preserve the pre-metadata merge rather
    // than regress split-send users to two turns. Removed once imsg coalesces
    // upstream (openclaw/imsg#141, tracked by #91243).
    debouncerControl.holdEntries = true;

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        // Fresh dates relative to now so the stale-backlog age fence lets the
        // live split-send through to the coalescer.
        for (const row of [
          {
            id: 91,
            guid: "LIVE-GUID-91",
            text: "Dump",
            created_at: new Date(Date.now() - 2000).toISOString(),
          },
          {
            id: 92,
            guid: "LIVE-GUID-92",
            text: "https://example.com",
            created_at: new Date(Date.now() - 1000).toISOString(),
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
            coalesceSameSenderDms: true,
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
            sendReadReceipts: false,
          },
        },
        messages: { inbound: { debounceMs: 2500 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    const mergedBody = dispatchInboundMessageMock.mock.calls[0]?.[0].ctx.Body ?? "";
    expect(mergedBody).toContain("Dump");
    expect(mergedBody).toContain("https://example.com");
  });

  it("merges coalesce buckets when imsg marks the URL balloon row structurally", async () => {
    debouncerControl.holdEntries = true;

    let onNotification: ((message: { method: string; params: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "watch.subscribe") {
          return { subscription: 1 };
        }
        throw new Error(`unexpected imsg method ${method}`);
      }),
      waitForClose: vi.fn(async () => {
        // Fresh dates relative to now so the stale-backlog age fence lets the
        // live split-send through to the coalescer.
        for (const row of [
          {
            id: 93,
            guid: "LIVE-GUID-93",
            text: "Dump",
            created_at: new Date(Date.now() - 2000).toISOString(),
          },
          {
            id: 94,
            guid: "LIVE-GUID-94",
            text: "https://example.com",
            balloon_bundle_id: "com.apple.messages.URLBalloonProvider",
            created_at: new Date(Date.now() - 1000).toISOString(),
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
            coalesceSameSenderDms: true,
            dmPolicy: "allowlist",
            allowFrom: ["+15550001111"],
            sendReadReceipts: false,
          },
        },
        messages: { inbound: { debounceMs: 2500 } },
        session: { mainKey: "main" },
      } as never,
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchInboundMessageMock.mock.calls[0]?.[0].ctx.Body).toContain(
      "Dump https://example.com",
    );
  });
});
