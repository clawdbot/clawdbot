// QA channel tests cover QA channel runtime behavior and mocked message delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const buildQaTargetImpl = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-loader.js")>("./facade-loader.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSync,
  };
});

describe("plugin-sdk qa-channel", () => {
  beforeEach(() => {
    buildQaTargetImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    buildQaTargetImpl.mockReturnValue("qa://main");
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      buildQaTarget: buildQaTargetImpl,
      qaChannelPlugin: { id: "qa-channel" },
    });
  });

  it("keeps the qa facade cold until a value is used", async () => {
    const module = await import("./qa-channel.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(module.qaChannelPlugin.id).toBe("qa-channel");
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledTimes(1);
  });

  it("delegates qa helpers through the bundled public surface", async () => {
    const { buildQaTarget, formatQaTarget } = await import("./qa-channel.js");
    const input = { chatType: "direct" as const, conversationId: "main" };

    expect(buildQaTarget(input)).toBe("qa://main");
    expect(formatQaTarget(input)).toBe("qa://main");
    expect(buildQaTargetImpl).toHaveBeenCalledTimes(2);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-channel",
      artifactBasename: "api.js",
    });
  });
});
