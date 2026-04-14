import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  comparableChannelTargetsMatch,
  comparableChannelTargetsShareRoute,
  parseExplicitTargetForChannel,
  parseExplicitTargetForLoadedChannel,
  resolveComparableTargetForChannel,
  resolveComparableTargetForLoadedChannel,
} from "./target-parsing.js";

function parseTelegramTargetForTest(raw: string): {
  to: string;
  threadId?: number;
  chatType?: "direct" | "group";
} {
  const trimmed = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^tg:/i, "");
  const prefixedTopic = /^group:([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (prefixedTopic) {
    return {
      to: prefixedTopic[1],
      threadId: Number.parseInt(prefixedTopic[2], 10),
      chatType: "group",
    };
  }
  const topic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (topic) {
    return {
      to: topic[1],
      threadId: Number.parseInt(topic[2], 10),
      chatType: topic[1].startsWith("-") ? "group" : "direct",
    };
  }
  return {
    to: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : undefined,
  };
}

function setMinimalTargetParsingRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: {
          id: "telegram",
          meta: {
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
            docsPath: "/channels/telegram",
            blurb: "test stub",
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
          },
          messaging: {
            parseExplicitTarget: ({ raw }: { raw: string }) => parseTelegramTargetForTest(raw),
          },
        },
        source: "test",
      },
      {
        pluginId: "demo-target",
        source: "test",
        plugin: {
          id: "demo-target",
          meta: {
            id: "demo-target",
            label: "Demo Target",
            selectionLabel: "Demo Target",
            docsPath: "/channels/demo-target",
            blurb: "test stub",
          },
          capabilities: { chatTypes: ["direct"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
          },
          messaging: {
            parseExplicitTarget: ({ raw }: { raw: string }) => ({
              to: raw.trim().toUpperCase(),
              chatType: "direct" as const,
            }),
          },
        },
      },
    ]),
  );
}

describe("parseExplicitTargetForChannel", () => {
  beforeEach(() => {
    setMinimalTargetParsingRegistry();
  });

  it("parses Telegram targets via the registered channel plugin contract", () => {
    expect(parseExplicitTargetForChannel("telegram", "telegram:group:-100123:topic:77")).toEqual({
      to: "-100123",
      threadId: 77,
      chatType: "group",
    });
    expect(parseExplicitTargetForChannel("telegram", "-100123")).toEqual({
      to: "-100123",
      chatType: "group",
    });
  });

  it("parses registered non-bundled channel targets via the active plugin contract", () => {
    expect(parseExplicitTargetForChannel("demo-target", "team-room")).toEqual({
      to: "TEAM-ROOM",
      chatType: "direct",
    });
    expect(parseExplicitTargetForLoadedChannel("demo-target", "team-room")).toEqual({
      to: "TEAM-ROOM",
      chatType: "direct",
    });
  });

  it("builds comparable targets from plugin-owned grammar", () => {
    expect(
      resolveComparableTargetForChannel({
        channel: "telegram",
        rawTarget: "telegram:group:-100123:topic:77",
      }),
    ).toEqual({
      rawTo: "telegram:group:-100123:topic:77",
      to: "-100123",
      threadId: 77,
      chatType: "group",
    });
    expect(
      resolveComparableTargetForLoadedChannel({
        channel: "telegram",
        rawTarget: "telegram:group:-100123:topic:77",
      }),
    ).toEqual({
      rawTo: "telegram:group:-100123:topic:77",
      to: "-100123",
      threadId: 77,
      chatType: "group",
    });
  });

  it("matches comparable targets when only the plugin grammar differs", () => {
    const topicTarget = resolveComparableTargetForChannel({
      channel: "telegram",
      rawTarget: "telegram:-100123:topic:77",
    });
    const bareTarget = resolveComparableTargetForChannel({
      channel: "telegram",
      rawTarget: "-100123",
    });

    expect(
      comparableChannelTargetsMatch({
        left: topicTarget,
        right: bareTarget,
      }),
    ).toBe(false);
    expect(
      comparableChannelTargetsShareRoute({
        left: topicTarget,
        right: bareTarget,
      }),
    ).toBe(true);
  });
});
