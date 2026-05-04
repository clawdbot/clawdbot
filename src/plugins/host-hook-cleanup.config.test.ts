import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

describe("plugin host cleanup config fallback", () => {
  afterEach(() => {
    mocks.getRuntimeConfig.mockReset();
  });

  it("records session store config failures while continuing runtime cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
    registry.runtimeLifecycles ??= [];
    registry.runtimeLifecycles.push({
      pluginId: "cleanup-plugin",
      pluginName: "Cleanup Plugin",
      source: "test",
      lifecycle: {
        id: "runtime-cleanup",
        cleanup,
      },
    });
    mocks.getRuntimeConfig.mockImplementation(() => {
      throw new Error("invalid config");
    });

    const result = await runPluginHostCleanup({
      registry,
      pluginId: "cleanup-plugin",
      reason: "disable",
    });

    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "disable",
      }),
    );
    expect(result.cleanupCount).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        pluginId: "cleanup-plugin",
        hookId: "session-store",
      }),
    ]);
  });
});
