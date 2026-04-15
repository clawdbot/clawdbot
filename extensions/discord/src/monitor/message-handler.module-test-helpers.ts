import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";
import type { DiscordInboundWorkerTestingHooks } from "./inbound-worker.js";

export const preflightDiscordMessageMock: MockFn = vi.fn();
export const processDiscordMessageMock: MockFn = vi.fn();
export const deliverDiscordReplyMock: MockFn = vi.fn(async () => undefined);

const { createDiscordMessageHandler: createRealDiscordMessageHandler } =
  await import("./message-handler.js");
type DiscordMessageHandlerParams = Parameters<typeof createRealDiscordMessageHandler>[0];
type DiscordMessageHandlerTestingHooks = NonNullable<DiscordMessageHandlerParams["__testing"]>;
type PreflightDiscordMessageHook = NonNullable<
  DiscordMessageHandlerTestingHooks["preflightDiscordMessage"]
>;
type ProcessDiscordMessageHook = NonNullable<
  DiscordInboundWorkerTestingHooks["processDiscordMessage"]
>;
type DeliverDiscordReplyHook = NonNullable<DiscordInboundWorkerTestingHooks["deliverDiscordReply"]>;

export function createDiscordMessageHandler(
  ...args: Parameters<typeof createRealDiscordMessageHandler>
) {
  const [params] = args;
  return createRealDiscordMessageHandler({
    ...params,
    __testing: {
      ...params.__testing,
      preflightDiscordMessage: preflightDiscordMessageMock as PreflightDiscordMessageHook,
      processDiscordMessage: processDiscordMessageMock as ProcessDiscordMessageHook,
      deliverDiscordReply: deliverDiscordReplyMock as DeliverDiscordReplyHook,
    },
  });
}
