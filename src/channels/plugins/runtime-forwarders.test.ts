import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
} from "./runtime-forwarders.js";
import type { ChannelOutboundAdapter } from "./types.adapters.js";

type RenderPresentationParams = Parameters<
  NonNullable<ChannelOutboundAdapter["renderPresentation"]>
>[0];

describe("createRuntimeDirectoryLiveAdapter", () => {
  it("forwards live directory calls through the runtime getter", async () => {
    const self = vi.fn(async (_ctx: unknown) => ({ kind: "user" as const, id: "self" }));
    const listPeersLive = vi.fn(async (_ctx: unknown) => [{ kind: "user" as const, id: "alice" }]);
    const adapter = createRuntimeDirectoryLiveAdapter({
      getRuntime: async () => ({ self, listPeersLive }),
      self: (runtime) => runtime.self,
      listPeersLive: (runtime) => runtime.listPeersLive,
    });

    await expect(adapter.self?.({ cfg: {} as never, runtime: {} as never })).resolves.toEqual({
      kind: "user",
      id: "self",
    });
    await expect(
      adapter.listPeersLive?.({ cfg: {} as never, runtime: {} as never, query: "a", limit: 1 }),
    ).resolves.toEqual([{ kind: "user", id: "alice" }]);
    expect(self).toHaveBeenCalled();
    expect(listPeersLive).toHaveBeenCalled();
  });
});

describe("createRuntimeOutboundDelegates", () => {
  it("forwards outbound methods through the runtime getter", async () => {
    const renderPresentation = vi.fn(async (ctx: RenderPresentationParams) => ({
      ...ctx.payload,
      text: "rendered",
    }));
    const sendPayload = vi.fn(async () => ({ channel: "x", messageId: "payload-1" }));
    const sendText = vi.fn(async () => ({ channel: "x", messageId: "1" }));
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({ outbound: { renderPresentation, sendPayload, sendText } }),
      renderPresentation: { resolve: (runtime) => runtime.outbound.renderPresentation },
      sendPayload: { resolve: (runtime) => runtime.outbound.sendPayload },
      sendText: { resolve: (runtime) => runtime.outbound.sendText },
    });

    await expect(
      outbound.renderPresentation?.({
        payload: { text: "raw" },
        presentation: { blocks: [{ type: "text", text: "shown" }] },
        ctx: {} as never,
      }),
    ).resolves.toEqual({
      text: "rendered",
    });
    await expect(
      outbound.sendPayload?.({ cfg: {} as never, to: "a", text: "hi", payload: { text: "hi" } }),
    ).resolves.toEqual({ channel: "x", messageId: "payload-1" });
    await expect(outbound.sendText?.({ cfg: {} as never, to: "a", text: "hi" })).resolves.toEqual({
      channel: "x",
      messageId: "1",
    });
    expect(renderPresentation).toHaveBeenCalled();
    expect(sendPayload).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalled();
  });

  it("throws the configured unavailable message", async () => {
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({ outbound: {} }),
      sendPoll: {
        resolve: () => undefined,
        unavailableMessage: "poll unavailable",
      },
    });

    await expect(
      outbound.sendPoll?.({
        cfg: {} as never,
        to: "a",
        poll: { question: "q", options: ["a"] },
      }),
    ).rejects.toThrow("poll unavailable");
  });
});
