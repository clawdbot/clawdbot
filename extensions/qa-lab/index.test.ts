import { describe, expect, it, vi } from "vitest";

const qaChannelLoads = vi.hoisted(() => vi.fn());
const qaChannelProtocolLoads = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/qa-channel", () => {
  qaChannelLoads();
  throw new Error("QA Lab entrypoint loaded the private QA channel");
});

vi.mock("openclaw/plugin-sdk/qa-channel-protocol", () => {
  qaChannelProtocolLoads();
  throw new Error("QA Lab entrypoint loaded the private QA channel protocol");
});

describe("QA Lab plugin entrypoint", () => {
  it("loads without the private QA transport runtime", async () => {
    const { default: plugin } = await import("./index.js");

    expect(plugin.id).toBe("qa-lab");
    expect(qaChannelLoads).not.toHaveBeenCalled();
    expect(qaChannelProtocolLoads).not.toHaveBeenCalled();
  });

  it("loads the package Telegram harness without the private QA transport runtime", async () => {
    const { runQaTelegramSuite } = await import("./src/live-transports/telegram/cli.runtime.js");

    expect(runQaTelegramSuite).toBeTypeOf("function");
    expect(qaChannelLoads).not.toHaveBeenCalled();
    expect(qaChannelProtocolLoads).not.toHaveBeenCalled();
  });
});
