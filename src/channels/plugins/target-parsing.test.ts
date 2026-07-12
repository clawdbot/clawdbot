// Target parsing tests cover channel target syntax parsing and validation.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  channelRouteTargetsMatchExact,
  channelRouteTargetsShareConversation,
} from "../../plugin-sdk/channel-route.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  comparableChannelTargetsMatch,
  parseExplicitTargetForLoadedChannel,
  resolveComparableTargetForLoadedChannel,
  resolveRouteTargetForLoadedChannel,
} from "./target-parsing-loaded.js";

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
      to: expectDefined(prefixedTopic[1], "prefixedTopic[1] test invariant"),
      threadId: Number.parseInt(
        expectDefined(prefixedTopic[2], "prefixedTopic[2] test invariant"),
        10,
      ),
      chatType: "group",
    };
  }
  const topic = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (topic) {
    return {
      to: expectDefined(topic[1], "topic[1] test invariant"),
      threadId: Number.parseInt(expectDefined(topic[2], "topic[2] test invariant"), 10),
      chatType: expectDefined(topic[1], "topic[1] test invariant").startsWith("-")
        ? "group"
        : "direct",
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

describe("parseExplicitTargetForLoadedChannel", () => {
  beforeEach(() => {
    setMinimalTargetParsingRegistry();
  });

  it("parses threaded targets via the registered channel plugin contract", () => {
    expect(
      parseExplicitTargetForLoadedChannel("mock-threaded", "threaded:group:room-a:topic:77"),
    ).toEqual({
      to: "room-a",
      threadId: 77,
      chatType: "group",
    });
    expect(parseExplicitTargetForLoadedChannel("mock-threaded", "room-a")).toEqual({
      to: "room-a",
      chatType: undefined,
    });
  });

  it("parses registered non-bundled channel targets via the active plugin contract", () => {
    expect(parseExplicitTargetForLoadedChannel("demo-target", "team-room")).toEqual({
      to: "TEAM-ROOM",
      chatType: "direct",
    });
    expect(parseExplicitTargetForLoadedChannel("demo-target", "team-room")).toEqual({
      to: "TEAM-ROOM",
      chatType: "direct",
    });
  });

  it("builds route targets from plugin-owned grammar", () => {
    expect(
      resolveRouteTargetForLoadedChannel({
        channel: "mock-threaded",
        rawTarget: "threaded:group:room-a:topic:77",
      }),
    ).toEqual({
      channel: "mock-threaded",
      rawTo: "threaded:group:room-a:topic:77",
      to: "room-a",
      threadId: 77,
      chatType: "group",
    });
    expect(
      resolveRouteTargetForLoadedChannel({
        channel: "mock-threaded",
        rawTarget: "threaded:group:room-a:topic:77",
      }),
    ).toEqual({
      channel: "mock-threaded",
      rawTo: "threaded:group:room-a:topic:77",
      to: "room-a",
      threadId: 77,
      chatType: "group",
    });
  });

  it("matches route targets when only the plugin grammar differs", () => {
    const topicTarget = resolveRouteTargetForLoadedChannel({
      channel: "mock-threaded",
      rawTarget: "threaded:room-a:topic:77",
    });
    const bareTarget = resolveRouteTargetForLoadedChannel({
      channel: "mock-threaded",
      rawTarget: "room-a",
    });

    expect(
      channelRouteTargetsMatchExact({
        left: topicTarget,
        right: bareTarget,
      }),
    ).toBe(false);
    expect(
      channelRouteTargetsShareConversation({
        left: topicTarget,
        right: bareTarget,
      }),
    ).toBe(true);
  });

  it("compares numeric and string thread ids through the shared route contract", () => {
    const numericThread = resolveRouteTargetForLoadedChannel({
      channel: "mock-threaded",
      rawTarget: "threaded:room-a:topic:77",
    });
    const stringThread = resolveRouteTargetForLoadedChannel({
      channel: "mock-threaded",
      rawTarget: "room-a",
      fallbackThreadId: "77",
    });

    expect(
      channelRouteTargetsMatchExact({
        left: numericThread,
        right: stringThread,
      }),
    ).toBe(true);
  });

  it("keeps deprecated comparable target helpers as route wrappers", () => {
    const numericThread = resolveComparableTargetForLoadedChannel({
      channel: "mock-threaded",
      rawTarget: "threaded:room-a:topic:77",
    });
    const stringThread = resolveRouteTargetForLoadedChannel({
      channel: "mock-threaded",
      rawTarget: "room-a",
      fallbackThreadId: "77",
    });

    expect(
      comparableChannelTargetsMatch({
        left: numericThread,
        right: stringThread,
      }),
    ).toBe(true);
  });
});
