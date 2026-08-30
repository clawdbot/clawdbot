// Tests reply-to threading mode resolution across global and plugin config.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createReplyToModeFilterForChannel,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";

const emptyCfg = {} as OpenClawConfig;

describe("resolveReplyToMode", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("falls back to configured channel defaults when channel threading plugins are unavailable", () => {
    const configuredCfg = {
      channels: {
        telegram: { replyToMode: "all" },
        discord: { replyToMode: "first" },
        slack: { replyToMode: "all" },
      },
    } as OpenClawConfig;
    const chatTypeCfg = {
      channels: {
        slack: {
          replyToMode: "off",
          replyToModeByChatType: { direct: "all", group: "first" },
        },
      },
    } as OpenClawConfig;
    const topLevelFallbackCfg = {
      channels: {
        slack: {
          replyToMode: "first",
        },
      },
    } as OpenClawConfig;
    const cases: Array<{
      cfg: OpenClawConfig;
      channel?: "telegram" | "discord" | "slack";
      chatType?: "direct" | "group" | "channel";
      expected: "off" | "all" | "first";
    }> = [
      { cfg: emptyCfg, channel: "telegram", expected: "all" },
      { cfg: emptyCfg, channel: "discord", expected: "all" },
      { cfg: emptyCfg, channel: "slack", expected: "all" },
      { cfg: emptyCfg, channel: undefined, expected: "all" },
      { cfg: configuredCfg, channel: "telegram", expected: "all" },
      { cfg: configuredCfg, channel: "discord", expected: "first" },
      { cfg: configuredCfg, channel: "slack", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "direct", expected: "all" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "group", expected: "first" },
      { cfg: chatTypeCfg, channel: "slack", chatType: "channel", expected: "off" },
      { cfg: chatTypeCfg, channel: "slack", chatType: undefined, expected: "off" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "direct", expected: "first" },
      { cfg: topLevelFallbackCfg, channel: "slack", chatType: "channel", expected: "first" },
    ];
    for (const testCase of cases) {
      expect(resolveReplyToMode(testCase.cfg, testCase.channel, null, testCase.chatType)).toBe(
        testCase.expected,
      );
    }
  });

  it("uses registered channel threading adapters for runtime reply-mode resolution", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            id: "whatsapp",
            meta: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp",
              docsPath: "/channels/whatsapp",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
            threading: {
              resolveReplyToMode: ({ accountId }: { accountId?: string | null }) =>
                accountId === "work" ? "first" : "all",
            },
          },
        },
      ]),
    );

    expect(resolveReplyToMode({} as OpenClawConfig, "whatsapp", "work", "group")).toBe("first");
    expect(resolveReplyToMode({} as OpenClawConfig, "whatsapp", "default", "group")).toBe("all");
  });

  it("resolves the same listed default account used by routed delivery", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            id: "whatsapp",
            meta: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp",
              docsPath: "/channels/whatsapp",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
              listAccountIds: () => ["work"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );

    expect(resolveReplyDeliveryAccountId(emptyCfg, "whatsapp")).toBe("work");
    expect(resolveReplyDeliveryAccountId(emptyCfg, "whatsapp", "personal")).toBe("personal");
  });

  it("applies canonical account policy before channel-wide threading defaults", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "irc", source: "test", plugin: createChannelTestPluginBase({ id: "irc" }) },
      ]),
    );
    const cfg: OpenClawConfig = {
      channels: {
        irc: {
          replyToMode: "off",
          accounts: {
            "Ops Team": { replyToMode: "all" },
            support: { replyToMode: "first" },
          },
        },
      },
    };

    expect(resolveReplyToMode(cfg, "irc", "ops-team", "group")).toBe("all");
    expect(resolveReplyToMode(cfg, "irc", "OPS TEAM", "direct")).toBe("all");
    expect(resolveReplyToMode(cfg, "irc", "support", "group")).toBe("first");
    expect(resolveReplyToMode(cfg, "irc", "unknown", "group")).toBe("off");
    expect(resolveReplyToMode(cfg, "irc", null, "direct")).toBe("off");
  });
});

describe("createReplyToModeFilterForChannel", () => {
  beforeEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each(["first", "batched"] as const)(
    "previews the %s transport without consuming its single reply slot",
    (mode) => {
      const filter = createReplyToModeFilterForChannel(mode, "discord");
      const first = { text: "discarded", replyToId: "parent" };
      const actual = { text: "actual", replyToId: "parent" };

      expect(filter.preview(first).replyToId).toBe("parent");
      expect(filter(actual).replyToId).toBe("parent");
      expect(filter.preview({ text: "later", replyToId: "other" }).replyToId).toBeUndefined();
    },
  );

  it("strips explicit Slack reply tags upstream when replyToMode is off", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            threading: { allowExplicitReplyTagsWhenOff: false },
          },
        },
      ]),
    );

    const filter = createReplyToModeFilterForChannel("off", "slack");

    expect(filter({ text: "hello", replyToId: "message-1", replyToTag: true }).replyToId).toBe(
      undefined,
    );
  });

  it("keeps other known-channel defaults and fails closed without a channel", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createChannelTestPluginBase({ id: "telegram" }),
        },
      ]),
    );
    const explicitReply = { text: "hello", replyToId: "message-1", replyToTag: true };

    expect(createReplyToModeFilterForChannel("off", "telegram")(explicitReply).replyToId).toBe(
      "message-1",
    );
    expect(createReplyToModeFilterForChannel("off")(explicitReply).replyToId).toBeUndefined();
  });

  it("allows explicit tags for named channels without a loaded plugin", () => {
    // The filter also runs where plugins are not loaded; stripping for unrecognized
    // ids would break real channels there. Accepted tradeoff pinned on purpose.
    setActivePluginRegistry(createTestRegistry([]));
    const explicitReply = { text: "hello", replyToId: "message-1", replyToTag: true };

    expect(
      createReplyToModeFilterForChannel("off", "unloaded-channel")(explicitReply).replyToId,
    ).toBe("message-1");
  });

  it("honors the deprecated allowTagsWhenOff adapter alias", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "legacy-threading",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "legacy-threading" }),
            threading: { allowTagsWhenOff: false },
          },
        },
      ]),
    );

    const filter = createReplyToModeFilterForChannel("off", "legacy-threading");

    expect(filter({ text: "hello", replyToId: "message-1", replyToTag: true }).replyToId).toBe(
      undefined,
    );
  });
});
