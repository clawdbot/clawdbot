import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";

function createPrefixOnlyChannelPlugin(
  id: string,
  targetPrefixes?: readonly string[],
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id }),
    messaging: targetPrefixes ? { targetPrefixes } : {},
  };
}

function setCronDeliveryTestRegistry(
  plugins: Array<{ pluginId: string; plugin: ChannelPlugin }>,
): void {
  setActivePluginRegistry(
    createTestRegistry(
      plugins.map((entry) => ({
        ...entry,
        source: `test:${entry.pluginId}`,
      })),
    ),
  );
}

describe("resolveCronDeliveryPlan", () => {
  beforeEach(() => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "telegram",
        plugin: createPrefixOnlyChannelPlugin("telegram", ["telegram", "tg"]),
      },
      { pluginId: "slack", plugin: createPrefixOnlyChannelPlugin("slack", ["slack"]) },
    ]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("defaults to announce when delivery object has no mode", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: { channel: "telegram", to: "123", mode: undefined as never },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
  });

  it("defaults missing isolated agentTurn delivery to announce", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: undefined,
        payload: { kind: "agentTurn", message: "hello" },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("last");
  });

  it("resolves mode=none with requested=false and no channel (#21808)", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: { mode: "none", to: "telegram:123" },
      }),
    );
    expect(plan.mode).toBe("none");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("telegram:123");
  });

  it("resolves webhook mode without channel routing", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      }),
    );
    expect(plan.mode).toBe("webhook");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("https://example.invalid/cron");
  });

  it("threads delivery.accountId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          accountId: " bot-a ",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
    expect(plan.accountId).toBe("bot-a");
  });

  it("threads delivery.threadId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
          threadId: "99",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("-1001234567890");
    expect(plan.threadId).toBe("99");
  });

  it("uses a provider-prefixed announce target as the channel when channel is last", () => {
    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "last",
          to: "telegram:123",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("telegram:123");
  });

  it("uses Synology Chat provider prefixes with underscores and short spelling", () => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "synology-chat",
        plugin: createPrefixOnlyChannelPlugin("synology-chat", [
          "synology-chat",
          "synology_chat",
          "synology",
        ]),
      },
    ]);

    for (const to of ["synology-chat:123", "synology_chat:123", "synology:123"]) {
      const plan = resolveCronDeliveryPlan(
        makeCronJob({
          delivery: {
            mode: "announce",
            channel: "last",
            to,
          },
        }),
      );
      expect(plan.mode).toBe("announce");
      expect(plan.channel).toBe("synology-chat");
      expect(plan.to).toBe(to);
    }
  });

  it("uses iMessage target prefixes as provider selection", () => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "imessage",
        plugin: createPrefixOnlyChannelPlugin("imessage", ["imessage"]),
      },
      { pluginId: "imessage", plugin: createPrefixOnlyChannelPlugin("imessage") },
    ]);

    const plan = resolveCronDeliveryPlan(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "last",
          to: "imessage:+15551234567",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.channel).toBe("imessage");
    expect(plan.to).toBe("imessage:+15551234567");
  });
});

describe("resolveFailureDestination", () => {
  beforeEach(() => {
    setCronDeliveryTestRegistry([
      {
        pluginId: "telegram",
        plugin: createPrefixOnlyChannelPlugin("telegram", ["telegram", "tg"]),
      },
      { pluginId: "slack", plugin: createPrefixOnlyChannelPlugin("slack", ["slack"]) },
    ]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("merges global defaults with job-level overrides", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: { channel: "signal", mode: "announce" },
        },
      }),
      {
        channel: "telegram",
        to: "222",
        mode: "announce",
        accountId: "global-account",
      },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "signal",
      to: "222",
      accountId: "global-account",
    });
  });

  it("returns null for webhook mode without destination URL", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: { mode: "webhook" },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when failure destination matches primary delivery target", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          accountId: "bot-a",
          failureDestination: {
            mode: "announce",
            channel: "telegram",
            to: "111",
            accountId: "bot-a",
          },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when provider-prefixed failure destination matches a provider-prefixed primary target", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "last",
          to: "telegram:123",
          failureDestination: {
            mode: "announce",
            to: "telegram:123",
          },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when webhook failure destination matches the primary webhook target", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "tick" },
        delivery: {
          mode: "webhook",
          to: "https://example.invalid/cron",
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/cron",
          },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("does not reuse inherited announce recipient when switching failure destination to webhook", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "webhook",
          },
        },
      }),
      {
        channel: "signal",
        to: "group-abc",
        mode: "announce",
      },
    );
    expect(plan).toBeNull();
  });

  it("allows job-level failure destination fields to clear inherited global values", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "announce",
            channel: undefined as never,
            to: undefined as never,
            accountId: undefined as never,
          },
        },
      }),
      {
        channel: "signal",
        to: "group-abc",
        accountId: "global-account",
        mode: "announce",
      },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "last",
      to: undefined,
      accountId: undefined,
    });
  });

  it("uses a provider-prefixed failure destination as the announce channel", () => {
    const plan = resolveFailureDestination(
      makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "announce",
            to: "slack:U123",
          },
        },
      }),
      undefined,
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: "slack:U123",
      accountId: undefined,
    });
  });
});
