import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-public-surface-loader-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("./native-module-require.js");
  vi.doUnmock("node:module");
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("bundled plugin public surface loader", () => {
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
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.resetModules();

    try {
      const publicSurfaceLoader = await importFreshModule<
        typeof import("./public-surface-loader.js")
      >(import.meta.url, "./public-surface-loader.js?scope=windows-dist-jiti");
      const tempRoot = createTempDir();
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
    } finally {
      platformSpy.mockRestore();
    }
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
    vi.resetModules();

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=source-require-fast-path");
    const tempRoot = createTempDir();
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
    vi.resetModules();

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=bundled-native-public-artifacts");
    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

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

  it("does not cache missing public artifact locations", async () => {
    vi.doMock("./native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: (modulePath: string) => ({
        ok: true,
        moduleExport: { marker: path.basename(path.dirname(modulePath)) },
      }),
    }));
    vi.resetModules();

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=missing-location-retry");
    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    expect(
      publicSurfaceLoader.resolveBundledPluginPublicArtifactPath({
        dirName: "demo",
        artifactBasename: "api.js",
      }),
    ).toBeNull();

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
    vi.resetModules();

    const publicSurfaceLoader = await importFreshModule<
      typeof import("./public-surface-loader.js")
    >(import.meta.url, "./public-surface-loader.js?scope=post-validation-identity");
    const tempRoot = createTempDir();
    const bundledPluginsDir = path.join(tempRoot, "dist");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const modulePath = path.join(bundledPluginsDir, "demo", "api.js");
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, 'export const marker = "demo";\n', "utf8");

    const realStatSync = fs.statSync.bind(fs);
    const moduleRealPath = fs.realpathSync(modulePath);
    vi.spyOn(fs, "statSync").mockImplementation((target, options) => {
      const stat = realStatSync(target, options);
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
});
