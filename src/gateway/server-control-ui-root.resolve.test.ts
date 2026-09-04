/** Tests the Gateway-owned Control UI root and background asset lifecycle. */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const controlUiAssetsMocks = vi.hoisted(() => ({
  ensureControlUiAssetsBuilt: vi.fn(),
  isPackageProvenControlUiRootSync: vi.fn(),
  isControlUiStartupAssetsReady: vi.fn(),
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
vi.mock("./control-ui-asset-retention.js", () => ({
  createControlUiAssetRetention: vi.fn(() => retentionMocks),
}));

import { createGatewayControlUiRootLifecycle } from "./server-control-ui-root.js";

describe("createGatewayControlUiRootLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "realpathSync").mockImplementation((rootPath) => String(rootPath));
    vi.spyOn(fs, "readFileSync").mockReturnValue("<html></html>");
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: true,
      built: false,
    });
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(false);
    controlUiAssetsMocks.isControlUiStartupAssetsReady.mockReturnValue(true);
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
    const controller = new AbortController();
    const isStopped = () => false;
    await lifecycle.start(isStopped, controller.signal);

    expect(retentionMocks.prepare).toHaveBeenCalledWith({
      isCancelled: isStopped,
      signal: controller.signal,
    });
  });

  test("snapshots public asset identity only for a bundled root", () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      '<html data-openclaw-control-ui-build-id="build-content-digest"></html>',
    );
    const { lifecycle } = createLifecycle();
    expect(lifecycle.state).toMatchObject({
      kind: "bundled",
      publicAssetBuildId: "build-content-digest",
    });
    expect(fs.readFileSync).toHaveBeenCalledExactlyOnceWith(
      "/repo/dist/control-ui/index.html",
      "utf8",
    );
    vi.mocked(fs.readFileSync).mockClear();
    controlUiAssetsMocks.resolveControlUiRootOverrideSync.mockReturnValue("/repo/dist/control-ui");
    const custom = createLifecycle({ override: "/repo/dist/control-ui" });
    expect(custom.lifecycle.state).not.toHaveProperty("publicAssetBuildId");
    expect(fs.readFileSync).not.toHaveBeenCalled();
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
    const controller = new AbortController();

    const preparing = lifecycle.start(() => controller.signal.aborted, controller.signal);
    controller.abort();
    await Promise.all([preparing, lifecycle.stop()]);

    expect(warn).not.toHaveBeenCalled();
  });

  test("rebuilds incomplete auto-discovered roots before publishing them", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/repo/dist/control-ui");
    controlUiAssetsMocks.isControlUiStartupAssetsReady
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    controlUiAssetsMocks.isPackageProvenControlUiRootSync.mockReturnValue(true);
    const { lifecycle } = createLifecycle();
    const rootReference = lifecycle.state;

    expect(rootReference).toEqual({ kind: "preparing" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    await lifecycle.start(() => false, new AbortController().signal);

    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toEqual({
      kind: "bundled",
      path: "/repo/dist/control-ui",
      realPath: "/repo/dist/control-ui",
      retainedAssets: retentionMocks,
    });
    expect(controlUiAssetsMocks.isControlUiStartupAssetsReady).toHaveBeenCalledTimes(2);
    expect(retentionMocks.prepare).toHaveBeenCalledOnce();
  });

  test("keeps corrupt packaged Resources terminal when another dist build is healthy", async () => {
    controlUiAssetsMocks.resolveControlUiRootSync.mockReturnValue("/App/Resources/control-ui");
    controlUiAssetsMocks.isControlUiStartupAssetsReady.mockReturnValue(false);
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true, built: false });
    const { lifecycle, warn } = createLifecycle();

    expect(lifecycle.state).toEqual({ kind: "preparing" });
    await lifecycle.start(() => false, new AbortController().signal);

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith(
      "gateway: Control UI assets at /App/Resources/control-ui remain incomplete. Run `openclaw doctor --fix` or reinstall OpenClaw.",
    );
  });

  test("starts only after scheduling and promotes the same root reference once", async () => {
    let finishBuild: (() => void) | undefined;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValue(
      new Promise((resolve) => {
        finishBuild = () => resolve({ ok: true, built: true });
      }),
    );
    const { lifecycle, gatewayRuntime, warn } = createLifecycle();
    const rootReference = lifecycle.state;
    const controller = new AbortController();

    expect(rootReference).toEqual({ kind: "preparing" });
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();

    const build = lifecycle.start(() => false, controller.signal);
    expect(lifecycle.start(() => false, controller.signal)).toBe(build);
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledOnce();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).toHaveBeenCalledWith(gatewayRuntime, {
      signal: controller.signal,
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
    expect(controlUiAssetsMocks.isControlUiStartupAssetsReady).not.toHaveBeenCalled();
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

  test("does not prepare disabled Control UI assets", () => {
    const { lifecycle } = createLifecycle({ enabled: false });

    expect(lifecycle.state).toBeUndefined();
    expect(controlUiAssetsMocks.resolveControlUiRootSync).not.toHaveBeenCalled();
    expect(controlUiAssetsMocks.ensureControlUiAssetsBuilt).not.toHaveBeenCalled();
  });

  test("publishes structured build failures into the existing root reference", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({
      ok: false,
      built: false,
      message: "Control UI build timed out.",
    });
    const { lifecycle, warn } = createLifecycle();
    const rootReference = lifecycle.state;

    await lifecycle.start(() => false, new AbortController().signal);

    expect(lifecycle.state).toBe(rootReference);
    expect(rootReference).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith("gateway: Control UI build timed out.");
  });

  test("publishes rejected builds as actionable terminal failures", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockRejectedValue(new Error("spawn failed"));
    const { lifecycle, warn } = createLifecycle();

    await lifecycle.start(() => false, new AbortController().signal);

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith("gateway: Control UI assets build failed: spawn failed");
  });

  test("does not publish a late build result after its Gateway generation stops", async () => {
    let finishBuild: (() => void) | undefined;
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockReturnValue(
      new Promise((resolve) => {
        finishBuild = () => resolve({ ok: true, built: true });
      }),
    );
    const { lifecycle, warn } = createLifecycle();
    const controller = new AbortController();
    const build = lifecycle.start(() => false, controller.signal);

    controller.abort();
    const stopped = lifecycle.stop();
    finishBuild?.();
    await Promise.all([build, stopped]);

    expect(lifecycle.state).toEqual({ kind: "preparing" });
    expect(warn).not.toHaveBeenCalled();
  });

  test("fails when a successful build still cannot resolve an effective root", async () => {
    controlUiAssetsMocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true, built: true });
    const { lifecycle, warn } = createLifecycle();

    await lifecycle.start(() => false, new AbortController().signal);

    expect(lifecycle.state).toEqual({ kind: "failed" });
    expect(warn).toHaveBeenCalledWith(
      "gateway: Control UI build completed, but its assets are still unavailable. Run `openclaw doctor --fix` or reinstall OpenClaw.",
    );
  });
});
