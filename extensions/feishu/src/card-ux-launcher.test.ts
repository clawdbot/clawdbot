// Feishu tests cover card ux launcher plugin behavior.
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import {
  expectFirstSentCardUsesFillWidthOnly,
  expectSentCardHasP2pAction,
} from "./card-test-helpers.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";

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

  it("ignores unsupported bot menu keys", async () => {
    await expect(
      maybeHandleFeishuQuickActionMenu({
        cfg,
        eventKey: "other",
        operatorOpenId: "u123",
      }),
    ).resolves.toBe(false);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
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

  it("does not send launcher cards when expiry would exceed a valid Date", async () => {
    const runtime: RuntimeEnv = createRuntimeEnv();

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      runtime,
      now: 8_640_000_000_000_000,
    });

    expect(handled).toBe(false);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[main]: failed to open quick-action launcher for u123: invalid expiry clock",
    );
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
