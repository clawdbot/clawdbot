import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import {
  expectFirstSentCardUsesFillWidthOnly,
  expectSentCardHasP2pAction,
} from "./card-test-helpers.js";
import {
  createQuickActionLauncherCard,
  isFeishuQuickActionMenuEventKey,
  maybeHandleFeishuQuickActionMenu,
} from "./card-ux-launcher.js";

const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
}));

describe("feishu quick-action launcher", () => {
  const cfg: ClawdbotConfig = {};

  afterAll(() => {
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recognizes the quick-actions bot menu key", () => {
    expect(isFeishuQuickActionMenuEventKey("quick-actions")).toBe(true);
    expect(isFeishuQuickActionMenuEventKey("other")).toBe(false);
  });

  it("builds a launcher card with interactive actions", () => {
    const card = createQuickActionLauncherCard({
      operatorOpenId: "u123",
      chatId: "chat1",
      expiresAt: 123,
      sessionKey: "agent:codex:feishu:chat:chat1",
    }) as {
      config: {
        width_mode?: string;
        enable_forward?: boolean;
        wide_screen_mode?: boolean;
      };
      body: {
        elements: Array<{
          tag: string;
          actions?: Array<{ value?: { oc?: string; c?: { s?: string; t?: string } } }>;
        }>;
      };
    };

    expect(card.config.width_mode).toBe("fill");
    expect(card.config.enable_forward).toBeUndefined();
    expect(card.config.wide_screen_mode).toBeUndefined();
    const actionBlock = card.body.elements.find((entry) => entry.tag === "action");
    expect(actionBlock?.actions).toHaveLength(3);
    expect(actionBlock?.actions?.[0]?.value?.oc).toBe("ocf1");
    expect(actionBlock?.actions?.[0]?.value?.c?.s).toBe("agent:codex:feishu:chat:chat1");
    expect(actionBlock?.actions?.[0]?.value?.c?.t).toBeUndefined();
  });

  it("opens the launcher from a supported bot menu event", async () => {
    sendCardFeishuMock.mockResolvedValue({ messageId: "m1", chatId: "c1" });

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      now: 100,
    });

    expect(handled).toBe(true);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendCardFeishuMock.mock.calls.at(0)?.[0] as
      | { accountId?: string; card?: unknown; cfg?: ClawdbotConfig; to?: string }
      | undefined;
    expect(Object.keys(sendArgs ?? {}).toSorted()).toEqual(["accountId", "card", "cfg", "to"]);
    expect(sendArgs?.cfg).toBe(cfg);
    expect(sendArgs?.to).toBe("user:u123");
    expect(sendArgs?.accountId).toBe("main");
    expectSentCardHasP2pAction(sendCardFeishuMock);
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
  });

  it("falls back to legacy menu handling when launcher send fails", async () => {
    sendCardFeishuMock.mockRejectedValueOnce(new Error("network"));
    const runtime: RuntimeEnv = createRuntimeEnv();

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      runtime,
      now: 100,
    });

    expect(handled).toBe(false);
  });
});
