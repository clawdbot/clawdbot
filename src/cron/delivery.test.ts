// Cron delivery tests cover delivery execution and status recording.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery-plan.js";
import { makeCronJob } from "./delivery.test-helpers.js";

function createPrefixOnlyChannelPlugin(
  id: string,
  targetPrefixes?: readonly string[],
  aliases?: readonly string[],
): ChannelPlugin {
  const plugin = createChannelTestPluginBase({ id });
  return {
    ...plugin,
    ...(aliases ? { meta: { ...plugin.meta, aliases: [...aliases] } } : {}),
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
      {
        pluginId: "googlechat",
        plugin: createPrefixOnlyChannelPlugin(
          "googlechat",
          ["googlechat", "gchat", "google-chat"],
          ["gchat", "google-chat"],
        ),
      },
    ]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("defaults to announce when delivery object has no mode", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: { channel: "telegram", to: "123", mode: undefined as never },
    });
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
  });

  it.each(["googlechat", "gchat", "google-chat"])(
    "canonicalizes the registered %s primary delivery channel",
    (channel) => {
      const plan = resolveCronDeliveryPlan({
        delivery: { mode: "announce", channel, to: "RoomA" },
      });

      expect(plan.channel).toBe("googlechat");
      expect(plan.to).toBe("RoomA");
    },
  );

  it("preserves external plugin channels before their registry is available", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: { mode: "announce", channel: "external-plugin", to: "room-1" },
    });

    expect(plan.channel).toBe("external-plugin");
  });

  it.each(["isolated", "current", "session:project-alpha"] as const)(
    "defaults missing %s agentTurn delivery to announce",
    (sessionTarget) => {
      const plan = resolveCronDeliveryPlan({
        delivery: undefined,
        payload: { kind: "agentTurn", message: "hello" },
        sessionTarget,
      });
      expect(plan.mode).toBe("announce");
      expect(plan.requested).toBe(true);
      expect(plan.channel).toBe("last");
    },
  );

  it("resolves mode=none with requested=false and no channel (#21808)", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: { mode: "none", to: "telegram:123" },
    });
    expect(plan.mode).toBe("none");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("telegram:123");
  });

  it("resolves webhook mode without channel routing", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
    });
    expect(plan.mode).toBe("webhook");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("https://example.invalid/cron");
  });

  it("threads delivery.accountId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        accountId: " bot-a ",
      },
    });
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
    expect(plan.accountId).toBe("bot-a");
  });

  it("threads delivery.threadId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: "99",
      },
    });
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("-1001234567890");
    expect(plan.threadId).toBe("99");
  });

  it("uses a provider-prefixed announce target as the channel when channel is last", () => {
    const plan = resolveCronDeliveryPlan({
      delivery: {
        mode: "announce",
        channel: "last",
        to: "telegram:123",
      },
    });
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
      const plan = resolveCronDeliveryPlan({
        delivery: {
          mode: "announce",
          channel: "last",
          to,
        },
      });
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

    const plan = resolveCronDeliveryPlan({
      delivery: {
        mode: "announce",
        channel: "last",
        to: "imessage:+15551234567",
      },
    });
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
      {
        pluginId: "googlechat",
        plugin: createPrefixOnlyChannelPlugin(
          "googlechat",
          ["googlechat", "gchat", "google-chat"],
          ["gchat", "google-chat"],
        ),
      },
      {
        pluginId: "msteams",
        plugin: createPrefixOnlyChannelPlugin("msteams", ["msteams", "teams"], ["teams"]),
      },
    ]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("merges global defaults with job-level overrides", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: { channel: "signal", mode: "announce" },
        },
      },
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
      to: undefined,
      accountId: undefined,
    });
  });

  it("preserves global targets and accounts for same-channel failure overrides", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "slack", mode: "announce" },
        },
      },
      {
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
        mode: "announce",
      },
    );

    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: "slack:cron-alerts",
      accountId: "slack-bot",
    });
  });

  for (const { channelId, aliases } of [
    { channelId: "googlechat", aliases: ["googlechat", "gchat", "google-chat"] },
    { channelId: "msteams", aliases: ["msteams", "teams"] },
  ]) {
    it.each(
      aliases.flatMap((globalChannel) =>
        aliases.flatMap((channel) =>
          ["failure destination", "job alert"].map((override) => ({
            globalChannel,
            channel,
            override,
          })),
        ),
      ),
    )(
      `preserves ${channelId} failure routing from $globalChannel through $channel $override`,
      ({ globalChannel, channel, override }) => {
        expect(
          resolveFailureDestination(
            {
              delivery: {
                mode: "none",
                ...(override === "failure destination" ? { failureDestination: { channel } } : {}),
              },
            },
            {
              channel: globalChannel,
              to: `${channelId}:alerts`,
              accountId: `${channelId}-bot`,
              mode: "announce",
            },
            override === "job alert" ? { channel } : undefined,
          ),
        ).toEqual({
          mode: "announce",
          channel: channelId,
          to: `${channelId}:alerts`,
          accountId: `${channelId}-bot`,
        });
      },
    );
  }

  it.each([
    {
      name: "job alert override",
      failureDestination: undefined,
      jobAlertRoute: { channel: "gchat" },
      globalChannel: "googlechat",
    },
    {
      name: "both independently aliased overrides",
      failureDestination: { channel: "gchat" },
      jobAlertRoute: { channel: "google-chat" },
      globalChannel: "googlechat",
    },
    {
      name: "last channel selected by the inherited recipient",
      failureDestination: { channel: "gchat" },
      jobAlertRoute: undefined,
      globalChannel: "last",
      globalTo: "gchat:alerts",
    },
  ])("preserves the inherited account and recipient for $name", (testCase) => {
    const globalTo = "globalTo" in testCase ? testCase.globalTo : "googlechat:alerts";
    expect(
      resolveFailureDestination(
        {
          delivery: {
            mode: "none",
            ...(testCase.failureDestination
              ? { failureDestination: testCase.failureDestination }
              : {}),
          },
        },
        {
          channel: testCase.globalChannel,
          to: globalTo,
          accountId: "googlechat-bot",
          mode: "announce",
        },
        testCase.jobAlertRoute,
      ),
    ).toEqual({
      mode: "announce",
      channel: "googlechat",
      to: globalTo,
      accountId: "googlechat-bot",
    });
  });

  it("does not reuse inherited ownership for a different provider's channel alias", () => {
    expect(
      resolveFailureDestination(
        {
          delivery: { mode: "none", failureDestination: { channel: "teams" } },
        },
        {
          channel: "gchat",
          to: "googlechat:alerts",
          accountId: "googlechat-bot",
          mode: "announce",
        },
      ),
    ).toEqual({
      mode: "announce",
      channel: "msteams",
      to: undefined,
      accountId: undefined,
    });
  });

  it("does not reuse a global recipient or account across failure channels", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "telegram" },
        },
      },
      {
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
        mode: "announce",
      },
    );

    expect(plan).toEqual({
      mode: "announce",
      channel: "telegram",
      to: undefined,
      accountId: undefined,
    });
  });

  it("does not reuse a channel-specific recipient or account for the last failure channel", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "last" },
        },
      },
      {
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
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

  it("preserves an explicitly overridden recipient and account on a different failure channel", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: {
            channel: "telegram",
            to: "telegram:123",
            accountId: "telegram-bot",
          },
        },
      },
      {
        channel: "slack",
        to: "slack:cron-alerts",
        accountId: "slack-bot",
        mode: "announce",
      },
    );

    expect(plan).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "telegram:123",
      accountId: "telegram-bot",
    });
  });

  it("resolves a channel-shaped job override without mode to announce despite a global webhook default (#102235)", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "slack", to: "#alerts" },
        },
      },
      { mode: "webhook", to: "https://hook.example/cron" },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: "#alerts",
      accountId: undefined,
    });
  });

  it("clears an inherited global webhook URL when a channel-only override implies announce (#102235)", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { channel: "slack" },
        },
      },
      { mode: "webhook", to: "https://hook.example/cron" },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: undefined,
      accountId: undefined,
    });
  });

  it("keeps inheriting a global webhook mode for a to-only override without channel or mode", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "none",
          failureDestination: { to: "https://other.example/hook" },
        },
      },
      { mode: "webhook", to: "https://hook.example/cron" },
    );
    expect(plan).toEqual({
      mode: "webhook",
      channel: undefined,
      to: "https://other.example/hook",
      accountId: undefined,
    });
  });

  it.each([
    {
      name: "explicit announce mode",
      failureDestination: { mode: "announce" as const },
      globalConfig: undefined,
      expected: { mode: "announce", channel: "last", to: undefined, accountId: undefined },
    },
    {
      name: "webhook mode without a URL",
      failureDestination: { mode: "webhook" as const },
      globalConfig: undefined,
      expected: null,
    },
    {
      name: "clear-only override",
      failureDestination: {
        channel: undefined as never,
        to: undefined as never,
        accountId: undefined as never,
        mode: undefined as never,
      },
      globalConfig: {
        channel: "signal",
        to: "group-abc",
        accountId: "global-account",
        mode: "announce" as const,
      },
      expected: null,
    },
    {
      name: "JSON-null clear-only override",
      failureDestination: {
        channel: null as never,
        to: null as never,
        accountId: null as never,
        mode: null as never,
      },
      globalConfig: {
        channel: "telegram",
        to: "group-abc",
        accountId: "global-account",
        mode: "announce" as const,
      },
      expected: null,
    },
  ])("resolves $name", ({ failureDestination, globalConfig, expected }) => {
    expect(
      resolveFailureDestination({ delivery: { mode: "none", failureDestination } }, globalConfig),
    ).toEqual(expected);
  });

  it("returns null when failure destination matches primary delivery target", () => {
    const plan = resolveFailureDestination(
      {
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
      },
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("keeps a failure destination matching a threaded primary chat without that thread", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
          threadId: 42,
          accountId: "bot-a",
          failureDestination: {
            mode: "announce",
            channel: "telegram",
            to: "-1001234567890",
            accountId: "bot-a",
          },
        },
      },
      undefined,
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      accountId: "bot-a",
    });
  });

  it("returns null when provider-prefixed failure destination matches a provider-prefixed primary target", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "last",
          to: "telegram:123",
          failureDestination: {
            mode: "announce",
            to: "telegram:123",
          },
        },
      },
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
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "webhook",
          },
        },
      },
      {
        channel: "signal",
        to: "group-abc",
        mode: "announce",
      },
    );
    expect(plan).toBeNull();
  });

  it("keeps inherited announce targets when a job clears only failure destination mode", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: undefined,
          },
        },
      },
      {
        channel: "signal",
        to: "group-abc",
        accountId: "global-account",
        mode: "announce",
      },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "signal",
      to: "group-abc",
      accountId: "global-account",
    });
  });

  it("uses a provider-prefixed failure destination as the announce channel", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "announce",
            to: "slack:U123",
          },
        },
      },
      undefined,
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: "slack:U123",
      accountId: undefined,
    });
  });

  it("does not inherit a foreign global account for a prefixed failure destination", () => {
    const plan = resolveFailureDestination(
      {
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "announce",
            to: "slack:U123",
          },
        },
      },
      {
        mode: "announce",
        channel: "telegram",
        to: "telegram:alerts",
        accountId: "telegram-bot",
      },
    );

    expect(plan).toEqual({
      mode: "announce",
      channel: "slack",
      to: "slack:U123",
      accountId: undefined,
    });
  });
});
