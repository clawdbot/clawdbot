// Channel output policy tests cover isolated agent delivery output filtering.
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

  it("prefers final visible text only for unresolved no-delivery runs", async () => {
    await expect(
      resolveCronChannelOutputPolicy(undefined, { deliveryRequested: false }),
    ).resolves.toEqual({
      preferFinalAssistantVisibleText: true,
    });
    await expect(
      resolveCronChannelOutputPolicy(undefined, { deliveryRequested: true }),
    ).resolves.toEqual({
      preferFinalAssistantVisibleText: false,
    });
    // deliveryRequested is optional — undefined and missing opts are
    // equivalent to "not requested" (no channel to deliver to). #90664
    await expect(
      resolveCronChannelOutputPolicy(undefined, { deliveryRequested: undefined }),
    ).resolves.toEqual({
      preferFinalAssistantVisibleText: true,
    });
    await expect(resolveCronChannelOutputPolicy(undefined)).resolves.toEqual({
      preferFinalAssistantVisibleText: true,
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
