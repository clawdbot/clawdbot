import { ChannelType, type GatewayThreadDeleteDispatchData } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleMocks = vi.hoisted(() => {
  const unbindThread = vi.fn();
  return {
    closeDiscordThreadSessions: vi.fn(async () => 1),
    getThreadBindingManager: vi.fn<() => { unbindThread: typeof unbindThread } | null>(() => ({
      unbindThread,
    })),
    unbindThread,
  };
});

vi.mock("./thread-session-close.js", () => ({
  closeDiscordThreadSessions: lifecycleMocks.closeDiscordThreadSessions,
}));

vi.mock("./thread-bindings.manager.js", () => ({
  getThreadBindingManager: lifecycleMocks.getThreadBindingManager,
}));

async function createThreadDeleteListener() {
  const listeners = await import("./listeners.js");
  expect(listeners).toHaveProperty("DiscordThreadDeleteListener");
  const Listener = (
    listeners as unknown as {
      DiscordThreadDeleteListener: new (
        cfg: OpenClawConfig,
        accountId: string,
        logger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
      ) => { handle: (event: GatewayThreadDeleteDispatchData) => Promise<void> };
    }
  ).DiscordThreadDeleteListener;
  const cfg = {} as OpenClawConfig;
  const logger = { info: vi.fn(), error: vi.fn() };
  const listener = new Listener(cfg, "account-2", logger);
  const deletedThread: GatewayThreadDeleteDispatchData = {
    id: "thread-42",
    guild_id: "guild-1",
    parent_id: "channel-1",
    type: ChannelType.PublicThread,
  };
  return { cfg, deletedThread, listener, logger };
}

describe("DiscordThreadDeleteListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("immediately unbinds deleted threads and archives their sessions without a farewell", async () => {
    const { cfg, deletedThread, listener, logger } = await createThreadDeleteListener();

    await listener.handle(deletedThread);

    expect(lifecycleMocks.getThreadBindingManager).toHaveBeenCalledWith("account-2");
    expect(lifecycleMocks.unbindThread).toHaveBeenCalledWith({
      threadId: "thread-42",
      reason: "thread-delete",
      sendFarewell: false,
    });
    expect(lifecycleMocks.closeDiscordThreadSessions).toHaveBeenCalledWith({
      cfg,
      threadId: "thread-42",
    });
    expect(logger.info).toHaveBeenCalledWith("Discord thread deleted — reset sessions", {
      threadId: "thread-42",
      count: 1,
    });
  });

  it("archives deleted-thread sessions when no account binding manager exists", async () => {
    lifecycleMocks.getThreadBindingManager.mockReturnValueOnce(null);
    const { cfg, deletedThread, listener } = await createThreadDeleteListener();

    await listener.handle(deletedThread);

    expect(lifecycleMocks.unbindThread).not.toHaveBeenCalled();
    expect(lifecycleMocks.closeDiscordThreadSessions).toHaveBeenCalledWith({
      cfg,
      threadId: "thread-42",
    });
  });

  it("reports session-close failures without claiming deleted-thread cleanup succeeded", async () => {
    lifecycleMocks.closeDiscordThreadSessions.mockRejectedValueOnce(
      new Error("session close failed"),
    );
    const { deletedThread, listener, logger } = await createThreadDeleteListener();

    await expect(listener.handle(deletedThread)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("discord thread-delete handler failed"),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
