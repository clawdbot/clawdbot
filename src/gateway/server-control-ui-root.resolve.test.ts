import { beforeEach, describe, expect, test, vi } from "vitest";

const controlUiAssetsMocks = vi.hoisted(() => ({
  ensureControlUiAssetsBuilt: vi.fn(),
  isPackageProvenControlUiRootSync: vi.fn(),
  resolveControlUiRootOverrideSync: vi.fn(),
  resolveControlUiRootSync: vi.fn(),
}));

vi.mock("../infra/control-ui-assets.js", () => controlUiAssetsMocks);

import { resolveGatewayControlUiRootState } from "./server-control-ui-root.js";

describe("resolveGatewayControlUiRootState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: true,
      built: false,
    });
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(false);
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue(null);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
  });

  test("returns resolved roots without scheduling a build", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");

    await expect(
      resolveGatewayControlUiRootState({
        controlUiEnabled: true,
        gatewayRuntime: { log: vi.fn() } as never,
        log: { warn: vi.fn() },
      }),
    ).resolves.toEqual({ kind: "resolved", path: "/repo/dist/control-ui" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("starts the missing auto-detected assets build without blocking startup", async () => {
    let finishBuild: (() => void) | undefined;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValue(
      new Promise((resolve) => {
        finishBuild = () => resolve({ ok: true, built: true });
      }),
    );
    const gatewayRuntime = { log: vi.fn() };
    const warn = vi.fn();

    await expect(
      resolveGatewayControlUiRootState({
        controlUiEnabled: true,
        gatewayRuntime: gatewayRuntime as never,
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(gatewayRuntime);
    expect(warn).not.toHaveBeenCalled();

    finishBuild?.();
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();
  });
});
