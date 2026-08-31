/**
 * Tests QA runner runtime facade helpers.
 */
import path from "node:path";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QaRunnerCliRegistration } from "./qa-runner-runtime.js";
import {
  cleanupTempDirs,
  expectPrivateQaLabRuntimeSurfaceLoad,
  expectQaLabRuntimeSurfaceLoad,
  makePrivateQaSourceRoot,
  restorePrivateQaCliEnv,
} from "./qa-runtime.test-helpers.js";

const loadPluginManifestRegistryCore = vi.hoisted(() => vi.fn());
const loadBundledPluginManifestRegistry = vi.hoisted(() => vi.fn());
const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const tryLoadActivatedBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());
const resolveOpenClawPackageRootSync = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadBundledPluginManifestRegistry,
  loadPluginManifestRegistryCore,
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

function firstPublicSurfaceCall(): PublicSurfaceCall | undefined {
  return loadBundledPluginPublicSurfaceModuleSync.mock.calls[0]?.[0] as
    | PublicSurfaceCall
    | undefined;
}

describe("plugin-sdk qa-runner-runtime", () => {
  const tempDirs: string[] = [];
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
  const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

  beforeEach(() => {
    vi.resetModules();
    loadPluginManifestRegistryCore.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    loadBundledPluginManifestRegistry.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReset();
    resolveOpenClawPackageRootSync.mockReset().mockReturnValue(null);
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  });

  afterEach(() => {
    cleanupTempDirs(tempDirs);
    restorePrivateQaCliEnv(originalPrivateQaCli);
    if (originalBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
    }
  });

  it("exposes structured thread identity to transport delivery adapters", () => {
    type Adapter = Awaited<
      ReturnType<NonNullable<QaRunnerCliRegistration["adapterFactory"]>["create"]>
    >;
    const buildAgentDelivery: Adapter["buildAgentDelivery"] = ({ target, threadId }) => ({
      channel: "linked",
      replyChannel: "linked",
      replyTo: threadId ? `${target}:thread:${threadId}` : target,
    });

    expect(buildAgentDelivery({ target: "channel:room", threadId: "topic-1" }).replyTo).toBe(
      "channel:room:thread:topic-1",
    );
  });

  it("stays cold until runner discovery is requested", async () => {
    await import("./qa-runner-runtime.js");

    expect(loadPluginManifestRegistryCore).not.toHaveBeenCalled();
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
    const adapterFactory = {
      id: "example",
      isolatesInstances: true,
      supportsModuleFlows: true as const,
      matches: vi.fn(),
      create: vi.fn(),
    };
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "qa-example",
          origin: "bundled",
          qaRunners: [
            {
              commandName: "example",
              description: "Run the example live QA lane",
            },
          ],
          rootDir: "/tmp/qa-example",
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [{ commandName: "example", adapterFactory, register }],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-example",
        commandName: "example",
        description: "Run the example live QA lane",
        status: "available",
        registration: {
          commandName: "example",
          adapterFactory,
          register,
        },
      },
    ]);
    expect(loadBundledPluginPublicSurfaceModuleSync).toHaveBeenCalledWith({
      dirName: "qa-example",
      artifactBasename: "qa-runner-api.js",
    });
  });

  it("rejects invalid module-flow support metadata", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "qa-example",
          origin: "bundled",
          qaRunners: [{ commandName: "example" }],
          rootDir: "/tmp/qa-example",
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [
        {
          commandName: "example",
          adapterFactory: {
            id: "example",
            supportsModuleFlows: false,
            matches: vi.fn(),
            create: vi.fn(),
          },
          register: vi.fn(),
        },
      ],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(() => module.listQaRunnerCliContributions()).toThrow(
      'QA runner plugin "qa-example" exported an invalid transport factory for "example"',
    );
  });

  it("reports declared runners as blocked when the plugin is present but not activated", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "qa-example",
          origin: "workspace",
          qaRunners: [{ commandName: "example" }],
          rootDir: "/tmp/qa-example",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync.mockReturnValue(null);

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-example",
        commandName: "example",
        status: "blocked",
      },
    ]);
  });

  it("keeps shipped runtime-api runner contributions available for installed plugins", async () => {
    const register = vi.fn((qa: Command) => qa);
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "qa-legacy",
          origin: "global",
          qaRunners: [{ commandName: "legacy" }],
          rootDir: "/tmp/qa-legacy",
        },
      ],
      diagnostics: [],
    });
    tryLoadActivatedBundledPluginPublicSurfaceModuleSync
      .mockImplementationOnce(() => {
        throw new Error(
          "Unable to resolve bundled plugin public surface qa-legacy/qa-runner-api.js",
        );
      })
      .mockReturnValue({
        qaRunnerCliRegistrations: [{ commandName: "legacy", register }],
      });

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-legacy",
        commandName: "legacy",
        status: "available",
        registration: { commandName: "legacy", register },
      },
    ]);
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenNthCalledWith(1, {
      dirName: "qa-legacy",
      artifactBasename: "qa-runner-api.js",
    });
    expect(tryLoadActivatedBundledPluginPublicSurfaceModuleSync).toHaveBeenNthCalledWith(2, {
      dirName: "qa-legacy",
      artifactBasename: "runtime-api.js",
    });
  });

  it("prefers the source bundled tree for private qa discovery in repo checkouts", async () => {
    const sourceRoot = makePrivateQaSourceRoot(tempDirs, "openclaw-qa-runner-root-");
    resolveOpenClawPackageRootSync.mockReturnValue(sourceRoot);

    const register = vi.fn((qa: Command) => qa);
    const adapterFactory = { id: "example", matches: vi.fn(), create: vi.fn() };
    loadBundledPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "qa-example",
          origin: "bundled",
          qaRunners: [{ commandName: "example" }],
          rootDir: path.join(sourceRoot, "extensions", "qa-example"),
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [{ commandName: "example", adapterFactory, register }],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-example",
        commandName: "example",
        status: "available",
        registration: {
          commandName: "example",
          adapterFactory,
          register,
        },
      },
    ]);
    const manifestCall = loadBundledPluginManifestRegistry.mock.calls[0]?.[0] as
      | ManifestRegistryCall
      | undefined;
    expect(manifestCall?.env?.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(manifestCall?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe(
      path.join(sourceRoot, "extensions"),
    );

    const publicSurfaceCall = firstPublicSurfaceCall();
    expect(publicSurfaceCall?.dirName).toBe("qa-example");
    expect(publicSurfaceCall?.artifactBasename).toBe("qa-runner-api.js");
    expect(publicSurfaceCall?.env?.OPENCLAW_ENABLE_PRIVATE_QA_CLI).toBe("1");
    expect(publicSurfaceCall?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe(
      path.join(sourceRoot, "extensions"),
    );
  });

  it("fails fast when two plugins declare the same qa runner command", async () => {
    loadPluginManifestRegistryCore.mockReturnValue({
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
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [
        {
          id: "qa-example",
          origin: "bundled",
          qaRunners: [{ commandName: "example" }],
          rootDir: "/tmp/qa-example",
        },
      ],
      diagnostics: [],
    });
    loadBundledPluginPublicSurfaceModuleSync.mockReturnValue({
      qaRunnerCliRegistrations: [
        {
          commandName: "example",
          adapterFactory: { id: "example", matches: vi.fn(), create: vi.fn() },
          register: vi.fn(),
        },
        { commandName: "extra", register: vi.fn() },
      ],
    });

    const module = await import("./qa-runner-runtime.js");

    expect(() => module.listQaRunnerCliContributions()).toThrow(
      'QA runner plugin "qa-example" exported "extra" from its QA runner surface but did not declare it in openclaw.plugin.json',
    );
  });
});
