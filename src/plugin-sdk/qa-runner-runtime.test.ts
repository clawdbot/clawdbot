import path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDirs,
  expectPrivateQaLabRuntimeSurfaceLoad,
  expectQaLabRuntimeSurfaceLoad,
  makePrivateQaSourceRoot,
  restorePrivateQaCliEnv,
} from "./qa-runtime.test-helpers.js";

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

type ManifestRegistryCall = { env?: NodeJS.ProcessEnv };
type PublicSurfaceCall = {
  artifactBasename?: string;
  dirName?: string;
  env?: NodeJS.ProcessEnv;
};

function firstManifestRegistryCall(): ManifestRegistryCall | undefined {
  return loadPluginManifestRegistry.mock.calls[0]?.[0] as ManifestRegistryCall | undefined;
}

function firstPublicSurfaceCall(): PublicSurfaceCall | undefined {
  return loadBundledPluginPublicSurfaceModuleSync.mock.calls[0]?.[0] as
    | PublicSurfaceCall
    | undefined;
}

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
    cleanupTempDirs(tempDirs);
    restorePrivateQaCliEnv(originalPrivateQaCli);
  });

  it("stays cold until runner discovery is requested", async () => {
    await import("./qa-runner-runtime.js");

    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
    expect(loadBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).not.toHaveBeenCalled();
  });

  it("loads the qa-lab runtime public surface through the public runner seam", async () => {
    await expectQaLabRuntimeSurfaceLoad({
      importRuntime: () => import("./qa-runner-runtime.js"),
      loadBundledPluginPublicSurfaceModuleSync,
    });
  });

  it("uses the source bundled tree for qa-lab runtime loading in private qa mode", async () => {
    await expectPrivateQaLabRuntimeSurfaceLoad({
      tempDirs,
      importRuntime: () => import("./qa-runner-runtime.js"),
      loadBundledPluginPublicSurfaceModuleSync,
      resolveOpenClawPackageRootSync,
    });
  });

  it("loads bundled plugin test APIs with the private QA source tree override", async () => {
    const sourceRoot = makePrivateQaSourceRoot(tempDirs, "openclaw-qa-test-api-root-");
    resolveOpenClawPackageRootSync.mockReturnValue(sourceRoot);

    const testApi = { marker: "matrix-test-api" };
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue(testApi);

    const module = await import("./qa-runner-runtime.js");

    expect(module.loadQaRunnerBundledPluginTestApi("matrix")).toBe(testApi);
    const testApiCall = firstPublicSurfaceCall();
    expect(testApiCall?.dirName).toBe("matrix");
    expect(testApiCall?.artifactBasename).toBe("test-api.js");
    expect(testApiCall?.env?.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(testApiCall?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe(
      path.join(sourceRoot, "extensions"),
    );
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
    const sourceRoot = makePrivateQaSourceRoot(tempDirs, "openclaw-qa-runner-root-");
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
    const manifestCall = firstManifestRegistryCall();
    expect(manifestCall?.env?.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(manifestCall?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe(
      path.join(sourceRoot, "extensions"),
    );

    const publicSurfaceCall = firstPublicSurfaceCall();
    expect(publicSurfaceCall?.dirName).toBe("qa-matrix");
    expect(publicSurfaceCall?.artifactBasename).toBe("runtime-api.js");
    expect(publicSurfaceCall?.env?.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(publicSurfaceCall?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe(
      path.join(sourceRoot, "extensions"),
    );
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
