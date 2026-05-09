import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { setBundledPluginsDirOverrideForTest } from "../plugins/bundled-dir.js";
import { createPluginActivationSource, normalizePluginsConfig } from "../plugins/config-state.js";
import {
  evaluateBundledPluginPublicSurfaceAccess,
  resolveBundledPluginPublicSurfaceAccess as resolveActivationCheckBundledPluginPublicSurfaceAccess,
  throwForBundledPluginPublicSurfaceAccess,
} from "./facade-activation-check.runtime.js";
import {
  __testing,
  listImportedBundledPluginFacadeIds,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeRuntimeStateForTest,
} from "./facade-runtime.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const trustedBundledFixturesRoot = path.resolve("dist-runtime", "extensions");
const trustedBundledFixtureDirs: string[] = [];

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createTrustedBundledFixtureRoot(prefix: string): string {
  fs.mkdirSync(trustedBundledFixturesRoot, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(trustedBundledFixturesRoot, `.${prefix}`));
  trustedBundledFixtureDirs.push(rootDir);
  return rootDir;
}

function writePluginPackageJson(
  pluginDir: string,
  name = "demo",
  type: "commonjs" | "module" = "module",
): void {
  writeJsonFile(path.join(pluginDir, "package.json"), {
    name: `@openclaw/plugin-${name}`,
    version: "0.0.0",
    type,
  });
}

function createBundledPluginDir(prefix: string, marker: string): string {
  const rootDir = createTrustedBundledFixtureRoot(prefix);
  const pluginDir = path.join(rootDir, "demo");
  fs.mkdirSync(pluginDir, { recursive: true });
  writePluginPackageJson(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "api.js"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    "utf8",
  );
  return rootDir;
}

function useBundledPluginDirOverrideForTest(dir: string): void {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
  setBundledPluginsDirOverrideForTest(dir);
}

function createThrowingPluginDir(prefix: string): string {
  const rootDir = createTrustedBundledFixtureRoot(prefix);
  const pluginDir = path.join(rootDir, "bad");
  fs.mkdirSync(pluginDir, { recursive: true });
  writePluginPackageJson(pluginDir, "bad", "commonjs");
  fs.writeFileSync(
    path.join(pluginDir, "api.js"),
    `throw new Error("plugin load failure");\n`,
    "utf8",
  );
  return rootDir;
}

