import { describe, expect, it, vi } from "vitest";
import type { BrowserServerState } from "../server-context.js";

const mocks = vi.hoisted(() => ({
  startConfiguredExtensionRelays: vi.fn(async () => undefined),
}));

vi.mock("../extension-relay.runtime.js", () => ({
  getExtensionRelayModule: async () => ({
    startConfiguredExtensionRelays: mocks.startConfiguredExtensionRelays,
  }),
}));

const { startControlStateExtensionRelays } = await import("./control-startup.js");

function stateWithProfiles(profiles: Record<string, { driver: string }>): BrowserServerState {
  return {
    resolved: { profiles },
  } as unknown as BrowserServerState;
}

describe("startControlStateExtensionRelays", () => {
  it("starts configured relays when an extension-driver profile exists", async () => {
    const state = stateWithProfiles({ chrome: { driver: "extension" } });
    const onWarn = vi.fn();

    await startControlStateExtensionRelays(state, onWarn);

    expect(mocks.startConfiguredExtensionRelays).toHaveBeenCalledOnce();
    expect(mocks.startConfiguredExtensionRelays).toHaveBeenCalledWith(
      state,
      expect.any(Function),
      onWarn,
    );
  });

  it("does not load relay startup for managed browser profiles", async () => {
    mocks.startConfiguredExtensionRelays.mockClear();

    await startControlStateExtensionRelays(
      stateWithProfiles({ openclaw: { driver: "openclaw" } }),
      vi.fn(),
    );

    expect(mocks.startConfiguredExtensionRelays).not.toHaveBeenCalled();
  });
});
