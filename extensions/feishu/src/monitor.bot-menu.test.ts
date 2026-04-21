import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { expectFirstSentCardUsesFillWidthOnly } from "./card-test-helpers.js";
import { monitorSingleAccount } from "./monitor.account.js";
import { setFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createEventDispatcherMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn(async () => {}));
const monitorWebhookMock = vi.hoisted(() => vi.fn(async () => {}));
const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const parseFeishuMessageEventMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "m1", chatId: "c1" })));
const getMessageFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuThreadBindingManagerMock = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })));

let handlers: Record<string, (data: unknown) => Promise<void>> = {};
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

const hasControlCommand = () => false;
const resolveInboundDebounceMs = () => 0;
const createInboundDebouncer = () => ({
  run: async <T>(fn: () => Promise<T>) => await fn(),
});
const createMonitorRuntime = () =>
  ({
    channel: {
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs,
      },
      text: {
        hasControlCommand,
      },
    },
  }) as never;

vi.mock("./client.js", () => ({
  createEventDispatcher: createEventDispatcherMock,
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebSocket: monitorWebSocketMock,
  monitorWebhook: monitorWebhookMock,
}));

vi.mock("./bot.js", () => {
  return {
    handleFeishuMessage: handleFeishuMessageMock,
    parseFeishuMessageEvent: parseFeishuMessageEventMock,
  };
});

vi.mock("./send.js", () => {
  return {
    sendCardFeishu: sendCardFeishuMock,
    getMessageFeishu: getMessageFeishuMock,
  };
});

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: createFeishuThreadBindingManagerMock,
}));

function buildAccount(): ResolvedFeishuAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret_test", // pragma: allowlist secret
    domain: "feishu",
    config: {
      enabled: true,
      connectionMode: "websocket",
    },
  } as ResolvedFeishuAccount;
}

function createBotMenuEvent(params: { eventKey: string; timestamp: string }) {
  return {
    event_key: params.eventKey,
    timestamp: params.timestamp,
    operator: {
      operator_id: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
    },
  };
}

async function registerHandlers() {
  setFeishuRuntime(createMonitorRuntime());
  const register = vi.fn((registered: Record<string, (data: unknown) => Promise<void>>) => {
    handlers = registered;
  });
  createEventDispatcherMock.mockReturnValue({ register });

  await monitorSingleAccount({
    cfg: {} as ClawdbotConfig,
    account: buildAccount(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as RuntimeEnv,
    botOpenIdSource: {
      kind: "prefetched",
      botOpenId: "ou_bot",
      botName: "Bot",
    },
  });

  const onBotMenu = handlers["application.bot.menu_v6"];
  if (!onBotMenu) {
    throw new Error("missing application.bot.menu_v6 handler");
  }
  return onBotMenu;
}

describe("Feishu bot menu handler", () => {
  beforeEach(() => {
    handlers = {};
    vi.clearAllMocks();
    process.env.OPENCLAW_STATE_DIR = `/tmp/openclaw-feishu-bot-menu-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
      return;
    }
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("opens the quick-action launcher card at the webhook/event layer", async () => {
    const onBotMenu = await registerHandlers();

    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000000" }));

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_user1",
        card: expect.objectContaining({
          config: expect.objectContaining({
            width_mode: "fill",
          }),
          header: expect.objectContaining({
            title: expect.objectContaining({ content: "Quick actions" }),
          }),
        }),
      }),
    );
    expect(handleFeishuMessageMock).not.toHaveBeenCalled();
  });

  it("does not block bot-menu handling on quick-action launcher send", async () => {
    const onBotMenu = await registerHandlers();
    let resolveSend: (() => void) | undefined;
    sendCardFeishuMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({ messageId: "m1", chatId: "c1" });
        }),
    );

    const pending = onBotMenu(
      createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000001" }),
    );
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });

    resolveSend?.();
    await pending;
  });

  it("falls back to the legacy /menu synthetic message path for unrelated bot menu keys", async () => {
    const onBotMenu = await registerHandlers();

    await onBotMenu(createBotMenuEvent({ eventKey: "custom-key", timestamp: "1700000000002" }));

    expect(handleFeishuMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/menu custom-key"}',
          }),
        }),
      }),
    );
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy /menu path when launcher rendering fails", async () => {
    const onBotMenu = await registerHandlers();
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));

    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000003" }));

    await vi.waitFor(() => {
      expect(handleFeishuMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            message: expect.objectContaining({
              content: '{"text":"/menu quick-actions"}',
            }),
          }),
        }),
      );
    });
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
  });

  it("reopens replay for explicit retryable fallback failures", async () => {
    const onBotMenu = await registerHandlers();
    sendCardFeishuMock
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      })
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      });
    handleFeishuMessageMock
      .mockRejectedValueOnce(
        Object.assign(new Error("retry me"), {
          name: "FeishuRetryableSyntheticEventError",
        }),
      )
      .mockResolvedValueOnce(undefined);

    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000004" }));
    await onBotMenu(createBotMenuEvent({ eventKey: "quick-actions", timestamp: "1700000000004" }));

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(2);
    expect(handleFeishuMessageMock).toHaveBeenCalledTimes(1);
  });
});
