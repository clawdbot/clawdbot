// QA channel tests cover QA channel runtime behavior and mocked message delivery.
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSyncCore = vi.hoisted(() => vi.fn());
const buildQaTargetImpl = vi.hoisted(() => vi.fn());
const pollQaBusImpl = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", async () => {
  const actual = await vi.importActual<typeof import("./facade-loader.js")>("./facade-loader.js");
  return {
    ...actual,
    loadBundledPluginPublicSurfaceModuleSyncCore,
  };
});

describe("plugin-sdk qa-channel", () => {
  beforeEach(() => {
    buildQaTargetImpl.mockReset();
    pollQaBusImpl.mockReset();
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReset();
    buildQaTargetImpl.mockReturnValue("qa://main");
    pollQaBusImpl.mockResolvedValue({ cursor: 1, events: [] });
    loadBundledPluginPublicSurfaceModuleSyncCore.mockReturnValue({
      buildQaTarget: buildQaTargetImpl,
      pollQaBus: pollQaBusImpl,
      qaChannelPlugin: { id: "qa-channel" },
    });
  });

  it("keeps the qa facade cold until a value is used", async () => {
    const module = await import("./qa-channel.js");

    expect(loadBundledPluginPublicSurfaceModuleSyncCore).not.toHaveBeenCalled();
    expect(module.qaChannelPlugin.id).toBe("qa-channel");
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledTimes(1);
  });

  it("delegates qa helpers through the bundled public surface", async () => {
    const { buildQaTarget, formatQaTarget } = await import("./qa-channel.js");
    const input = { chatType: "direct" as const, conversationId: "main" };

    expect(buildQaTarget(input)).toBe("qa://main");
    expect(formatQaTarget(input)).toBe("qa://main");
    expect(buildQaTargetImpl).toHaveBeenCalledTimes(2);
    expect(loadBundledPluginPublicSurfaceModuleSyncCore).toHaveBeenCalledWith({
      dirName: "qa-channel",
      artifactBasename: "api.js",
    });
  });

  it("carries explicit completion acknowledgements through the QA facade", async () => {
    const { pollQaBus } = await import("./qa-channel.js");
    const input = {
      baseUrl: "http://127.0.0.1:43124",
      accountId: "default",
      cursor: 1,
      acknowledgedCursor: 1,
      timeoutMs: 0,
    };

    expectTypeOf<Parameters<typeof pollQaBus>[0]>()
      .toHaveProperty("acknowledgedCursor")
      .toEqualTypeOf<number>();
    await expect(pollQaBus(input)).resolves.toEqual({ cursor: 1, events: [] });
    expect(pollQaBusImpl).toHaveBeenCalledWith(input);
  });
});