beforeEach(() => {
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  delete process.env.OPENCLAW_STATE_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of trustedBundledFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  clearRuntimeConfigSnapshot();
  resetFacadeRuntimeStateForTest();
  setBundledPluginsDirOverrideForTest(undefined);
  vi.doUnmock("../plugins/manifest-registry.js");
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalDisableBundledPlugins === undefined) {
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  } else {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = originalDisableBundledPlugins;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("plugin-sdk facade runtime", () => {
  it("honors trusted bundled plugin dir overrides", () => {
    const overrideA = createBundledPluginDir("openclaw-facade-runtime-a-", "override-a");
    const overrideB = createBundledPluginDir("openclaw-facade-runtime-b-", "override-b");

    useBundledPluginDirOverrideForTest(overrideA);
    const fromA = __testing.resolveFacadeModuleLocation({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromA).toEqual({
      modulePath: path.join(overrideA, "demo", "api.js"),
      boundaryRoot: overrideA,
    });

    useBundledPluginDirOverrideForTest(overrideB);
    const fromB = __testing.resolveFacadeModuleLocation({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromB).toEqual({
      modulePath: path.join(overrideB, "demo", "api.js"),
      boundaryRoot: overrideB,
    });
  });

  it("falls back to package source surfaces when an override dir is partial", () => {
    const overrideDir = createTrustedBundledFixtureRoot("openclaw-facade-runtime-empty-");
    useBundledPluginDirOverrideForTest(overrideDir);

    const resolved = __testing.resolveFacadeModuleLocation({
      dirName: "browser",
      artifactBasename: "browser-maintenance.js",
    });

    expect(resolved?.boundaryRoot).not.toBe(overrideDir);
    expect(resolved?.modulePath).toMatch(
      /(?:^|\/)(?:extensions|dist-runtime\/extensions)\/browser\/browser-maintenance\.(?:ts|js)$/u,
    );
  });

  it("does not fall back to package source surfaces when bundled plugins are disabled", () => {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    expect(
      __testing.resolveFacadeModuleLocation({
        dirName: "browser",
        artifactBasename: "browser-maintenance.js",
      }),
    ).toBeNull();
  });

  it("returns the same object identity on repeated calls (sentinel consistency)", () => {
    const dir = createBundledPluginDir("openclaw-facade-identity-", "identity-check");
    useBundledPluginDirOverrideForTest(dir);
    const location = {
      modulePath: path.join(dir, "demo", "api.js"),
      boundaryRoot: dir,
    };
    const loader = vi.fn(() => ({ marker: "identity-check" }));

    const first = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      location,
      trackedPluginId: "demo",
      loadModule: loader,
    });
    const second = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      location,
      trackedPluginId: "demo",
      loadModule: loader,
    });
    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const dir = createBundledPluginDir("openclaw-facade-circular-", "circular-ok");
    const location = {
      modulePath: path.join(dir, "demo", "api.js"),
      boundaryRoot: dir,
    };
    let reentered: { marker?: string } | undefined;
    const loader = vi.fn(() => {
      reentered = __testing.loadFacadeModuleAtLocationSync<{ marker?: string }>({
        location,
        trackedPluginId: "demo",
        loadModule: loader,
      });
      return { marker: "circular-ok" };
    });

    const loaded = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      location,
      trackedPluginId: "demo",
      loadModule: loader,
    });

    expect(loaded.marker).toBe("circular-ok");
    expect(reentered).toBe(loaded);
    expect(reentered?.marker).toBe("circular-ok");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("back-fills the sentinel before post-load facade tracking re-enters", () => {
    const dir = createBundledPluginDir("openclaw-facade-post-load-", "post-load-ok");
    const location = {
      modulePath: path.join(dir, "demo", "api.js"),
      boundaryRoot: dir,
    };
    const reentryMarkers: Array<string | undefined> = [];
    const loader = vi.fn(() => ({ marker: "post-load-ok" }));

    const loaded = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      location,
      trackedPluginId: () => {
        const reentered = __testing.loadFacadeModuleAtLocationSync<{ marker?: string }>({
          location,
          trackedPluginId: "demo",
          loadModule: loader,
        });
        reentryMarkers.push(reentered.marker);
        return "demo";
      },
      loadModule: loader,
    });

    expect(loaded.marker).toBe("post-load-ok");
    expect(reentryMarkers.length).toBeGreaterThan(0);
    const unexpectedReentryMarkers = reentryMarkers.filter((marker) => marker !== "post-load-ok");
    expect(unexpectedReentryMarkers).toStrictEqual([]);
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("clears the cache on load failure so retries re-execute", () => {
    const dir = createThrowingPluginDir("openclaw-facade-throw-");
    useBundledPluginDirOverrideForTest(dir);

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");

    expect(listImportedBundledPluginFacadeIds()).toStrictEqual([]);

    // A second call must also throw (not return a stale empty sentinel).
    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");
  });

  it("blocks runtime-api facade loads for bundled plugins that are not activated", () => {
    const access = evaluateBundledPluginPublicSurfaceAccess({
      params: {
        dirName: "discord",
        artifactBasename: "runtime-api.js",
      },
      manifestRecord: {
        id: "discord",
        origin: "bundled",
        enabledByDefault: false,
        rootDir: "/tmp/discord",
        channels: ["discord"],
      },
      config: {},
      normalizedPluginsConfig: normalizePluginsConfig(),
      activationSource: createPluginActivationSource({ config: {} }),
      autoEnabledReasons: {},
    });

    expect(access.allowed).toBe(false);
    expect(access.pluginId).toBe("discord");
    expect(access.reason).toMatch(/disabled|not enabled|not active/i);
    expect(() =>
      throwForBundledPluginPublicSurfaceAccess({
        access,
        request: {
          dirName: "discord",
          artifactBasename: "runtime-api.js",
        },
      }),
    ).toThrow(/Bundled plugin public surface access blocked/);
    expect(access.allowed).toBe(false);
  });

  it("allows runtime-api facade loads when the bundled plugin is explicitly enabled", () => {
    const dir = createTempDirSync("openclaw-facade-runtime-enabled-");
    fs.mkdirSync(path.join(dir, "discord"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "discord", "runtime-api.js"),
      'export const marker = "runtime-api-enabled";\n',
      "utf8",
    );
    const config = {
      plugins: {
        entries: {
          discord: {
            enabled: true,
          },
        },
      },
    } as const;
    const access = evaluateBundledPluginPublicSurfaceAccess({
      params: {
        dirName: "discord",
        artifactBasename: "runtime-api.js",
      },
      manifestRecord: {
        id: "discord",
        origin: "bundled",
        enabledByDefault: false,
        rootDir: "/tmp/discord",
        channels: ["discord"],
      },
      config,
      normalizedPluginsConfig: normalizePluginsConfig(config.plugins),
      activationSource: createPluginActivationSource({ config }),
      autoEnabledReasons: {},
    });
    const loader = vi.fn(() => ({ marker: "runtime-api-enabled" }));
    const location = {
      modulePath: path.join(dir, "discord", "runtime-api.js"),
      boundaryRoot: dir,
    };

    expect(access.allowed).toBe(true);
    const loaded = __testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
      location,
      trackedPluginId: "discord",
      loadModule: loader,
    });
    expect(loaded.marker).toBe("runtime-api-enabled");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("resolves a globally-installed plugin whose rootDir basename matches the dirName", () => {
    const lineDir = createTempDirSync("openclaw-facade-global-line-");
    fs.mkdirSync(lineDir, { recursive: true });
    fs.writeFileSync(
      path.join(lineDir, "runtime-api.js"),
      'export const marker = "global-line";\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(lineDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/line",
        version: "0.0.0",
        openclaw: {
          extensions: ["./runtime-api.js"],
          channel: { id: "line" },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(lineDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "line",
        channels: ["line"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );

    expect(
      __testing.resolveRegistryPluginModuleLocationFromRegistry({
        registry: [
          {
            id: "line",
            rootDir: lineDir,
            channels: ["line"],
          },
        ],
        dirName: "line",
        artifactBasename: "runtime-api.js",
      }),
    ).toEqual({
      modulePath: path.join(lineDir, "runtime-api.js"),
      boundaryRoot: lineDir,
    });
  });

  it("resolves a globally-installed plugin with an encoded scoped rootDir basename", () => {
    const encodedDir = createTempDirSync("openclaw-facade-encoded-line-");
    fs.mkdirSync(encodedDir, { recursive: true });
    fs.writeFileSync(
      path.join(encodedDir, "runtime-api.js"),
      'export const marker = "encoded-global-line";\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(encodedDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/line",
        version: "0.0.0",
        openclaw: {
          extensions: ["./runtime-api.js"],
          channel: { id: "line" },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(encodedDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "line",
        channels: ["line"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );

    expect(
      __testing.resolveRegistryPluginModuleLocationFromRegistry({
        registry: [
          {
            id: "line",
            rootDir: encodedDir,
            channels: ["line"],
          },
        ],
        dirName: "line",
        artifactBasename: "runtime-api.js",
      }),
    ).toEqual({
      modulePath: path.join(encodedDir, "runtime-api.js"),
      boundaryRoot: encodedDir,
    });
  });

  it("keeps shared runtime-core facades available without plugin activation", () => {
    setRuntimeConfigSnapshot({});

    for (const dirName of ["speech-core", "image-generation-core", "media-understanding-core"]) {
      expect(
        resolveActivationCheckBundledPluginPublicSurfaceAccess({
          dirName,
          artifactBasename: "runtime-api.js",
          location: null,
          sourceExtensionsRoot: "",
          resolutionKey: `runtime-core:${dirName}`,
        }),
      ).toEqual({
        allowed: true,
        pluginId: dirName,
      });
    }
  });

  it("prefers the source runtime snapshot for facade activation checks", () => {
    const dir = createTempDirSync("openclaw-facade-source-snapshot-");
    fs.mkdirSync(path.join(dir, "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "demo", "runtime-api.js"),
      'export const marker = "source-snapshot";\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "demo", "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
      }),
      "utf8",
    );
    useBundledPluginDirOverrideForTest(dir);
    setRuntimeConfigSnapshot(
      {
        plugins: {},
      },
      {
        plugins: {
          entries: {
            demo: {
              enabled: true,
            },
          },
        },
      },
    );

    expect(
      resolveActivationCheckBundledPluginPublicSurfaceAccess({
        dirName: "demo",
        artifactBasename: "runtime-api.js",
        location: {
          modulePath: path.join(dir, "demo", "runtime-api.js"),
          boundaryRoot: dir,
        },
        sourceExtensionsRoot: dir,
        resolutionKey: "source-snapshot-demo",
      }),
    ).toEqual({
      allowed: true,
      pluginId: "demo",
    });
  });
});
