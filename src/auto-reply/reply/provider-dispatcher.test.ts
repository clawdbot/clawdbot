import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "./reply-dispatcher.js";

type BufferedDispatchFn =
  typeof import("../dispatch.js").dispatchInboundMessageWithBufferedDispatcher;
type PlainDispatchFn = typeof import("../dispatch.js").dispatchInboundMessageWithDispatcher;

const hoisted = vi.hoisted(() => ({
  bufferedDispatchMock: vi.fn(),
  plainDispatchMock: vi.fn(),
}));

vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithBufferedDispatcher: (...args: Parameters<BufferedDispatchFn>) =>
    hoisted.bufferedDispatchMock(...args),
  dispatchInboundMessageWithDispatcher: (...args: Parameters<PlainDispatchFn>) =>
    hoisted.plainDispatchMock(...args),
}));

const { dispatchReplyWithBufferedBlockDispatcher, dispatchReplyWithDispatcher } =
  await import("./provider-dispatcher.js");

const dispatchResult = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
};

describe("provider dispatcher wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.bufferedDispatchMock.mockResolvedValue(dispatchResult);
    hoisted.plainDispatchMock.mockResolvedValue(dispatchResult);
  });

  it("forwards runtime toolsAllow through the buffered wrapper", async () => {
    const dispatcherOptions = {
      deliver: async () => ({ visibleReplySent: false }),
    } satisfies ReplyDispatcherWithTypingOptions;

    await dispatchReplyWithBufferedBlockDispatcher({
      ctx: { Body: "hello" },
      cfg: {} as OpenClawConfig,
      dispatcherOptions,
      toolsAllow: ["message"],
    });

    expect(hoisted.bufferedDispatchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.bufferedDispatchMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        dispatcherOptions,
        toolsAllow: ["message"],
      }),
    );
  });

  it("forwards runtime toolsAllow through the plain wrapper", async () => {
    const dispatcherOptions = {
      deliver: async () => ({ visibleReplySent: false }),
    } satisfies ReplyDispatcherOptions;

    await dispatchReplyWithDispatcher({
      ctx: { Body: "hello" },
      cfg: {} as OpenClawConfig,
      dispatcherOptions,
      toolsAllow: ["message"],
    });

    expect(hoisted.plainDispatchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.plainDispatchMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        dispatcherOptions,
        toolsAllow: ["message"],
      }),
    );
  });
});
