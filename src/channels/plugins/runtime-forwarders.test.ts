// Runtime forwarder tests cover channel plugin runtime method delegation and fallback handling.
import { describe, expect, it, vi } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
} from "./runtime-forwarders.js";
import type { ChannelOutboundAdapter } from "./types.adapters.js";

type RenderPresentationParams = Parameters<
  NonNullable<ChannelOutboundAdapter["renderPresentation"]>
>[0];

describe("createRuntimeDirectoryLiveAdapter", () => {
  it("omits unconfigured methods without loading the runtime", () => {
    const getRuntime = vi.fn();

    expect(createRuntimeDirectoryLiveAdapter({ getRuntime })).toStrictEqual({});
    expect(getRuntime).not.toHaveBeenCalled();
  });

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
  it("leaves unconfigured methods undefined without loading the runtime", () => {
    const getRuntime = vi.fn();

    expect(createRuntimeOutboundDelegates({ getRuntime })).toStrictEqual({
      renderPresentation: undefined,
      sendPayload: undefined,
      sendText: undefined,
      sendMedia: undefined,
      sendPoll: undefined,
    });
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it("resolves the current runtime and method for each call", async () => {
    const firstSender = vi.fn(async () => ({ channel: "x", messageId: "first" }));
    const secondSender = vi.fn(async () => ({ channel: "x", messageId: "second" }));
    const params = {
      getRuntime: vi.fn(async () => ({ sendText: firstSender })),
      sendText: { resolve: (runtime: { sendText: typeof firstSender }) => runtime.sendText },
    };
    const outbound = createRuntimeOutboundDelegates(params);
    const ctx = { cfg: {}, to: "a", text: "hi" };

    expect(params.getRuntime).not.toHaveBeenCalled();
    await expect(outbound.sendText?.(ctx)).resolves.toMatchObject({ messageId: "first" });
    params.getRuntime = vi.fn(async () => ({ sendText: secondSender }));
    params.sendText = { resolve: () => firstSender };
    await expect(outbound.sendText?.(ctx)).resolves.toMatchObject({ messageId: "first" });
    params.sendText = { resolve: (runtime) => runtime.sendText };
    await expect(outbound.sendText?.(ctx)).resolves.toMatchObject({ messageId: "second" });
    expect(params.getRuntime).toHaveBeenCalledTimes(2);
    expect(firstSender).toHaveBeenCalledWith(ctx);
    expect(secondSender).toHaveBeenCalledWith(ctx);
  });

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

  it("classifies unavailable outbound runtime methods as definitely not dispatched", async () => {
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({ outbound: {} }),
      sendPoll: {
        resolve: () => undefined,
        unavailableMessage: "poll unavailable",
      },
    });

    const error = await outbound
      .sendPoll?.({
        cfg: {} as never,
        to: "a",
        poll: { question: "q", options: ["a"] },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(error).toMatchObject({ message: "poll unavailable" });
  });

  it("classifies outbound runtime loading failures before method dispatch", async () => {
    const loadError = new Error("runtime import failed");
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => {
        throw loadError;
      },
      sendText: {
        resolve: (runtime: { sendText?: ChannelOutboundAdapter["sendText"] }) => runtime.sendText,
      },
    });

    await expect(
      outbound.sendText?.({ cfg: {} as never, to: "a", text: "hi" }),
    ).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      message: "runtime import failed",
      cause: loadError,
    });
  });

  it.each(["throw", "reject"])("preserves sender failures that %s", async (failure) => {
    const sendError = new Error("send outcome unknown");
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({
        sendText: () => {
          if (failure === "throw") {
            throw sendError;
          }
          return Promise.reject(sendError);
        },
      }),
      sendText: {
        resolve: (runtime) => runtime.sendText,
        unavailableMessage: "sender unavailable",
      },
    });

    await expect(outbound.sendText?.({ cfg: {}, to: "a", text: "hi" })).rejects.toBe(sendError);
  });

  it("preserves presentation runtime loading failures without classifying dispatch", async () => {
    const loadError = new Error("renderer import failed");
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => {
        throw loadError;
      },
      renderPresentation: {
        resolve: () => undefined,
        unavailableMessage: "renderer unavailable",
      },
    });

    await expect(
      outbound.renderPresentation?.({
        payload: { text: "raw" },
        presentation: { blocks: [{ type: "text", text: "shown" }] },
        ctx: { cfg: {}, to: "a", text: "raw", payload: { text: "raw" } },
      }),
    ).rejects.toBe(loadError);
  });
});
