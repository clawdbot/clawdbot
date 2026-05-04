import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listImportedBundledPluginFacadeIds,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeLoaderStateForTest,
  setFacadeLoaderSourceTransformFactoryForTest,
} from "./facade-loader.js";
import { listImportedBundledPluginFacadeIds as listImportedFacadeRuntimeIds } from "./facade-runtime.js";
import { createPluginSdkTestHarness } from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalDisableBundledPlugins = process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
const FACADE_LOADER_GLOBAL = "__openclawTestLoadBundledPluginPublicSurfaceModuleSync";
type FacadeLoaderSourceTransformFactory = NonNullable<
  Parameters<typeof setFacadeLoaderSourceTransformFactoryForTest>[0]
>;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const trustedBundledPluginFixtureRoots: string[] = [];
let trustedPluginIdCounter = 0;

function forceNodeRuntimeVersionsForTest(): () => void {
  const originalVersions = process.versions;
  const nodeVersions = { ...originalVersions } as NodeJS.ProcessVersions & {
    bun?: string | undefined;
  };
  delete nodeVersions.bun;
  Object.defineProperty(process, "versions", {
    configurable: true,
    value: nodeVersions,
  });
  return () => {
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: originalVersions,
    });
  };
}

type TrustedBundledPluginFixture = {
  bundledPluginsDir: string;
  pluginId: string;
  pluginRoot: string;
};

function nextTrustedPluginId(prefix: string): string {
  return `${prefix}${trustedPluginIdCounter++}`;
}

