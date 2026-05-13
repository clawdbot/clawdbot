import { describe, expect, it, vi } from "vitest";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const inboundClaimEvent = {
  content: "who are you",
  channel: "guildchat",
  accountId: "default",
  conversationId: "channel:1",
  isGroup: true,
};

const inboundClaimCtx = {
  channelId: "guildchat",
  accountId: "default",
  conversationId: "channel:1",
};

function createInboundClaimForumEvent() {
  return {
    content: "who are you",
    channel: "forum",
    accountId: "default",
    conversationId: "123:topic:77",
    isGroup: true,
  };
}

function createInboundClaimForumCtx() {
  return {
    channelId: "forum",
    accountId: "default",
    conversationId: "123:topic:77",
  };
}

function expectFirstErrorLog(
  logger: { error: ReturnType<typeof vi.fn> },
  expected: readonly unknown[],
): void {
  expect(logger.error).toHaveBeenCalledTimes(1);
  const call = logger.error.mock.calls[0];
  if (!call) {
    throw new Error("expected logger.error call");
  }
  expect(call).toEqual(expected);
}

describe("inbound_claim hook runner", () => {
  it("stops at the first handler that claims the event", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "inbound_claim", handler: first },
      { hookName: "inbound_claim", handler: second },
    ]);

    const result = await runner.runInboundClaim(
      createInboundClaimForumEvent(),
      createInboundClaimForumCtx(),
    );

    expect(result).toEqual({ handled: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("continues to the next handler when a higher-priority handler throws", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "inbound_claim", handler: failing },
        { hookName: "inbound_claim", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runInboundClaim(
      {
        ...createInboundClaimForumEvent(),
        content: "hi",
        conversationId: "123",
        isGroup: false,
      },
      {
        ...createInboundClaimForumCtx(),
        conversationId: "123",
      },
    );

    expect(result).toEqual({ handled: true });
    expectFirstErrorLog(logger, ["[hooks] inbound_claim handler from test-plugin failed: boom"]);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("can target a single plugin when core already owns the binding", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { registry, runner } = createHookRunnerWithRegistry([
      { hookName: "inbound_claim", handler: first },
      { hookName: "inbound_claim", handler: second },
    ]);
    registry.typedHooks[1].pluginId = "other-plugin";

    const result = await runner.runInboundClaimForPlugin(
      "test-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ handled: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("can target a loaded non-default plugin without mutating the helper registry", async () => {
    const first = vi.fn().mockResolvedValue({ handled: true });
    const second = vi.fn().mockResolvedValue({ handled: true });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "inbound_claim", handler: first, pluginId: "alpha-plugin" },
      { hookName: "inbound_claim", handler: second, pluginId: "beta-plugin" },
    ]);

    const result = await runner.runInboundClaimForPlugin(
      "beta-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ handled: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("reports missing_plugin when the bound plugin is not loaded", async () => {
    const { registry, runner } = createHookRunnerWithRegistry([]);
    registry.plugins = [];

    const result = await runner.runInboundClaimForPluginOutcome(
      "missing-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ status: "missing_plugin" });
  });

  it("reports no_handler when the plugin is loaded but has no targeted hooks", async () => {
    const { runner } = createHookRunnerWithRegistry([]);

    const result = await runner.runInboundClaimForPluginOutcome(
      "test-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ status: "no_handler" });
  });

  it("reports error when a targeted handler throws and none claim the event", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const { runner } = createHookRunnerWithRegistry(
      [{ hookName: "inbound_claim", handler: failing }],
      { logger },
    );

    const result = await runner.runInboundClaimForPluginOutcome(
      "test-plugin",
      inboundClaimEvent,
      inboundClaimCtx,
    );

    expect(result).toEqual({ status: "error", error: "boom" });
  });

  it("reports targeted per-hook registration timeouts as handler errors", async () => {
    vi.useFakeTimers();
    try {
      const logger = {
        warn: vi.fn(),
        error: vi.fn(),
      };
      const slow = vi.fn(() => new Promise(() => {}));
      const { registry, runner } = createHookRunnerWithRegistry(
        [{ hookName: "inbound_claim", handler: slow }],
        { logger },
      );
      registry.typedHooks[0].timeoutMs = 5;

      const run = runner.runInboundClaimForPluginOutcome(
        "test-plugin",
        inboundClaimEvent,
        inboundClaimCtx,
      );
      await vi.advanceTimersByTimeAsync(5);

      await expect(run).resolves.toEqual({ status: "error", error: "timed out after 5ms" });
      expectFirstErrorLog(logger, [
        "[hooks] inbound_claim handler from test-plugin failed: timed out after 5ms",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
