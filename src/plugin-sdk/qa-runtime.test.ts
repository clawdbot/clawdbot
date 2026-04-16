import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

describe("plugin-sdk qa-runtime", () => {
  const tempDirs: string[] = [];
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

  beforeEach(() => {
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    if (originalPrivateQaCli === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
    }
  });

  it("stays cold until the runtime seam is used", async () => {
    const module = await import("./qa-runtime.js");

    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(typeof module.loadQaRuntimeModule).toBe("function");
    expect(typeof module.isQaRuntimeAvailable).toBe("function");
  });

  it("loads the qa-lab runtime public surface through the generic seam", async () => {
    const runtimeSurface = {
      defaultQaRuntimeModelForMode: vi.fn(),
      startQaLiveLaneGateway: vi.fn(),
    };
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(runtimeSurface);

    const module = await import("./qa-runtime.js");

    expect(module.loadQaRuntimeModule()).toBe(runtimeSurface);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-lab",
      artifactBasename: "runtime-api.js",
    });
  });

  it("uses the source bundled tree for qa-lab runtime loading in private qa mode", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-runtime-root-"));
    tempDirs.push(sourceRoot);
    fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    resolveOpenClawPackageRootSync.mockReturnValue(sourceRoot);

    const runtimeSurface = {
      defaultQaRuntimeModelForMode: vi.fn(),
      startQaLiveLaneGateway: vi.fn(),
    };
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(runtimeSurface);

    const module = await import("./qa-runtime.js");

    expect(module.loadQaRuntimeModule()).toBe(runtimeSurface);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-lab",
      artifactBasename: "runtime-api.js",
      env: expect.objectContaining({
        OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sourceRoot, "extensions"),
      }),
    });
  });

  it("reports the runtime as unavailable when the qa-lab surface is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
    });

    const module = await import("./qa-runtime.js");

    expect(module.isQaRuntimeAvailable()).toBe(false);
  });
});
