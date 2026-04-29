import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
});

describe("setup helper import safety", () => {
  it("does not load contract-surface discovery on module import", async () => {
    const state = {
      discoveryLoaded: false,
    };

    vi.doMock("../../plugins/discovery.js", () => {
      state.discoveryLoaded = true;
      throw new Error("contract surface discovery should stay lazy on import");
    });

    const helpers = await importFreshModule<typeof import("./setup-helpers.js")>(
      import.meta.url,
      "./setup-helpers.js?scope=import-safety",
    );

    expect(state.discoveryLoaded).toBe(false);
    expect(
      helpers.createPatchedAccountSetupAdapter({
        channelKey: "demo-setup",
        buildPatch: () => ({}),
      }),
    ).toBeDefined();
  });
});
