// Verifies plugin public surface loading and fallback behavior.
import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const tempDirs = createTempDirTracker();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

function captureThrownError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected function to throw");
}
afterEach(() => {
  tempDirs.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("./bundled-dir.js");
  vi.doUnmock("./native-module-require.js");
  vi.doUnmock("./public-surface-runtime.js");
  vi.doUnmock("node:module");
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalTrustBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
  }
});

describe("bundled plugin public surface loader", () => {
  it("keeps auto-resolved bundled roots on built public artifacts", async () => {
    // The non-isolated plugin shard may have already imported the native loader.
    vi.resetModules();
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist", "extensions");
    const modulePath = path.join(bundledPluginsDir, "demo", "provider-policy-api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "built";\n', "utf8");

    const resolveBundledPluginPublicSurfacePath = vi.fn(() => modulePath);
    vi.doMock("./bundled-dir.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./bundled-dir.js")>();
      return {
        ...actual,
        resolveBundledPluginsDir: () => bundledPluginsDir,
      };
    });
    vi.doMock("./public-surface-runtime.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./public-surface-runtime.js")>();
      return {
        ...actual,
        resolveBundledPluginPublicSurfacePath,
      };
    });
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: (target: string) => ({
        ok: true,
        moduleExport: { marker: path.basename(path.dirname(target)) },
      }),
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=auto-bundled-built-artifacts");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "provider-policy-api.js",
      }).marker,
    ).toBe("demo");
    expect(resolveBundledPluginPublicSurfacePath).toHaveBeenCalledWith(
      expect.objectContaining({
        bundledPluginsDir,
        bundledPluginsDirMode: "explicit",
      }),
    );
  });

  it("uses native require for Windows dist public artifact loads", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "windows-dist-ok" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: () => ({
        ok: true,
        moduleExport: { marker: "windows-dist-ok" },
      }),
    }));

    await withMockedWindowsPlatform(async () => {
      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(import.meta.url, "./public-surface-loader.js?scope=windows-dist-jiti");
      const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
      const bundledPluginsDir = path.join(tempRoot, "dist");
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

      const modulePath = path.join(bundledPluginsDir, "demo", "provider-policy-api.js");
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(modulePath, 'export const marker = "windows-dist-ok";\n', "utf8");

      expect(
        publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "provider-policy-api.js",
        }).marker,
      ).toBe("windows-dist-ok");
      expect(createJiti).not.toHaveBeenCalled();
    });
  });

  it("prefers source require for bundled source public artifacts when a ts require hook exists", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "jiti-should-not-run" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const requireLoader = Object.assign(
      vi.fn(() => ({ marker: "source-require-ok" })),
      {
        extensions: {
          ".ts": vi.fn(),
        },
      },
    );
    vi.doMock("node:module", async () => {
      const actual = await vi.importActual<typeof import("node:module")>("node:module");
      return Object.assign({}, actual, {
        createRequire: vi.fn(() => requireLoader),
      });
    });

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=source-require-fast-path");
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "extensions");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const modulePath = path.join(bundledPluginsDir, "demo", "secret-contract-api.ts");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "source-require-ok";\n', "utf8");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "secret-contract-api.js",
      }).marker,
    ).toBe("source-require-ok");
    expect(requireLoader).toHaveBeenCalledWith(fs.realpathSync(modulePath));
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("keeps bundled dist public artifacts on the native path", async () => {
    const createJiti = vi.fn(() => vi.fn((modulePath: string) => ({ modulePath })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: (modulePath: string) => ({
        ok: true,
        moduleExport: { marker: path.basename(path.dirname(modulePath)) },
      }),
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=bundled-native-public-artifacts");
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    fs.mkdirSync(bundledPluginsDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const firstPath = path.join(bundledPluginsDir, "demo-a", "api.js");
    const secondPath = path.join(bundledPluginsDir, "demo-b", "api.js");
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    fs.writeFileSync(firstPath, 'export const marker = "demo-a";\n', "utf8");
    fs.writeFileSync(secondPath, 'export const marker = "demo-b";\n', "utf8");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo-a",
        artifactBasename: "api.js",
      }).marker,
    ).toBe("demo-a");
    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo-b",
        artifactBasename: "api.js",
      }).marker,
    ).toBe("demo-b");

    expect(createJiti).not.toHaveBeenCalled();
  });

  it("keeps package-local dist public artifacts on the native path for source plugin roots", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "jiti-should-not-run" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: (modulePath: string) => ({
        ok: true,
        moduleExport: {
          marker: modulePath.includes(`${path.sep}dist${path.sep}`) ? "dist" : "source",
        },
      }),
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=source-root-local-dist-public-artifacts");
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "extensions");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const sourcePath = path.join(bundledPluginsDir, "demo", "api.ts");
    const distPath = path.join(bundledPluginsDir, "demo", "dist", "api.js");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(distPath), { recursive: true });
    fs.writeFileSync(sourcePath, 'export const marker = "source";\n', "utf8");
    fs.writeFileSync(distPath, 'export const marker = "dist";\n', "utf8");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "api.js",
      }).marker,
    ).toBe("dist");
    expect(createJiti).not.toHaveBeenCalled();
  });

  it.each([
    { firstLocation: "root", nextLocation: "dist" },
    { firstLocation: "dist", nextLocation: "root" },
  ] as const)(
    "refreshes native ESM artifact locations from $firstLocation to $nextLocation with plugin metadata",
    async ({ firstLocation, nextLocation }) => {
      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(
        import.meta.url,
        `./public-surface-loader.js?scope=esm-artifact-relocation-${firstLocation}-${nextLocation}`,
      );
      const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
      const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
      const bundledPluginsDir = path.join(tempRoot, "extensions");
      const pluginDir = path.join(bundledPluginsDir, "demo");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"module"}\n', "utf8");
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

      const artifactPath = (location: "root" | "dist") =>
        path.join(pluginDir, ...(location === "dist" ? ["dist"] : []), "api.js");
      const writeArtifact = (location: "root" | "dist") => {
        const modulePath = artifactPath(location);
        fs.mkdirSync(path.dirname(modulePath), { recursive: true });
        fs.writeFileSync(
          modulePath,
          `export const marker = ${JSON.stringify(location)};\n`,
          "utf8",
        );
      };
      const loadArtifact = () =>
        publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "api.js",
        }).marker;

      writeArtifact(firstLocation);
      expect(loadArtifact()).toBe(firstLocation);

      fs.unlinkSync(artifactPath(firstLocation));
      writeArtifact(nextLocation);
      expect(loadArtifact()).toBe(firstLocation);

      clearPluginMetadataLifecycleCaches();

      expect(loadArtifact()).toBe(nextLocation);
    },
  );

  it("reloads a replaced installed public artifact and its dependencies after plugin metadata changes", async () => {
    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=installed-artifact-replacement");
    const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
    const tempRoot = fs.realpathSync(tempDirs.make("openclaw-public-surface-replacement-"));
    const pluginRoot = path.join(tempRoot, "installed-plugin");
    const modulePath = path.join(pluginRoot, "api.js");
    const dependencyPath = path.join(pluginRoot, "dependency.js");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n', "utf8");

    const writeArtifact = (marker: string) => {
      fs.writeFileSync(dependencyPath, `module.exports = ${JSON.stringify(marker)};\n`, "utf8");
      fs.writeFileSync(modulePath, 'module.exports = { marker: require("./dependency.js") };\n');
    };
    const loadArtifact = () =>
      publicSurfaceLoader.loadPluginPublicArtifactModuleSync<{ marker: string }>({
        pluginRoot,
        artifactBasename: "api.js",
      }).marker;

    writeArtifact("retired");
    expect(loadArtifact()).toBe("retired");

    writeArtifact("replacement");
    expect(loadArtifact()).toBe("retired");

    clearPluginMetadataLifecycleCaches();

    expect(loadArtifact()).toBe("replacement");
  });

  it.runIf(process.platform !== "win32")(
    "allows hardlinked bundled public artifacts under the trusted bundled root",
    async () => {
      vi.doMock("./native-module-require.js", () => ({
        tryNativeRequireJavaScriptModule: (modulePath: string) => ({
          ok: true,
          moduleExport: { marker: path.basename(path.dirname(modulePath)) },
        }),
      }));

      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(import.meta.url, "./public-surface-loader.js?scope=bundled-hardlink-public-artifacts");
      const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
      const bundledPluginsDir = path.join(tempRoot, "dist");
      const sourcePath = path.join(tempRoot, "api-source.js");
      const modulePath = path.join(bundledPluginsDir, "demo", "api.js");
      fs.mkdirSync(path.dirname(modulePath), { recursive: true });
      fs.writeFileSync(sourcePath, 'export const marker = "demo";\n', "utf8");
      fs.linkSync(sourcePath, modulePath);
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

      expect(
        publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "api.js",
        }).marker,
      ).toBe("demo");
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each(["provider-policy-api.js", "api.js", "runtime-api.js"])(
    "rejects installed plugin public artifact %s hardlinked outside its root",
    async (artifact) => {
      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(
        import.meta.url,
        `./public-surface-loader.js?scope=installed-hardlink-${artifact.replace(".js", "")}`,
      );
      const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
      const pluginRoot = path.join(tempRoot, "installed-plugin");
      const outsidePath = path.join(tempRoot, "outside.js");
      const artifactPath = path.join(pluginRoot, artifact);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(outsidePath, 'export const marker = "outside-plugin-root";\n', "utf8");
      fs.linkSync(outsidePath, artifactPath);

      expect(fs.statSync(artifactPath).nlink).toBeGreaterThan(1);
      expect(() =>
        publicSurfaceLoader.loadPluginPublicArtifactModuleSync({
          pluginRoot,
          artifactBasename: artifact,
        }),
      ).toThrow(`Unable to open plugin public surface ${artifact}`);
    },
  );

  it("does not cache missing public artifact locations", async () => {
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: (modulePath: string) => ({
        ok: true,
        moduleExport: { marker: path.basename(path.dirname(modulePath)) },
      }),
    }));

    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    fs.mkdirSync(bundledPluginsDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=missing-location-retry");

    const missingError = captureThrownError(() =>
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync({
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    );
    expect(missingError.message).toBe(
      "Unable to resolve bundled plugin public surface demo/api.js",
    );

    const modulePath = path.join(bundledPluginsDir, "demo", "api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "demo";\n', "utf8");

    expect(
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "api.js",
      }).marker,
    ).toBe("demo");
  });

  it("rejects public artifacts that change after boundary validation", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ marker: "should-not-load" })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=post-validation-identity");
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const modulePath = path.join(bundledPluginsDir, "demo", "api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "demo";\n', "utf8");

    const realStatSync = fs.statSync.bind(fs);
    const moduleRealPath = fs.realpathSync(modulePath);
    vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      const stat = realStatSync(target, options);
      if (stat === undefined) {
        return stat;
      }
      if (fs.realpathSync(target) !== moduleRealPath) {
        return stat;
      }
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        ino: Number(stat.ino) + 1,
      });
    });

    expect(() =>
      publicSurfaceLoader.loadBundledPluginPublicArtifactModuleSync<{ marker: string }>({
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toThrow(/changed after validation/);
    expect(createJiti).not.toHaveBeenCalled();
  });

  it("skips missing surfaces in candidate fallback", async () => {
    const fresh = await importFreshModule<typeof import("./public-surface-loader.js")>(
      import.meta.url,
      "./public-surface-loader.js?scope=candidate-catcher-instanceof",
    );
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    fs.mkdirSync(bundledPluginsDir, { recursive: true });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const result = fresh.loadBundledPluginPublicArtifactModuleFromCandidatesSync<{
      marker: string;
    }>({
      dirName: "missing-plugin",
      artifactCandidates: ["api.js", "runtime-api.js"],
    });
    expect(result).toBeNull();
  });

  it("loads the next candidate when the first surface is missing", async () => {
    const fresh = await importFreshModule<typeof import("./public-surface-loader.js")>(
      import.meta.url,
      "./public-surface-loader.js?scope=candidate-fallback-success",
    );
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    const pluginDir = path.join(bundledPluginsDir, "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "runtime-api.js"),
      'export const marker = "runtime-fallback";\n',
      "utf8",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const result = fresh.loadBundledPluginPublicArtifactModuleFromCandidatesSync<{
      marker: string;
    }>({
      dirName: "demo",
      artifactCandidates: ["api.js", "runtime-api.js"],
    });

    expect(result?.marker).toBe("runtime-fallback");
  });

  it("re-throws generic candidate load errors with the legacy missing prefix", async () => {
    const fresh = await importFreshModule<typeof import("./public-surface-loader.js")>(
      import.meta.url,
      "./public-surface-loader.js?scope=candidate-catcher-generic-error",
    );
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    const pluginDir = path.join(bundledPluginsDir, "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "api.cjs"),
      'throw new Error("Unable to resolve bundled plugin public surface synthetic loader failure");\n',
      "utf8",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const error = captureThrownError(() =>
      fresh.loadBundledPluginPublicArtifactModuleFromCandidatesSync({
        dirName: "demo",
        artifactCandidates: ["api.js", "runtime-api.js"],
      }),
    );
    expect(error.message).toBe(
      "Unable to resolve bundled plugin public surface synthetic loader failure",
    );
  });

  it("re-throws typed missing errors raised while loading a resolved candidate", async () => {
    const nestedError = new MissingPublicSurfaceError("nested public surface is missing");
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: () => {
        throw nestedError;
      },
    }));
    const fresh = await importFreshModule<typeof import("./public-surface-loader.js")>(
      import.meta.url,
      "./public-surface-loader.js?scope=candidate-catcher-nested-missing-error",
    );
    const tempRoot = tempDirs.make("openclaw-public-surface-loader-");
    const bundledPluginsDir = path.join(tempRoot, "dist");
    const modulePath = path.join(bundledPluginsDir, "demo", "api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "demo";\n', "utf8");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    const error = captureThrownError(() =>
      fresh.loadBundledPluginPublicArtifactModuleFromCandidatesSync({
        dirName: "demo",
        artifactCandidates: ["api.js", "runtime-api.js"],
      }),
    );
    expect(error).toBe(nestedError);
  });
});