function createTrustedBundledPluginsRoot(kind: "dist" | "dist-runtime" = "dist"): string {
  const rootDir = path.join(packageRoot, kind, "extensions");
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function writeFixturePackageJson(pluginRoot: string, pluginId: string): void {
  writeJsonFile(path.join(pluginRoot, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "0.0.0",
    type: "module",
  });
}

function createBundledPluginFixture(params: {
  prefix: string;
  marker: string;
  kind?: "dist" | "dist-runtime";
  pluginId?: string;
}): TrustedBundledPluginFixture {
  const bundledPluginsDir = createTrustedBundledPluginsRoot(params.kind);
  const pluginId = params.pluginId ?? nextTrustedPluginId(params.prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "api.js"),
    `export const marker = ${JSON.stringify(params.marker)};\n`,
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function createPackageSourcePluginFixture(params: {
  prefix: string;
  marker: string;
}): TrustedBundledPluginFixture {
  const bundledPluginsDir = path.join(packageRoot, "extensions");
  const pluginId = nextTrustedPluginId(params.prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "api.ts"),
    `export const marker = ${JSON.stringify(params.marker)};\n`,
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function createThrowingPluginFixture(prefix: string): TrustedBundledPluginFixture {
  const bundledPluginsDir = createTrustedBundledPluginsRoot();
  const pluginId = nextTrustedPluginId(prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "api.js"),
    'throw new Error("plugin load failure");\n',
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function createCircularPluginFixture(prefix: string): TrustedBundledPluginFixture {
  const bundledPluginsDir = createTrustedBundledPluginsRoot();
  const pluginId = nextTrustedPluginId(prefix);
  const pluginRoot = path.join(bundledPluginsDir, pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  trustedBundledPluginFixtureRoots.push(pluginRoot);
  writeFixturePackageJson(pluginRoot, pluginId);
  fs.writeFileSync(
    path.join(pluginRoot, "facade.mjs"),
    [
      `const loadBundledPluginPublicSurfaceModuleSync = globalThis.${FACADE_LOADER_GLOBAL};`,
      `if (typeof loadBundledPluginPublicSurfaceModuleSync !== "function") {`,
      '  throw new Error("missing facade loader test loader");',
      "}",
      `export const marker = loadBundledPluginPublicSurfaceModuleSync({ dirName: ${JSON.stringify(
        pluginId,
      )}, artifactBasename: "api.js" }).marker;`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "helper.js"),
    ['import { marker } from "./facade.mjs";', "export const circularMarker = marker;", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "api.js"),
    ['import "./helper.js";', 'export const marker = "circular-ok";', ""].join("\n"),
    "utf8",
  );
  return { bundledPluginsDir, pluginId, pluginRoot };
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  resetFacadeLoaderStateForTest();
  setFacadeLoaderSourceTransformFactoryForTest(undefined);
  for (const dir of trustedBundledPluginFixtureRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL];
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
});

describe("plugin-sdk facade loader", () => {
  it("honors trusted bundled plugin dir overrides under the package root", () => {
    const pluginId = nextTrustedPluginId("openclaw-facade-loader-override-");
    const overrideA = createBundledPluginFixture({
      pluginId,
      kind: "dist",
      prefix: "openclaw-facade-loader-a-",
      marker: "override-a",
    });
    const overrideB = createBundledPluginFixture({
      pluginId,
      kind: "dist-runtime",
      prefix: "openclaw-facade-loader-b-",
      marker: "override-b",
    });

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideA.bundledPluginsDir;
    const fromA = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: pluginId,
      artifactBasename: "api.js",
    });
    expect(fromA.marker).toBe("override-a");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideB.bundledPluginsDir;
    const fromB = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: pluginId,
      artifactBasename: "api.js",
    });
    expect(fromB.marker).toBe("override-b");
  });

  it("falls back to package source surfaces when an override dir lacks a bundled plugin", () => {
    const fixture = createPackageSourcePluginFixture({
      prefix: "openclaw-facade-loader-source-fallback-",
      marker: "source-fallback",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = createTempDirSync("openclaw-facade-loader-empty-");

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{
      marker: string;
    }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("source-fallback");
  });

  it("keeps bundled facade loads disabled when bundled plugins are disabled", () => {
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync({
        dirName: "browser",
        artifactBasename: "browser-maintenance.js",
      }),
    ).toThrow("Unable to resolve bundled plugin public surface browser/browser-maintenance.js");
  });

  it("shares loaded facade ids with facade-runtime", () => {
    const fixture = createBundledPluginFixture({
      prefix: "openclaw-facade-loader-ids-",
      marker: "identity-check",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;

    const first = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });
    const second = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });

    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual([fixture.pluginId]);
    expect(listImportedFacadeRuntimeIds()).toEqual([fixture.pluginId]);
  });

  it("uses native require for Windows dist facade loads", () => {
    const fixture = createBundledPluginFixture({
      prefix: "openclaw-facade-loader-windows-",
      marker: "windows-dist-ok",
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;

    const createJitiCalls: Parameters<FacadeLoaderSourceTransformFactory>[] = [];
    setFacadeLoaderSourceTransformFactoryForTest(((...args) => {
      createJitiCalls.push(args);
      return vi.fn(() => ({
        marker: "jiti-fallback",
      })) as unknown as ReturnType<FacadeLoaderSourceTransformFactory>;
    }) as FacadeLoaderSourceTransformFactory);
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const restoreVersions = forceNodeRuntimeVersionsForTest();

    try {
      expect(
        loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
          dirName: fixture.pluginId,
          artifactBasename: "api.js",
        }).marker,
      ).toBe("windows-dist-ok");
      expect(createJitiCalls).toHaveLength(0);
    } finally {
      restoreVersions();
      platformSpy.mockRestore();
    }
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const fixture = createCircularPluginFixture("openclaw-facade-loader-circular-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL] =
      loadBundledPluginPublicSurfaceModuleSync;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: fixture.pluginId,
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("circular-ok");
  });

  it("clears the cache on load failure so retries re-execute", () => {
    const fixture = createThrowingPluginFixture("openclaw-facade-loader-throw-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = fixture.bundledPluginsDir;

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: fixture.pluginId,
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: fixture.pluginId,
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");
  });
});
