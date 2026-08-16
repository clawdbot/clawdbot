import { describe, expect, it, vi } from "vitest";

const openSyncKeyedStore = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../runtime.js", () => ({
  getSlackRuntime: () => ({ state: { openSyncKeyedStore } }),
}));

import { openSlackPresenceCooldownStore } from "./presence-cooldown-store.js";

describe("openSlackPresenceCooldownStore", () => {
  it("preserves active cooldowns by rejecting new users at capacity", () => {
    openSlackPresenceCooldownStore();

    expect(openSyncKeyedStore).toHaveBeenCalledWith(
      expect.objectContaining({
        maxEntries: 25_000,
        overflowPolicy: "reject-new",
      }),
    );
  });
});
