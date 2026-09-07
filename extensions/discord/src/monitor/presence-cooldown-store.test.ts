import { describe, expect, it, vi } from "vitest";

const openSyncKeyedStore = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../runtime.js", () => ({
  getDiscordRuntime: () => ({ state: { openSyncKeyedStore } }),
}));

import { openDiscordPresenceCooldownStore } from "./presence-cooldown-store.js";

describe("openDiscordPresenceCooldownStore", () => {
  it("preserves active cooldowns by rejecting new users at capacity", () => {
    openDiscordPresenceCooldownStore();

    expect(openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEntries: 25_000,
        overflowPolicy: "reject-new",
      }),
    );
  });
});
