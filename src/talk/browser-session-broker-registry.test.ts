import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRealtimeVoiceBrowserSessionBroker,
  registerRealtimeVoiceBrowserSessionBroker,
} from "./browser-session-broker-registry.js";
import type { RealtimeVoiceBrowserSessionBroker } from "./provider-types.js";

const unregisterCallbacks: Array<() => void> = [];

function registerBroker(label: string): RealtimeVoiceBrowserSessionBroker {
  const broker: RealtimeVoiceBrowserSessionBroker = {
    id: " Codex-OAuth ",
    providerId: " OpenAI ",
    isConfigured: vi.fn(() => true),
    createBrowserSession: vi.fn(async () => ({
      provider: "openai",
      transport: "webrtc" as const,
      clientSecret: label,
    })),
  };
  unregisterCallbacks.push(registerRealtimeVoiceBrowserSessionBroker(broker));
  return broker;
}

afterEach(() => {
  for (const unregister of unregisterCallbacks.splice(0).toReversed()) {
    unregister();
  }
});

describe("realtime browser session broker registry", () => {
  it("normalizes provider and auth-mode keys", () => {
    registerBroker("first");

    expect(getRealtimeVoiceBrowserSessionBroker("OPENAI", "CODEX-OAUTH")).toMatchObject({
      id: "codex-oauth",
      providerId: "openai",
    });
  });

  it("does not let stale cleanup remove a replacement registration", () => {
    registerBroker("first");
    const unregisterFirst = unregisterCallbacks.at(-1);
    const second = registerBroker("second");

    unregisterFirst?.();

    expect(getRealtimeVoiceBrowserSessionBroker("openai", "codex-oauth")).toMatchObject({
      createBrowserSession: second.createBrowserSession,
    });
  });
});
