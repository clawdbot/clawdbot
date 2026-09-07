import { ChannelType, type GatewayThreadUpdateDispatchData } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../internal/discord.js";

const lifecycleMocks = vi.hoisted(() => ({
  closeDiscordThreadSessions: vi.fn(async () => 1),
}));

vi.mock("./thread-session-close.js", () => ({
  closeDiscordThreadSessions: lifecycleMocks.closeDiscordThreadSessions,
}));

import { DiscordThreadReadyListener, DiscordThreadUpdateListener } from "./listeners.js";

function createThreadUpdate(
  archived: boolean,
  overrides: Partial<GatewayThreadUpdateDispatchData> = {},
): GatewayThreadUpdateDispatchData {
  return {
    id: "thread-42",
    type: ChannelType.PublicThread,
    guild_id: "guild-1",
    parent_id: "channel-1",
    owner_id: "user-1",
    name: "support thread",
    last_message_id: null,
    rate_limit_per_user: 0,
    thread_metadata: {
      archived,
      auto_archive_duration: 60,
      archive_timestamp: "2026-08-09T00:00:00.000Z",
      locked: false,
    },
    message_count: 0,
    member_count: 1,
    total_message_sent: 0,
    ...overrides,
  };
}

function createHarness(
  put: Mock<() => Promise<void>> = vi.fn<() => Promise<void>>(async () => undefined),
) {
  const cfg = {} as OpenClawConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = { rest: { put } } as unknown as Client;
  const listener = new DiscordThreadUpdateListener(cfg, logger as never);
  const readyListener = new DiscordThreadReadyListener(listener);
  return { cfg, client, listener, logger, put, readyListener };
}

describe("DiscordThreadUpdateListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.closeDiscordThreadSessions.mockResolvedValue(1);
  });

  it("rejoins an active thread only once for ordinary updates in a gateway session", async () => {
    const { client, listener, put } = createHarness();

    await listener.handle(createThreadUpdate(false), client);
    await listener.handle(createThreadUpdate(false, { name: "renamed thread" }), client);

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("/channels/thread-42/thread-members/@me");
    expect(lifecycleMocks.closeDiscordThreadSessions).not.toHaveBeenCalled();
  });

  it("claims a thread before REST so concurrent updates share one rejoin", async () => {
    let resolvePut: (() => void) | undefined;
    const put = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((resolve) => {
          resolvePut = resolve;
        }),
    );
    const { client, listener } = createHarness(put);

    const first = listener.handle(createThreadUpdate(false), client);
    const second = listener.handle(createThreadUpdate(false, { name: "renamed thread" }), client);

    expect(put).toHaveBeenCalledTimes(1);
    resolvePut?.();
    await Promise.all([first, second]);
  });

  it("opens a new rejoin lifecycle when the thread is archived", async () => {
    const { cfg, client, listener, put } = createHarness();

    await listener.handle(createThreadUpdate(false), client);
    await listener.handle(createThreadUpdate(true), client);
    await listener.handle(createThreadUpdate(false), client);

    expect(put).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.closeDiscordThreadSessions).toHaveBeenCalledWith({
      cfg,
      threadId: "thread-42",
    });
  });

  it("retries after a failed rejoin", async () => {
    const put = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("join failed"))
      .mockResolvedValue(undefined);
    const { client, listener, logger } = createHarness(put);

    await listener.handle(createThreadUpdate(false), client);
    await listener.handle(createThreadUpdate(false), client);

    expect(put).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("join failed"), {
      threadId: "thread-42",
    });
  });

  it("rejoins again after a fresh READY gateway session", async () => {
    const { client, listener, put, readyListener } = createHarness();

    await listener.handle(createThreadUpdate(false), client);
    readyListener.handle();
    await listener.handle(createThreadUpdate(false), client);

    expect(put).toHaveBeenCalledTimes(2);
  });

  it("does not let an old failed request clear a newer gateway-session claim", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const put = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const { client, listener, readyListener } = createHarness(put);

    const oldSessionRequest = listener.handle(createThreadUpdate(false), client);
    readyListener.handle();
    await listener.handle(createThreadUpdate(false), client);
    rejectFirst?.(new Error("old session failed"));
    await oldSessionRequest;
    await listener.handle(createThreadUpdate(false), client);

    expect(put).toHaveBeenCalledTimes(2);
  });
});
