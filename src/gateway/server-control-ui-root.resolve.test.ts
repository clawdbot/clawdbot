/** Tests the Gateway-owned Control UI root and background asset lifecycle. */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const controlUiAssetsMocks = vi.hoisted(() => ({
  ensureControlUiAssetsBuilt: vi.fn(),
  isPackageProvenControlUiRootSync: vi.fn(),
  inspectControlUiRootAssets: vi.fn(),
  resolveControlUiRootOverrideSync: vi.fn(),
  resolveControlUiRootSync: vi.fn(),
}));
const retentionMocks = vi.hoisted(() => ({
  prepare: vi.fn<
    (options?: { isCancelled?: () => boolean; signal?: AbortSignal }) => Promise<void>
  >(async () => {}),
  resolveAsset: vi.fn(() => null),
}));

vi.mock("../infra/control-ui-assets.js", () => controlUiAssetsMocks);
vi.mock("../version.js", () => ({ resolveRuntimeServiceBuildId: () => "gateway-build" }));
vi.mock("./control-ui-asset-retention.js", () => ({
  createControlUiAssetRetention: vi.fn(() => retentionMocks),
}));

import { createGatewayControlUiRootLifecycle } from "./server-control-ui-root.js";

function readyAssets(root = "/repo/dist/control-ui", publicAssetBuildId?: string) {
  return { kind: "ready", indexPath: `${root}/index.html`, publicAssetBuildId };
}

