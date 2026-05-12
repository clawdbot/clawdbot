import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";

describe("createChannelReplyPipeline", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      name: "builds prefix options without forcing typing support",
      input: {
        cfg: {},
        agentId: "main",
        channel: "telegram",
        accountId: "default",
      },
      expectTypingCallbacks: false,
    },
    {
      name: "builds typing callbacks when typing config is provided",
      input: {
        cfg: {},
        agentId: "main",
        channel: "discord",
        accountId: "default",
        typing: {
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          onStartError: () => {},
        },
      },
      expectTypingCallbacks: true,
    },
  ])("$name", async ({ input, expectTypingCallbacks }) => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const pipeline = createChannelReplyPipeline(
      expectTypingCallbacks
        ? {
            ...input,
            typing: {
              start,
              stop,
              onStartError: () => {},
            },
          }
        : input,
    );

    pipeline.onModelSelected({
      provider: "openai",
      model: "gpt-5.5",
      thinkLevel: "high",
    });
    const prefixContext = pipeline.responsePrefixContextProvider();
    expect(prefixContext.model).toBe("gpt-5.5");
    expect(prefixContext.modelFull).toBe("openai/gpt-5.5");
    expect(prefixContext.provider).toBe("openai");
    expect(prefixContext.thinkingLevel).toBe("high");

    if (!expectTypingCallbacks) {
      expect(pipeline.typingCallbacks).toBeUndefined();
      return;
    }

    await pipeline.typingCallbacks?.onReplyStart();
    pipeline.typingCallbacks?.onIdle?.();

    expect(start).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it("preserves explicit typing callbacks when a channel needs custom lifecycle hooks", async () => {
    const onReplyStart = vi.fn(async () => {});
    const onIdle = vi.fn(() => {});
    const pipeline = createChannelReplyPipeline({
      cfg: {},
      agentId: "main",
      channel: "imessage",
      typingCallbacks: {
        onReplyStart,
        onIdle,
      },
    });

    await pipeline.typingCallbacks?.onReplyStart();
    pipeline.typingCallbacks?.onIdle?.();

    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("uses an explicit reply transform without resolving the channel plugin", () => {
    const transformReplyPayload = vi.fn((payload) => payload);
    const pipeline = createChannelReplyPipeline({
      cfg: {},
      agentId: "main",
      channel: "slack",
      transformReplyPayload,
    });

    expect(pipeline.transformReplyPayload).toBe(transformReplyPayload);
  });

  it("resolves reply transforms from the loaded channel registry", () => {
    const transformReplyPayload = vi.fn(({ payload }: { payload: { text?: string } }) =>
      payload.text ? { ...payload, text: `${payload.text} transformed` } : payload,
    );
    const channelPlugin = {
      id: "demo-channel",
      meta: {},
      messaging: { transformReplyPayload },
    } as unknown as ChannelPlugin;
    setActivePluginRegistry({
      ...createEmptyPluginRegistry(),
      channels: [
        {
          pluginId: "demo",
          pluginName: "Demo",
          plugin: channelPlugin,
          source: "test",
        },
      ],
    });

    const pipeline = createChannelReplyPipeline({
      cfg: {},
      agentId: "main",
      channel: "demo-channel",
      accountId: "acct",
    });

    expect(pipeline.transformReplyPayload?.({ text: "reply" })).toEqual({
      text: "reply transformed",
    });
    expect(transformReplyPayload).toHaveBeenCalledWith({
      payload: { text: "reply" },
      cfg: {},
      accountId: "acct",
    });
  });
});
