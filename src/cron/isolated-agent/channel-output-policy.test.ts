import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCronChannelOutputPolicy,
  resolveCurrentChannelTarget,
} from "./channel-output-policy.js";

const channelPluginMocks = vi.hoisted(() => ({
  getChannelPlugin: vi.fn((channelId: string) => {
    if (channelId !== "topicchat") {
      return undefined;
    }
    return {
      threading: {
        resolveCurrentChannelId: ({
          to,
          threadId,
        }: {
          to: string;
          threadId?: string | number | null;
        }) => (threadId == null ? to : `${to}#${threadId}`),
      },
      outbound: {
        preferFinalAssistantVisibleText: true,
      },
    };
  }),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) => channelPluginMocks.getChannelPlugin(channelId),
}));

describe("cron channel output policy", () => {
  beforeEach(() => {
    channelPluginMocks.getChannelPlugin.mockClear();
  });

  it("reads final visible text preference from the channel plugin", async () => {
    await expect(resolveCronChannelOutputPolicy("topicchat")).resolves.toEqual({
      preferFinalAssistantVisibleText: true,
    });
    await expect(resolveCronChannelOutputPolicy("plainchat")).resolves.toEqual({
      preferFinalAssistantVisibleText: false,
    });
  });

  it("lets channel plugins format current tool context targets", async () => {
    await expect(
      resolveCurrentChannelTarget({
        channel: "topicchat",
        to: "room",
        threadId: 42,
      }),
    ).resolves.toBe("room#42");
    await expect(
      resolveCurrentChannelTarget({
        channel: "plainchat",
        to: "room",
        threadId: 42,
      }),
    ).resolves.toBe("room");
  });
});
