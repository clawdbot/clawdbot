import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { expectFirstSentCardUsesFillWidthOnly } from "./card-test-helpers.js";
import { createFeishuBotMenuHandler } from "./monitor.bot-menu-handler.js";

const handleFeishuMessageMock = vi.hoisted(() => vi.fn(async () => {}));
const parseFeishuMessageEventMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "m1", chatId: "c1" })));
const getMessageFeishuMock = vi.hoisted(() => vi.fn());

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

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
  return createFeishuBotMenuHandler({
    cfg: {} as ClawdbotConfig,
    accountId: "default",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    chatHistories: new Map(),
    fireAndForget: true,
    getBotOpenId: () => "ou_bot",
    getBotName: () => "Bot",
  });
}

describe("Feishu bot menu handler", () => {
  beforeEach(() => {
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
