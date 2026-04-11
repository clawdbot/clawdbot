import { describe, expect, it, vi } from "vitest";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";

describe("createChannelReplyPipeline", () => {
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

    expect(typeof pipeline.onModelSelected).toBe("function");
    expect(typeof pipeline.responsePrefixContextProvider).toBe("function");

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
      channel: "bluebubbles",
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
});
