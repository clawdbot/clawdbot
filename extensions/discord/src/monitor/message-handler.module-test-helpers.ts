// Discord helper module supports message handler.module test helpers behavior.
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { createDiscordMessageDispatcher as createRealDiscordMessageHandler } from "./message-dispatcher.js";
import type { DiscordMessageRunQueueTestingHooks } from "./message-run-queue.js";

export const preflightDiscordMessageMock: MockFn = vi.fn();
export const processDiscordMessageMock: MockFn = vi.fn();

type DiscordMessageHandlerParams = Parameters<typeof createRealDiscordMessageHandler>[0];
type DiscordMessageHandlerTestingHooks = NonNullable<DiscordMessageHandlerParams["testing"]>;
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
    testing: {
      ...params.testing,
      preflightDiscordMessage: preflightDiscordMessageMock as PreflightDiscordMessageHook,
      processDiscordMessage: processDiscordMessageMock as ProcessDiscordMessageHook,
    },
  });
}