describe("createGatewayControlUiRootLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "realpathSync").mockImplementation((rootPath) => String(rootPath));
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: true,
      built: false,
      assets: readyAssets(),
    });
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(false);
    controlUiAssetsMocks.inspectControlUiRootAssets.mockImplementation((root) => readyAssets(root));
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue(null);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
    retentionMocks.prepare.mockResolvedValue(undefined);
    retentionMocks.resolveAsset.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createLifecycle(options?: {
    enabled?: boolean;
    override?: string;
    warn?: ReturnType<typeof vi.fn<(message: string) => void>>;
  }) {
    const gatewayRuntime = { log: vi.fn() };
    const warn = options?.warn ?? vi.fn<(message: string) => void>();
    const lifecycle = createGatewayControlUiRootLifecycle({
      ...(options?.override ? { controlUiRootOverride: options.override } : {}),
      controlUiEnabled: options?.enabled ?? true,
      gatewayRuntime: gatewayRuntime as never,
      log: { warn },
    });
    return { lifecycle, gatewayRuntime, warn };
  }

  test("prepares resolved roots without scheduling a build", () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");

    const { lifecycle } = createLifecycle();

    expect(lifecycle.state).toEqual({
      kind: "resolved",
      path: "/repo/dist/control-ui",
      realPath: "/repo/dist/control-ui",
    });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("prepares retained generations for bundled roots without delaying construction", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    const { lifecycle } = createLifecycle();

    expect(retentionMocks.prepare).not.toHaveBeenCalled();
    await lifecycle.start();

    expect(retentionMocks.prepare).toHaveBeenCalledWith({
      isCancelled: expect.any(Function),
      signal: expect.any(AbortSignal),
    });
  });

  test("snapshots public asset identity only for a bundled root", () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    controlUiAssetsMocks.inspectControlUiRootAssets.mockReturnValue(
      readyAssets("/repo/dist/control-ui", "build-content-digest"),
    );
    const { lifecycle } = createLifecycle();
    expect(lifecycle.state).toMatchObject({
      kind: "bundled",
      publicAssetBuildId: "build-content-digest",
    });
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue("/repo/dist/control-ui");
    const custom = createLifecycle({ override: "/repo/dist/control-ui" });
    expect(custom.lifecycle.state).not.toHaveProperty("publicAssetBuildId");
  });

  test("cancels retained-generation preparation without warning during shutdown", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    retentionMocks.prepare.mockImplementationOnce(
      async (options) =>
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const { lifecycle, warn } = createLifecycle();
    const preparing = lifecycle.start();
    await vi.waitFor(() => expect(retentionMocks.prepare).toHaveBeenCalledOnce());
    await Promise.all([preparing, lifecycle.stop()]);

    expect(warn).not.toHaveBeenCalled();
  });

  test("rebuilds incomplete auto-discovered roots before publishing them", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.inspectControlUiRootAssets.mockReturnValue({ kind: "incomplete" });
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockImplementationOnce(async () => {
      controlUiAssetsMocks.inspectControlUiRootAssets.mockImplementation((root) =>
        readyAssets(root),
      );
      return { ok: true, built: true, assets: readyAssets() };
    });
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    const { lifecycle } = createLifecycle();
    const rootReference = lifecycle.state;

    expect(rootReference).toEqual({ kind: "preparing" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    await lifecycle.start();

    expect(lifecycle.state).toBe(rootReference);
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    expect(rootReference).toEqual({
      kind: "bundled",
      path: "/repo/dist/control-ui",
      realPath: "/repo/dist/control-ui",
      retainedAssets: retentionMocks,
    });
    expect(retentionMocks.prepare).toHaveBeenCalledOnce();
  });

  test("starts only after scheduling and promotes the same root reference once", async () => {
    let finishBuild: (() => void) | undefined;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValue(
      new Promise((resolve) => {
        finishBuild = () => resolve({ ok: true, built: true, assets: readyAssets() });
      }),
    );
    const { lifecycle, gatewayRuntime, warn } = createLifecycle();
    const rootReference = lifecycle.state;

    expect(rootReference).toEqual({ kind: "preparing" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    const build = lifecycle.start();
    expect(lifecycle.start()).toBe(build);
    await vi.waitFor(() =>
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce(),
    );
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(gatewayRuntime, {
      signal: expect.any(AbortSignal),
      assetRoot: undefined,
      expectedBuildId: expect.anything(),
      moduleUrl: expect.any(String),
    });
    expect(rootReference).toEqual({ kind: "preparing" });

    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    finishBuild?.();
    await build;

    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toEqual({
      kind: "bundled",
      path: "/repo/dist/control-ui",
      realPath: "/repo/dist/control-ui",
      retainedAssets: retentionMocks,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps configured roots unbundled even when their package path is proven", () => {
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue("/custom/ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);

    const { lifecycle } = createLifecycle({ override: "/custom/ui" });

    expect(lifecycle.state).toEqual({
      kind: "resolved",
      path: "/custom/ui",
      realPath: "/custom/ui",
    });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
    expect(controlUiAssetsMocks.inspectControlUiRootAssets).not.toHaveBeenCalled();
  });

  test("keeps invalid configured roots terminal without starting a default build", () => {
    const { lifecycle, warn } = createLifecycle({ override: "/custom/missing" });

    expect(lifecycle.state).toEqual({ kind: "invalid", path: "/custom/missing" });
    expect(warn).toHaveBeenCalledWith("gateway: controlUi.root not found at /custom/missing");
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("keeps disappearing configured roots from aborting Gateway startup", () => {
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue("/custom/ui");
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: root vanished");
    });

    const { lifecycle, warn } = createLifecycle({ override: "/custom/ui" });

    expect(lifecycle.state).toEqual({ kind: "invalid", path: "/custom/ui" });
    expect(warn).toHaveBeenCalledWith(
      "gateway: Control UI assets are unavailable at /custom/ui: ENOENT: root vanished",
    );
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("reports disappearing auto-detected roots without aborting Gateway startup", () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: root vanished");
    });

    const { lifecycle, warn } = createLifecycle();

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith(
      "gateway: Control UI assets are unavailable at /repo/dist/control-ui: ENOENT: root vanished",
    );
  });

  test("prepares initially disabled assets when enabled and keeps the serving root stable", async () => {
    const { lifecycle } = createLifecycle({ enabled: false });
    const rootReference = lifecycle.state;

    await lifecycle.start();
    expect(controlUiAssetsMocks.resolveControlUiRootSync).not.toHaveBeenCalled();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(lifecycle.state).toBe(rootReference);
    expect(lifecycle.state).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
    await lifecycle.stop();
  });

  test("publishes structured build failures into the existing root reference", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: false,
      built: false,
      message: "Control UI build timed out.",
    });
    const { lifecycle, warn } = createLifecycle();
    const rootReference = lifecycle.state;

    await lifecycle.start();

    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith("gateway: Control UI build timed out.");
  });

  test("publishes rejected builds as actionable terminal failures", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockRejectedValue(new Error("spawn failed"));
    const { lifecycle, warn } = createLifecycle();

    await lifecycle.start();

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith("gateway: Control UI assets build failed: spawn failed");
  });

  test.each([false, true])(
    "does not publish a late build result after shutdown (initially failed=%s)",
    async (initiallyFailed) => {
      if (initiallyFailed) {
        controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
        vi.mocked(fs.realpathSync).mockImplementationOnce(() => {
          throw new Error("root unavailable");
        });
      }
      const { lifecycle, warn } = createLifecycle();
      if (initiallyFailed) {
        expect(lifecycle.state).toEqual({ kind: "failed" });
        controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue(null);
        lifecycle.setEnabled(false);
        warn.mockClear();
      }
      let finishBuild: (() => void) | undefined;
      controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValue(
        new Promise((resolve) => {
          finishBuild = () => resolve({ ok: true, built: true, assets: readyAssets() });
        }),
      );
      if (initiallyFailed) {
        lifecycle.setEnabled(true);
      }
      const build = lifecycle.start();
      await vi.waitFor(() =>
        expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce(),
      );

      const stopped = lifecycle.stop();
      expect(
        controlUiAssetsMocks.ensureControlUiAssetsBuilt.mock.calls[0]?.[1].signal.aborted,
      ).toBe(true);
      finishBuild?.();
      await Promise.all([build, stopped]);

      expect(lifecycle.state).toEqual({ kind: "preparing" });
      expect(warn).not.toHaveBeenCalled();
      lifecycle.setEnabled(false);
      lifecycle.setEnabled(true);
      await lifecycle.start();
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    },
  );

  test("retires an interrupted build before preparing a re-enabled dashboard", async () => {
    let finishBuild!: () => void;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          finishBuild = () => resolve({ ok: true, built: true, assets: readyAssets() });
        }),
    );
    const { lifecycle, warn } = createLifecycle();
    const first = lifecycle.start();
    await vi.waitFor(() =>
      expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce(),
    );
    const signal = controlUiAssetsMocks.ensureControlUiAssetsBuilt.mock.calls[0]?.[1]?.signal;
    lifecycle.setEnabled(false);
    expect(signal.aborted).toBe(true);
    lifecycle.setEnabled(true);
    const second = lifecycle.start();
    expect(lifecycle.state).toEqual({ kind: "preparing" });

    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    finishBuild();
    await Promise.all([first, second]);
    expect(lifecycle.state).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
    await lifecycle.stop();
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
  });

  test("retries a failed preparation when the operator re-enables the dashboard", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValueOnce({
      ok: false,
      message: "build failed",
    });
    const { lifecycle } = createLifecycle();
    const rootReference = lifecycle.state;
    await lifecycle.start();
    expect(rootReference).toEqual({ kind: "failed" });

    lifecycle.setEnabled(false);
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    lifecycle.setEnabled(true);
    await lifecycle.start();
    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toMatchObject({ kind: "resolved", path: "/repo/dist/control-ui" });
    await lifecycle.stop();
  });
});
