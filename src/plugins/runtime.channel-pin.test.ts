import { afterEach, describe, expect, it } from "vitest";
import { loadChannelOutboundAdapter } from "../channels/plugins/outbound/load.js";
import { getChannelPlugin } from "../channels/plugins/registry.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import {
  getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion,
  getActivePluginChannelRegistry,
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  requireActivePluginChannelRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

function createRegistryWithChannel(pluginId = "demo-channel") {
  const registry = createEmptyPluginRegistry();
  const plugin = { id: pluginId, meta: {} } as never;
  registry.channels = [{ plugin }] as never;
  return { registry, plugin };
}

function createChannelRegistryPair(pluginId = "demo-channel") {
  return {
    first: createRegistryWithChannel(pluginId),
    second: createRegistryWithChannel(pluginId),
  };
}

function createRegistrySet() {
  return {
    startup: createEmptyPluginRegistry(),
    replacement: createEmptyPluginRegistry(),
    unrelated: createEmptyPluginRegistry(),
  };
}

function expectActiveChannelRegistry(registry: ReturnType<typeof createEmptyPluginRegistry>) {
  expect(getActivePluginChannelRegistry()).toBe(registry);
}

function expectPinnedChannelRegistry(
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  replacementRegistry: ReturnType<typeof createEmptyPluginRegistry>,
) {
  setActivePluginRegistry(startupRegistry);
  pinActivePluginChannelRegistry(startupRegistry);
  setActivePluginRegistry(replacementRegistry);
  expectActiveChannelRegistry(startupRegistry);
}

function expectResetClearsPinnedChannelRegistry(params: {
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  freshRegistry: ReturnType<typeof createEmptyPluginRegistry>;
}) {
  setActivePluginRegistry(params.startupRegistry);
  pinActivePluginChannelRegistry(params.startupRegistry);

  resetPluginRuntimeStateForTest();

  setActivePluginRegistry(params.freshRegistry);
  expectActiveChannelRegistry(params.freshRegistry);
}

function expectChannelRegistrySwap(params: {
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  replacementRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  pin?: boolean;
  releaseRegistry?: ReturnType<typeof createEmptyPluginRegistry>;
  expectedDuringSwap: ReturnType<typeof createEmptyPluginRegistry>;
  expectedAfterRelease: ReturnType<typeof createEmptyPluginRegistry>;
}) {
  setActivePluginRegistry(params.startupRegistry);
  if (params.pin) {
    pinActivePluginChannelRegistry(params.startupRegistry);
  }

  setActivePluginRegistry(params.replacementRegistry);
  expectActiveChannelRegistry(params.expectedDuringSwap);

  if (params.pin && params.releaseRegistry) {
    releasePinnedPluginChannelRegistry(params.releaseRegistry);
  }

  expectActiveChannelRegistry(params.expectedAfterRelease);
}

