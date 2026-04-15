import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("./facade-runtime.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
  tryLoadActivatedBundledPluginPublicSurfaceModuleSync,
}));

describe("plugin-sdk qa-runner-runtime", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("stays cold until runner discovery is requested", async () => {
    await import("./qa-runner-runtime.js");

    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
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
