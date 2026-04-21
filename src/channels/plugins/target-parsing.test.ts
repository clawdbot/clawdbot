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

function parseThreadedTargetForTest(raw: string): {
  to: string;
  threadId?: number;
  chatType?: "direct" | "group";
} {
  const trimmed = raw
    .trim()
    .replace(/^threaded:/i, "")
    .replace(/^mock:/i, "");
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
        pluginId: "mock-threaded",
        plugin: {
          id: "mock-threaded",
          meta: {
            id: "mock-threaded",
            label: "Mock Threaded",
            selectionLabel: "Mock Threaded",
            docsPath: "/channels/mock-threaded",
            blurb: "test stub",
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => [],
            resolveAccount: () => ({}),
          },
          messaging: {
            parseExplicitTarget: ({ raw }: { raw: string }) => parseThreadedTargetForTest(raw),
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

  it("parses threaded targets via the registered channel plugin contract", () => {
    expect(
      parseExplicitTargetForChannel("mock-threaded", "threaded:group:room-a:topic:77"),
    ).toEqual({
      to: "room-a",
      threadId: 77,
      chatType: "group",
    });
    expect(parseExplicitTargetForChannel("mock-threaded", "room-a")).toEqual({
      to: "room-a",
      chatType: undefined,
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
        channel: "mock-threaded",
        rawTarget: "threaded:group:room-a:topic:77",
      }),
    ).toEqual({
      rawTo: "threaded:group:room-a:topic:77",
      to: "room-a",
      threadId: 77,
      chatType: "group",
    });
    expect(
      resolveComparableTargetForLoadedChannel({
        channel: "mock-threaded",
        rawTarget: "threaded:group:room-a:topic:77",
      }),
    ).toEqual({
      rawTo: "threaded:group:room-a:topic:77",
      to: "room-a",
      threadId: 77,
      chatType: "group",
    });
  });

  it("matches comparable targets when only the plugin grammar differs", () => {
    const topicTarget = resolveComparableTargetForChannel({
      channel: "mock-threaded",
      rawTarget: "threaded:room-a:topic:77",
    });
    const bareTarget = resolveComparableTargetForChannel({
      channel: "mock-threaded",
      rawTarget: "room-a",
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