describe("channel registry pinning", () => {
  afterEach(() => {
    resetAgentEventsForTest();
    resetPluginRuntimeStateForTest();
  });

  it("returns the active registry when not pinned", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    expectActiveChannelRegistry(registry);
  });

  it("preserves pinned channel registry across setActivePluginRegistry calls", () => {
    const { registry: startup } = createRegistryWithChannel();
    // A subsequent registry swap (e.g., config-schema load) must not evict channels.
    const replacement = createEmptyPluginRegistry();
    expectPinnedChannelRegistry(startup, replacement);
    expect(getActivePluginChannelRegistry()!.channels).toHaveLength(1);
  });

  it("keeps pinned channel registries live until they are released", () => {
    const { registry: startup } = createRegistryWithChannel();
    const replacement = createEmptyPluginRegistry();

    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);
    setActivePluginRegistry(replacement);

    expect(getActivePluginChannelRegistry()).toBe(startup);
    expect(isPluginRegistryRetired(startup)).toBe(false);

    releasePinnedPluginChannelRegistry(startup);

    expect(getActivePluginChannelRegistry()).toBe(replacement);
    expect(isPluginRegistryRetired(startup)).toBe(true);
  });

  it("re-pin invalidates cached channel lookups", () => {
    const { first, second } = createChannelRegistryPair();
    const { registry: setup, plugin: setupPlugin } = first;
    setActivePluginRegistry(setup);
    pinActivePluginChannelRegistry(setup);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const { registry: full, plugin: fullPlugin } = second;
    setActivePluginRegistry(full);

    expect(getChannelPlugin("demo-channel")).toBe(setupPlugin);

    const activeVersionBeforeRepin = getActivePluginRegistryVersion();
    const channelVersionBeforeRepin = getActivePluginChannelRegistryVersion();
    pinActivePluginChannelRegistry(full);

    expect(getActivePluginRegistryVersion()).toBe(activeVersionBeforeRepin);
    expect(getActivePluginChannelRegistryVersion()).toBe(channelVersionBeforeRepin + 1);
    expect(getChannelPlugin("demo-channel")).toBe(fullPlugin);
  });

  it.each([
    {
      name: "updates channel registry on swap when not pinned",
      pin: false,
      releasePinnedRegistry: false,
      expectDuringPin: false,
      expectAfterSwap: "second",
    },
    {
      name: "release restores live-tracking behavior",
      pin: true,
      releasePinnedRegistry: true,
      expectDuringPin: true,
      expectAfterSwap: "second",
    },
    {
      name: "release is a no-op when the pinned registry does not match",
      pin: true,
      releasePinnedRegistry: false,
      expectDuringPin: true,
      expectAfterSwap: "first",
    },
  ] as const)("$name", ({ pin, releasePinnedRegistry, expectDuringPin, expectAfterSwap }) => {
    const { startup, replacement, unrelated } = createRegistrySet();
    expectChannelRegistrySwap({
      startupRegistry: startup,
      replacementRegistry: replacement,
      ...(pin ? { pin: true } : {}),
      ...(pin ? { releaseRegistry: releasePinnedRegistry ? startup : unrelated } : {}),
      expectedDuringSwap: expectDuringPin ? startup : replacement,
      expectedAfterRelease: expectAfterSwap === "second" ? replacement : startup,
    });
  });

  it("requireActivePluginChannelRegistry creates a registry when none exists", () => {
    resetPluginRuntimeStateForTest();
    const registry = requireActivePluginChannelRegistry();
    expect(registry).toEqual(createEmptyPluginRegistry());
  });

  it("resetPluginRuntimeStateForTest clears channel pin", () => {
    const { startup, replacement: fresh } = createRegistrySet();
    expectResetClearsPinnedChannelRegistry({
      startupRegistry: startup,
      freshRegistry: fresh,
    });
  });

  it("loadChannelOutboundAdapter resolves from pinned registry after active registry replacement", async () => {
    const outboundAdapter = { send: async () => ({ messageId: "1" }) };
    const startup = createEmptyPluginRegistry();
    startup.channels = [
      {
        pluginId: "telegram",
        plugin: { id: "telegram", meta: {}, outbound: outboundAdapter },
        source: "test",
      },
    ] as never;
    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);

    // Simulate a post-boot registry replacement (e.g. config-schema load, plugin status query).
    const replacement = createEmptyPluginRegistry();
    setActivePluginRegistry(replacement);

    // The outbound loader must still find the telegram adapter from the pinned registry.
    const adapter = await loadChannelOutboundAdapter("telegram");
    expect(adapter).toBe(outboundAdapter);
  });

  it("keeps pinned channel registry agent-event subscriptions live after active registry replacement", () => {
    const observed: string[] = [];
    const startup = createEmptyPluginRegistry();
    startup.agentEventSubscriptions = [
      {
        pluginId: "startup-plugin",
        pluginName: "Startup Plugin",
        source: "test",
        subscription: {
          id: "startup-subscription",
          handle: (event) => {
            observed.push(`startup:${event.stream}`);
          },
        },
      },
    ];
    const replacement = createEmptyPluginRegistry();
    replacement.agentEventSubscriptions = [
      {
        pluginId: "replacement-plugin",
        pluginName: "Replacement Plugin",
        source: "test",
        subscription: {
          id: "replacement-subscription",
          handle: (event) => {
            observed.push(`replacement:${event.stream}`);
          },
        },
      },
    ];

    setActivePluginRegistry(startup);
    pinActivePluginChannelRegistry(startup);
    setActivePluginRegistry(replacement);

    emitAgentEvent({
      runId: "run-pinned-agent-events",
      stream: "approval",
      data: { state: "queued" },
    });

    expect(observed.toSorted()).toEqual(["replacement:approval", "startup:approval"]);
  });

  it("dedupes the agent-event bridge across multiple runtime module instances", async () => {
    const observed: string[] = [];
    const runtimeA = await import(new URL("./runtime.ts?runtimeA", import.meta.url).href);
    const runtimeB = await import(new URL("./runtime.ts?runtimeB", import.meta.url).href);
    const startup = createEmptyPluginRegistry();
    startup.agentEventSubscriptions = [
      {
        pluginId: "startup-plugin",
        pluginName: "Startup Plugin",
        source: "test",
        subscription: {
          id: "startup-subscription",
          handle: (event) => {
            observed.push(`startup:${event.stream}`);
          },
        },
      },
    ];
    const replacement = createEmptyPluginRegistry();
    replacement.agentEventSubscriptions = [
      {
        pluginId: "replacement-plugin",
        pluginName: "Replacement Plugin",
        source: "test",
        subscription: {
          id: "replacement-subscription",
          handle: (event) => {
            observed.push(`replacement:${event.stream}`);
          },
        },
      },
    ];

    runtimeA.setActivePluginRegistry(startup);
    runtimeA.pinActivePluginChannelRegistry(startup);
    runtimeB.setActivePluginRegistry(replacement);

    emitAgentEvent({
      runId: "run-cross-module-pinned-agent-events",
      stream: "approval",
      data: { state: "queued" },
    });

    expect(observed.toSorted()).toEqual(["replacement:approval", "startup:approval"]);
  });
});
