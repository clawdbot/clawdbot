import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
} from "./runtime-forwarders.js";

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
    const sendText = vi.fn(async () => ({ channel: "x", messageId: "1" }));
    const outbound = createRuntimeOutboundDelegates({
      getRuntime: async () => ({ outbound: { sendText } }),
      sendText: { resolve: (runtime) => runtime.outbound.sendText },
    });

    await expect(outbound.sendText?.({ cfg: {} as never, to: "a", text: "hi" })).resolves.toEqual({
      channel: "x",
      messageId: "1",
    });
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
