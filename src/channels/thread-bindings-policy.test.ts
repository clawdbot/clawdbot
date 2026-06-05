// Thread binding policy tests cover how channel thread bindings are created and reused.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { MAX_DATE_TIMESTAMP_MS } from "../shared/number-coercion.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  requiresNativeThreadContextForThreadHere,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingPlacementForCurrentContext,
  resolveThreadBindingSpawnPolicy,
  supportsAutomaticThreadBindingSpawn,
} from "./thread-bindings-policy.js";

describe("thread binding spawn policy helpers", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "child-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "child-chat", label: "Child chat" }),
            conversationBindings: { defaultTopLevelPlacement: "child" },
          },
        },
        {
          pluginId: "current-chat",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "current-chat", label: "Current chat" }),
            conversationBindings: { defaultTopLevelPlacement: "current" },
          },
        },
      ]),
    );
  });

  it("treats child-placement channels as automatic child-thread spawn channels", () => {
    expect(supportsAutomaticThreadBindingSpawn("child-chat")).toBe(true);
    expect(supportsAutomaticThreadBindingSpawn("current-chat")).toBe(false);
    expect(supportsAutomaticThreadBindingSpawn("unknown-chat")).toBe(false);
  });

  it("allows thread-here on threadless conversation channels without a native thread id", () => {
    expect(requiresNativeThreadContextForThreadHere("current-chat")).toBe(false);
    expect(requiresNativeThreadContextForThreadHere("unknown-chat")).toBe(false);
    expect(requiresNativeThreadContextForThreadHere("child-chat")).toBe(true);
  });

  it("resolves current vs child placement from the current channel context", () => {
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "child-chat",
      }),
    ).toBe("child");
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "child-chat",
        threadId: "thread-1",
      }),
    ).toBe("current");
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "current-chat",
      }),
    ).toBe("current");
    expect(
      resolveThreadBindingPlacementForCurrentContext({
        channel: "unknown-chat",
      }),
    ).toBe("current");
  });

  it("enables unified thread-bound session spawns by default", () => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg: {},
      channel: "discord",
      kind: "subagent",
    });

    expect(policy.enabled).toBe(true);
    expect(policy.spawnEnabled).toBe(true);
    expect(policy.defaultSpawnContext).toBe("fork");
  });

  it("preserves long lifecycle hour values while capping unsafe conversions", () => {
    expect(
      resolveThreadBindingIdleTimeoutMs({
        channelIdleHoursRaw: 720,
        sessionIdleHoursRaw: undefined,
      }),
    ).toBe(2_592_000_000);
    expect(
      resolveThreadBindingMaxAgeMs({
        channelMaxAgeHoursRaw: undefined,
        sessionMaxAgeHoursRaw: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it("uses spawnSessions for both subagent and ACP spawn policy", () => {
    const cfg = {
      channels: {
        discord: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    };

    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "subagent",
      }).spawnEnabled,
    ).toBe(false);
    expect(
      resolveThreadBindingSpawnPolicy({
        cfg,
        channel: "discord",
        kind: "acp",
      }).spawnEnabled,
    ).toBe(false);
  });

  it("lets account config override channel spawnSessions and spawn context", () => {
    const policy = resolveThreadBindingSpawnPolicy({
      cfg: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
              defaultSpawnContext: "fork",
            },
            accounts: {
              work: {
                threadBindings: {
                  spawnSessions: true,
                  defaultSpawnContext: "isolated",
                },
              },
            },
          },
        },
      },
      channel: "discord",
      accountId: "work",
      kind: "subagent",
    });

    expect(policy.spawnEnabled).toBe(true);
    expect(policy.defaultSpawnContext).toBe("isolated");
  });
});
