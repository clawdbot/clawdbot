import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import type { DiscordMessageRunQueueTestingHooks } from "./message-run-queue.js";

export const preflightDiscordMessageMock: MockFn = vi.fn();
export const processDiscordMessageMock: MockFn = vi.fn();

const { createDiscordMessageHandler: createRealDiscordMessageHandler } =
  await import("./message-handler.js");
type DiscordMessageHandlerParams = Parameters<typeof createRealDiscordMessageHandler>[0];
type DiscordMessageHandlerTestingHooks = NonNullable<DiscordMessageHandlerParams["__testing"]>;
type PreflightDiscordMessageHook = NonNullable<
  DiscordMessageHandlerTestingHooks["preflightDiscordMessage"]
>;
type ProcessDiscordMessageHook = NonNullable<
  DiscordMessageRunQueueTestingHooks["processDiscordMessage"]
>;

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
    },
  });
}
