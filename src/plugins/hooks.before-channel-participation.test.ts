import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  PluginHookBeforeChannelParticipationContext,
  PluginHookBeforeChannelParticipationEvent,
} from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook, createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const event: PluginHookBeforeChannelParticipationEvent = {
  message: "Can someone help with this?",
  candidates: [
    { accountId: "alpha", agentId: "main", participantId: "a" },
    { accountId: "beta", agentId: "research", participantId: "b" },
  ],
};
const context: PluginHookBeforeChannelParticipationContext = {
  channelId: "test",
  conversationId: "room",
};

afterEach(() => vi.useRealTimers());

describe("before_channel_participation", () => {
  it("does not change activation when no policy is registered", async () => {
    const runner = createHookRunner(createEmptyPluginRegistry());
    expect(runner.hasHooks("before_channel_participation")).toBe(false);
    await expect(runner.runBeforeChannelParticipation(event, context)).resolves.toBeUndefined();
  });

  it("accepts the first claim in priority order and detaches its result", async () => {
    const calls: string[] = [];
    const claim = { accountIds: ["beta"] };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_participation",
          priority: 0,
          handler: () => {
            calls.push("later");
            return { accountIds: ["alpha"] };
          },
        },
        {
          hookName: "before_channel_participation",
          priority: 100,
          handler: () => {
            calls.push("decline");
          },
        },
        {
          hookName: "before_channel_participation",
          priority: 50,
          handler: () => {
            calls.push("claim");
            return claim;
          },
        },
      ]),
    );
    const result = await runner.runBeforeChannelParticipation(event, context);
    claim.accountIds.push("alpha");
    expect(result).toEqual({ accountIds: ["beta"] });
    expect(calls).toEqual(["decline", "claim"]);
  });

  it("isolates each policy from event mutations and protects the conversation context", async () => {
    const registry = createEmptyPluginRegistry();
    const logger = { error: vi.fn(), warn: vi.fn() };
    addTestHook({
      registry,
      pluginId: "mutating",
      hookName: "before_channel_participation",
      priority: 100,
      handler: (
        input: PluginHookBeforeChannelParticipationEvent,
        ctx: PluginHookBeforeChannelParticipationContext,
      ) => {
        input.message = "changed";
        input.candidates[0]!.accountId = "foreign";
        ctx.conversationId = "other-room";
      },
    });
    addTestHook({
      registry,
      pluginId: "healthy",
      hookName: "before_channel_participation",
      handler: (
        input: PluginHookBeforeChannelParticipationEvent,
        ctx: PluginHookBeforeChannelParticipationContext,
      ) => {
        expect(input).toEqual(event);
        expect(ctx).toEqual(context);
        return { accountIds: ["alpha"] };
      },
    });
    await expect(
      createHookRunner(registry, { logger }).runBeforeChannelParticipation(event, context),
    ).resolves.toEqual({ accountIds: ["alpha"] });
    expect(event.candidates[0]!.accountId).toBe("alpha");
    expect(context.conversationId).toBe("room");
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    {},
    { accountIds: [] },
    { accountIds: ["foreign"] },
    { accountIds: ["alpha", "alpha"] },
    { accountIds: [1] },
    { accountIds: Array(1) },
  ])("skips an invalid claim without hiding a later valid policy: %j", async (invalid) => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_channel_participation", priority: 100, handler: () => invalid },
        {
          hookName: "before_channel_participation",
          handler: () => ({ accountIds: ["beta"] }),
        },
      ]),
    );
    await expect(runner.runBeforeChannelParticipation(event, context)).resolves.toEqual({
      accountIds: ["beta"],
    });
  });

  it("preserves ordinary activation when policies fail or decline", async () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_channel_participation",
          handler: () => {
            throw new Error("policy unavailable");
          },
        },
        { hookName: "before_channel_participation", handler: () => undefined },
      ]),
      { logger },
    );
    await expect(runner.runBeforeChannelParticipation(event, context)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("policy unavailable"));
  });

  it("does not start another policy after the decision owner retires", async () => {
    const first = createDeferred<void>();
    const later = vi.fn(() => ({ accountIds: ["beta"] }));
    let current = true;
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_channel_participation", priority: 100, handler: () => first.promise },
        { hookName: "before_channel_participation", handler: later },
      ]),
    );
    const pending = runner.runBeforeChannelParticipation(event, context, {
      isCurrent: () => current,
    });
    current = false;
    first.resolve();
    await expect(pending).rejects.toThrow("Channel participation decision is no longer current");
    expect(later).not.toHaveBeenCalled();
  });

  it("times out a stalled policy and ignores its late claim", async () => {
    vi.useFakeTimers();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const late = createDeferred<{ accountIds: string[] }>();
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "before_channel_participation", priority: 100, handler: () => late.promise },
        {
          hookName: "before_channel_participation",
          handler: () => ({ accountIds: ["beta"] }),
        },
      ]),
      { logger },
    );
    const pending = runner.runBeforeChannelParticipation(event, context);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;
    late.resolve({ accountIds: ["alpha"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ accountIds: ["beta"] });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("timed out after 8000ms"));
  });
});
