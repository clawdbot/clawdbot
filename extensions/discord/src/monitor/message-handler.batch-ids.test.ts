import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Discord tests cover debounced batch message ids at the dispatcher boundary.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscordMessageHandler,
  preflightDiscordMessageMock,
  processDiscordMessageMock,
} from "./message-handler.module-test-helpers.js";
import {
  createDiscordHandlerParams,
  createDiscordPreflightContext,
} from "./message-handler.test-helpers.js";

function createTextMessageData(messageId: string, channelId = "ch-1") {
  return {
    channel_id: channelId,
    author: { id: "user-1" },
    message: {
      id: messageId,
      author: { id: "user-1", bot: false },
      content: "hello",
      channel_id: channelId,
      attachments: [],
    },
  };
}

function createIngressLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: vi.fn(async () => {}),
    onDeferred: vi.fn(),
    onAdoptionFinalizing: vi.fn(),
    onFailed: vi.fn(async () => {}),
    onCancelled: vi.fn(async () => {}),
    onAbandoned: vi.fn(async () => {}),
  };
}

describe("discord debounced batch message ids", () => {
  it("carries every debounced Discord source id into the merged turn context", async () => {
    preflightDiscordMessageMock.mockReset();
    processDiscordMessageMock.mockReset();
    const params = createDiscordHandlerParams();
    params.cfg.messages = { inbound: { debounceMs: 20 } };
    preflightDiscordMessageMock.mockImplementation(
      async (preflightParams: { data: { channel_id: string }; cfg: OpenClawConfig }) => ({
        ...createDiscordPreflightContext(preflightParams.data.channel_id),
        cfg: preflightParams.cfg,
      }),
    );
    const processed = createDeferred();
    processDiscordMessageMock.mockImplementation(async () => {
      processed.resolve();
    });
    const handler = createDiscordMessageHandler(params);

    await expect(
      handler(createTextMessageData("m-batch-1") as never, {} as never, {
        turnAdoptionLifecycle: createIngressLifecycle(),
      }),
    ).resolves.toEqual({ kind: "deferred" });
    await expect(
      handler(createTextMessageData("m-batch-2") as never, {} as never, {
        turnAdoptionLifecycle: createIngressLifecycle(),
      }),
    ).resolves.toEqual({ kind: "deferred" });

    await processed.promise;
    expect(processDiscordMessageMock).toHaveBeenCalledTimes(1);
    expect(processDiscordMessageMock.mock.calls[0]?.[0]).toMatchObject({
      batchMessageIds: ["m-batch-1", "m-batch-2"],
    });
  });
});
