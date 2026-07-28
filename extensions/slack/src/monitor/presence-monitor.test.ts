import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import { createSlackPresenceMonitor, hasSlackPresenceEventsEnabled } from "./presence-monitor.js";

const AUTO_MAX_PARTICIPANTS = 8;

function createCooldownStore(): PluginStateSyncKeyedStore<number> {
  const values = new Map<string, number>();
  return {
    register: (key, value) => void values.set(key, value),
    registerIfAbsent: (key, value) => {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: (key) => values.get(key),
    consume: (key) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () => [],
    clear: () => values.clear(),
  };
}

function createPrepared(params: {
  userId: string;
  channelId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  threadId?: string;
  mode?: "off" | "auto" | "on";
  sessionKey?: string;
}): PreparedSlackMessage {
  const channelId = params.channelId ?? "D123";
  const channelType = params.channelType ?? "im";
  return {
    message: {
      type: "message",
      user: params.userId,
      channel: channelId,
      channel_type: channelType,
    },
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: params.sessionKey ?? `agent:main:slack:channel:${channelId}`,
    },
    channelConfig: params.mode
      ? {
          allowed: true,
          requireMention: false,
          presenceEvents: { mode: params.mode },
        }
      : null,
    ctxPayload: {
      MessageThreadId: params.threadId,
    },
    isDirectMessage: channelType === "im",
  } as PreparedSlackMessage;
}

describe("Slack presence monitor", () => {
  it("stays disabled when presence config is absent or explicitly off", () => {
    expect(hasSlackPresenceEventsEnabled({})).toBe(false);
    expect(hasSlackPresenceEventsEnabled({ account: { mode: "off" } })).toBe(false);
    expect(
      hasSlackPresenceEventsEnabled({
        account: { mode: "off" },
        channels: { C123: { presenceEvents: { mode: "auto" } } },
      }),
    ).toBe(true);
  });

  it("seeds the first sample and wakes only on away-to-active", async () => {
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn(() => true);
    const wake = vi.fn();
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake,
    });
    monitor.observe(createPrepared({ userId: "U123" }));

    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(enqueue).not.toHaveBeenCalled();

    await monitor.pollOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining("retrieve relevant memory and wiki context"),
      expect.objectContaining({
        deliveryContext: {
          channel: "slack",
          to: "user:U123",
          accountId: "default",
        },
      }),
    );
    expect(wake).toHaveBeenCalledOnce();

    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("routes a transition only to the participant's newest eligible thread", async () => {
    let now = 1;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" })
      .mockResolvedValueOnce({ presence: "away" });
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
      nowMs: () => now,
    });
    monitor.observe(
      createPrepared({
        userId: "U123",
        channelId: "COLD",
        channelType: "channel",
        threadId: "1.000",
        sessionKey: "session:old",
      }),
    );
    now = 2;
    monitor.observe(
      createPrepared({
        userId: "U123",
        channelId: "CNEW",
        channelType: "channel",
        threadId: "2.000",
        sessionKey: "session:new",
      }),
    );
    now = 3;
    monitor.observe(
      createPrepared({
        userId: "UOTHER",
        channelId: "COLD",
        channelType: "channel",
        threadId: "1.000",
        sessionKey: "session:old",
      }),
    );

    await monitor.pollOnce();
    await monitor.pollOnce();

    expect(enqueue).toHaveBeenCalledWith(
      expect.stringContaining('channel_id="CNEW"'),
      expect.objectContaining({
        sessionKey: "session:new",
        deliveryContext: expect.objectContaining({
          to: "channel:CNEW",
          threadId: "2.000",
        }),
      }),
    );
  });

  it("auto excludes top-level channels and threads larger than eight people", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
    });
    monitor.observe(createPrepared({ userId: "UTOP", channelId: "C1", channelType: "channel" }));
    for (let index = 0; index <= AUTO_MAX_PARTICIPANTS; index += 1) {
      monitor.observe(
        createPrepared({
          userId: `U${index}`,
          channelId: "C2",
          channelType: "channel",
          threadId: "2.000",
        }),
      );
    }

    await monitor.pollOnce();

    expect(getPresence).not.toHaveBeenCalled();
  });

  it("does not let excluded auto channels evict an eligible direct message", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
    });
    monitor.observe(createPrepared({ userId: "UDIRECT" }));
    for (let index = 0; index < 2_001; index += 1) {
      monitor.observe(
        createPrepared({
          userId: `UTOP${index}`,
          channelId: `C${index}`,
          channelType: "channel",
        }),
      );
    }

    await monitor.pollOnce();

    expect(getPresence).toHaveBeenCalledExactlyOnceWith({ user: "UDIRECT" });
  });

  it("on includes top-level channels and overrides the auto size cap", async () => {
    const getPresence = vi.fn().mockResolvedValue({ presence: "away" });
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue: vi.fn(() => true),
      wake: vi.fn(),
    });
    monitor.observe(
      createPrepared({
        userId: "UTOP",
        channelId: "C1",
        channelType: "channel",
        mode: "on",
      }),
    );
    for (let index = 0; index <= AUTO_MAX_PARTICIPANTS; index += 1) {
      monitor.observe(
        createPrepared({
          userId: `U${index}`,
          channelId: "C2",
          channelType: "channel",
          threadId: "2.000",
          mode: index === AUTO_MAX_PARTICIPANTS ? "on" : "auto",
        }),
      );
    }

    await monitor.pollOnce();

    expect(getPresence).toHaveBeenCalledTimes(AUTO_MAX_PARTICIPANTS + 2);
  });

  it("seeds again after all eligible targets expire", async () => {
    let now = 1;
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockResolvedValueOnce({ presence: "active" });
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
      nowMs: () => now,
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();

    now += 24 * 60 * 60 * 1000;
    await monitor.pollOnce();
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();

    expect(getPresence).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("quiesces an in-flight poll before stop returns", async () => {
    let resolveActive!: (value: { presence: string }) => void;
    const active = new Promise<{ presence: string }>((resolve) => {
      resolveActive = resolve;
    });
    const getPresence = vi
      .fn()
      .mockResolvedValueOnce({ presence: "away" })
      .mockReturnValueOnce(active);
    const enqueue = vi.fn(() => true);
    const monitor = createSlackPresenceMonitor({
      accountId: "default",
      accountConfig: { mode: "auto" },
      client: { getPresence } as never,
      cooldownStore: createCooldownStore(),
      enqueue,
      wake: vi.fn(),
    });
    monitor.observe(createPrepared({ userId: "U123" }));
    await monitor.pollOnce();

    const polling = monitor.pollOnce();
    const stopping = monitor.stop();
    resolveActive({ presence: "active" });
    await Promise.all([polling, stopping]);

    expect(enqueue).not.toHaveBeenCalled();
  });
});
