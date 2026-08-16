import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";

const mocks = vi.hoisted(() => ({
  readConfigMachineState: vi.fn(),
}));

vi.mock("../state/config-machine-state.js", () => ({
  readConfigMachineState: mocks.readConfigMachineState,
}));

const { readBundledDiscoveryMode } = await import("./bundled-discovery-state.js");

describe("bundled discovery state", () => {
  beforeEach(() => {
    mocks.readConfigMachineState.mockReset();
  });

  it("reads machine state from the active plugin registry state directory", async () => {
    const sourceEnv = { OPENCLAW_STATE_DIR: "/operator/openclaw" };
    const isolatedRoots = {
      ...resolvePluginInstallRoots(sourceEnv),
      stateDir: "/tmp/private-plugin-state",
    };
    mocks.readConfigMachineState.mockReturnValue("allowlist");

    await withPluginInstallRoots(isolatedRoots, async () => {
      expect(readBundledDiscoveryMode({ env: sourceEnv })).toBe("allowlist");
    });

    expect(mocks.readConfigMachineState).toHaveBeenCalledWith("plugins.bundledDiscovery", {
      env: {
        OPENCLAW_STATE_DIR: "/tmp/private-plugin-state",
      },
    });
  });

  it("preserves explicit database path ownership", async () => {
    const sourceEnv = { OPENCLAW_STATE_DIR: "/operator/openclaw" };
    const isolatedRoots = {
      ...resolvePluginInstallRoots(sourceEnv),
      stateDir: "/tmp/private-plugin-state",
    };
    mocks.readConfigMachineState.mockReturnValue("compat");

    await withPluginInstallRoots(isolatedRoots, async () => {
      expect(
        readBundledDiscoveryMode({
          env: sourceEnv,
          path: "/explicit/openclaw.sqlite",
        }),
      ).toBe("compat");
    });

    expect(mocks.readConfigMachineState).toHaveBeenCalledWith("plugins.bundledDiscovery", {
      env: sourceEnv,
      path: "/explicit/openclaw.sqlite",
    });
  });
});
