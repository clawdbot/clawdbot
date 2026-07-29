// Whatsapp plugin module implements auto reply.broadcast groups harness behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import {
  createWebInboundDeliverySpies,
  createWebListenerFactoryCapture,
  sendWebDirectInboundMessage,
} from "./auto-reply.test-harness.js";
import { monitorWebChannel } from "./auto-reply/monitor.js";
import type { WebInboundMessageInput } from "./inbound.js";

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  type RunParams = Parameters<typeof actual.runChannelInboundEvent>[0];
  return {
    ...actual,
    runChannelInboundEvent: (params: RunParams) => {
      const runtime = createPluginRuntimeMock({
        channel: {
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: async (dispatchParams) => {
              const resolver = dispatchParams.replyResolver;
              if (!resolver) {
                throw new Error("Missing broadcast reply resolver");
              }
              const reply = await resolver(
                dispatchParams.ctx,
                dispatchParams.replyOptions,
                dispatchParams.cfg,
              );
              const finalCount = Array.isArray(reply) ? reply.length : reply ? 1 : 0;
              return {
                queuedFinal: finalCount > 0,
                counts: { tool: 0, block: 0, final: finalCount },
              };
            },
          },
        },
      });
      return runtime.channel.inbound.run(params);
    },
  };
});

export async function monitorWebChannelWithCapture(resolver: unknown): Promise<{
  spies: ReturnType<typeof createWebInboundDeliverySpies>;
  onMessage: (msg: WebInboundMessageInput) => Promise<void>;
}> {
  const spies = createWebInboundDeliverySpies();
  const { listenerFactory, getOnMessage } = createWebListenerFactoryCapture();

  await monitorWebChannel(false, listenerFactory, false, resolver as never);
  const onMessage = getOnMessage();
  if (!onMessage) {
    throw new Error("Missing onMessage handler");
  }

  return { spies, onMessage };
}

export async function sendWebDirectInboundAndCollectSessionKeys(): Promise<{
  seen: string[];
  resolver: ReturnType<typeof vi.fn>;
}> {
  const seen: string[] = [];
  const resolver = vi.fn(async (ctx: { SessionKey?: unknown }) => {
    seen.push(String(ctx.SessionKey));
    return { text: "ok" };
  });

  const { spies, onMessage } = await monitorWebChannelWithCapture(resolver);
  await sendWebDirectInboundMessage({
    onMessage,
    spies,
    id: "m1",
    from: "+1000",
    to: "+2000",
    body: "hello",
  });

  return { seen, resolver };
}
