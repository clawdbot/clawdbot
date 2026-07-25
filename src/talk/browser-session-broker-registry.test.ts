import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getRealtimeVoiceBrowserSessionBroker,
  listRealtimeVoiceBrowserSessionBrokers,
} from "./browser-session-broker-registry.js";
import type { RealtimeVoiceBrowserSessionBroker } from "./provider-types.js";

const mocks = vi.hoisted(() => ({
  registry: null as PluginRegistry | null,
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => mocks.registry,
}));

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

beforeEach(() => {
  mocks.registry = {
    realtimeVoiceBrowserSessionBrokers: [
      {
        pluginId: "codex",
        broker: createBroker({ id: "codex-oauth", providerId: "openai" }),
        source: "test",
      },
      {
        pluginId: "other",
        broker: createBroker({ id: "other", providerId: "google" }),
        source: "test",
      },
    ],
  } as PluginRegistry;
});

describe("realtime browser session broker registry", () => {
  it("filters the active host registry by normalized provider id", () => {
    expect(listRealtimeVoiceBrowserSessionBrokers(" OPENAI ")).toHaveLength(1);
    expect(getRealtimeVoiceBrowserSessionBroker("OPENAI", "CODEX-OAUTH")).toMatchObject({
      id: "codex-oauth",
      providerId: "openai",
    });
  });

  it("returns no brokers before the host registry is active", () => {
    mocks.registry = null;

    expect(listRealtimeVoiceBrowserSessionBrokers("openai")).toEqual([]);
  });
});
