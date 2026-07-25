import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { listRealtimeVoiceBrowserSessionBrokers } from "./browser-session-broker-registry.js";
import type { RealtimeVoiceBrowserSessionBroker } from "./provider-types.js";

function createBroker(params: {
  id: string;
  providerId: string;
}): RealtimeVoiceBrowserSessionBroker {
  return {
    ...params,
    isConfigured: () => true,
    createBrowserSession: async () => ({
      provider: params.providerId,
      transport: "webrtc",
      clientSecret: params.id,
    }),
  };
}

function createRegistry(
  brokers: Array<{ pluginId: string; broker: RealtimeVoiceBrowserSessionBroker }>,
): PluginRegistry {
  return {
    ...createEmptyPluginRegistry(),
    realtimeVoiceBrowserSessionBrokers: brokers.map(({ pluginId, broker }) => ({
      pluginId,
      broker,
      source: "test",
    })),
  };
}

beforeEach(() => {
  releasePinnedPluginHttpRouteRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  releasePinnedPluginHttpRouteRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("realtime browser session broker registry", () => {
  it("filters the pinned HTTP route registry by normalized provider id", () => {
    pinActivePluginHttpRouteRegistry(
      createRegistry([
        {
          pluginId: "codex",
          broker: createBroker({ id: "codex-oauth", providerId: "openai" }),
        },
        {
          pluginId: "other",
          broker: createBroker({ id: "other", providerId: "google" }),
        },
      ]),
    );

    expect(listRealtimeVoiceBrowserSessionBrokers(" OPENAI ")).toHaveLength(1);
  });

  it("keeps session creation aligned with the pinned route after the active registry changes", () => {
    const pinnedBroker = createBroker({ id: "codex-oauth", providerId: "openai" });
    pinActivePluginHttpRouteRegistry(createRegistry([{ pluginId: "codex", broker: pinnedBroker }]));
    setActivePluginRegistry(
      createRegistry([
        {
          pluginId: "codex-refresh",
          broker: createBroker({ id: "refreshed", providerId: "openai" }),
        },
      ]),
    );

    expect(listRealtimeVoiceBrowserSessionBrokers("openai")).toEqual([pinnedBroker]);
  });
});
