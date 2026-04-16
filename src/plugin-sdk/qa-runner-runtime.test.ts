import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync,
}));

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin-sdk qa-runner-runtime", () => {
  const tempDirs: string[] = [];
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

  beforeEach(() => {
    loadPluginManifestRegistry.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
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

  it("stays cold until runner discovery is requested", async () => {
    await import("./qa-runner-runtime.js");

    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("loads the qa-lab runtime public surface through the public runner seam", async () => {
    const runtimeSurface = {
      defaultQaRuntimeModelForMode: vi.fn(),
      startQaLiveLaneGateway: vi.fn(),
    };
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(runtimeSurface);

    const module = await import("./qa-runner-runtime.js");

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

    const module = await import("./qa-runner-runtime.js");

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

  it("reports the qa runtime as unavailable when the qa-lab surface is missing", async () => {
    loadBundledPluginPublicSurfaceModuleSync.mockImplementation(() => {
      throw new Error("Unable to resolve bundled plugin public surface qa-lab/runtime-api.js");
    });

    const module = await import("./qa-runner-runtime.js");

    expect(module.isQaRuntimeAvailable()).toBe(false);
  });

  it("returns activated runner registrations declared in plugin manifests", async () => {
    const register = vi.fn((qa: Command) => qa);
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          origin: "bundled",
          qaRunners: [
            {
              commandName: "matrix",
              description: "Run the Matrix live QA lane",
            },
          ],
          rootDir: "/tmp/qa-matrix",
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [{ commandName: "matrix", register }],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        description: "Run the Matrix live QA lane",
        status: "available",
        registration: {
          commandName: "matrix",
          register,
        },
      },
    ]);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-matrix",
      artifactBasename: "runtime-api.js",
    });
  });

  it("reports declared runners as blocked when the plugin is present but not activated", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          origin: "workspace",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/qa-matrix",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        status: "blocked",
      },
    ]);
  });

  it("prefers the source bundled tree for private qa discovery in repo checkouts", async () => {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-runner-root-"));
    tempDirs.push(sourceRoot);
    fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
    resolveOpenClawPackageRootSync.mockReturnValue(sourceRoot);

    const register = vi.fn((qa: Command) => qa);
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          origin: "bundled",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: path.join(sourceRoot, "extensions", "qa-matrix"),
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [{ commandName: "matrix", register }],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-matrix",
        commandName: "matrix",
        status: "available",
        registration: {
          commandName: "matrix",
          register,
        },
      },
    ]);
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      cache: true,
      env: expect.objectContaining({
        OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sourceRoot, "extensions"),
      }),
    });
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-matrix",
      artifactBasename: "runtime-api.js",
      env: expect.objectContaining({
        OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(sourceRoot, "extensions"),
      }),
    });
  });

  it("fails fast when two plugins declare the same qa runner command", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "alpha",
          origin: "workspace",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/alpha",
        },
        {
          id: "beta",
          origin: "workspace",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/beta",
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

    const module = await import("./qa-runner-runtime.js");

    expect(() => module.listQaRunnerCliContributions()).toThrow(
      'QA runner command "matrix" declared by both "alpha" and "beta"',
    );
  });

  it("fails when runtime registrations include an undeclared command", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-matrix",
          origin: "bundled",
          qaRunners: [{ commandName: "matrix" }],
          rootDir: "/tmp/qa-matrix",
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [
        { commandName: "matrix", register: vi.fn() },
        { commandName: "extra", register: vi.fn() },
      ],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(() => module.listQaRunnerCliContributions()).toThrow(
      'QA runner plugin "qa-matrix" exported "extra" from runtime-api.js but did not declare it in openclaw.plugin.json',
    );
  });
});
