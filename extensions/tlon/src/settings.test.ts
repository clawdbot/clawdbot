// Tlon tests cover settings store behavior.
import { describe, expect, it } from "vitest";
import { createSettingsManager } from "./settings.js";
import type { UrbitSSEClient } from "./urbit/sse-client.js";

type SubscriptionHandlers = {
  event?: (data: unknown) => Promise<void> | void;
};

function createMockSettingsApi(scryResult: unknown): {
  api: UrbitSSEClient;
  emitSettingsEvent: (event: unknown) => Promise<void>;
} {
  const handlers: SubscriptionHandlers = {};
  const api = {
    async scry() {
      return scryResult;
    },
    async subscribe(params: {
      app: string;
      path: string;
      event?: (data: unknown) => Promise<void> | void;
    }) {
      handlers.event = params.event;
      return 1;
    },
  } as unknown as UrbitSSEClient;
  return {
    api,
    emitSettingsEvent: async (event: unknown) => {
      await handlers.event?.(event);
    },
  };
}

describe("tlon settings store", () => {
  it("loads autoDiscoverChannels from the settings-store scry response", async () => {
    const { api } = createMockSettingsApi({
      all: { moltbot: { tlon: { autoDiscoverChannels: true } } },
    });

    const manager = createSettingsManager(api);
    await manager.load();

    // Regression: parseSettingsResponse previously read the dead `autoDiscover`
    // key, so the live `autoDiscoverChannels` override never reached the monitor.
    expect(manager.current.autoDiscoverChannels).toBe(true);
  });

  it("applies live autoDiscoverChannels updates delivered over the subscription", async () => {
    const { api, emitSettingsEvent } = createMockSettingsApi({
      all: { moltbot: { tlon: {} } },
    });

    const manager = createSettingsManager(api);
    await manager.load();
    expect(manager.current.autoDiscoverChannels).toBeUndefined();

    await manager.startSubscription();
    await emitSettingsEvent({
      "put-entry": {
        desk: "moltbot",
        "bucket-key": "tlon",
        "entry-key": "autoDiscoverChannels",
        value: false,
      },
    });

    expect(manager.current.autoDiscoverChannels).toBe(false);
  });
});
