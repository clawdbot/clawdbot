import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listImportedBundledPluginFacadeIds,
  loadBundledPluginPublicSurfaceModuleSync,
  resetFacadeLoaderStateForTest,
  setFacadeLoaderJitiFactoryForTest,
} from "./facade-loader.js";
import { listImportedBundledPluginFacadeIds as listImportedFacadeRuntimeIds } from "./facade-runtime.js";
import {
  createBundledPluginPublicSurfaceFixture,
  createPluginSdkTestHarness,
  createThrowingBundledPluginPublicSurfaceFixture,
} from "./test-helpers.js";

const { createTempDirSync } = createPluginSdkTestHarness();
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const FACADE_LOADER_GLOBAL = "__openclawTestLoadBundledPluginPublicSurfaceModuleSync";
type FacadeLoaderJitiFactory = NonNullable<Parameters<typeof setFacadeLoaderJitiFactoryForTest>[0]>;

function createBundledPluginDir(prefix: string, marker: string): string {
  return createBundledPluginPublicSurfaceFixture({ createTempDirSync, marker, prefix });
}

function createThrowingPluginDir(prefix: string): string {
  return createThrowingBundledPluginPublicSurfaceFixture({ createTempDirSync, prefix });
}

function createCircularPluginDir(prefix: string): string {
  const rootDir = createTempDirSync(prefix);
  fs.mkdirSync(path.join(rootDir, "demo"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "facade.mjs"),
    [
      `const loadBundledPluginPublicSurfaceModuleSync = globalThis.${FACADE_LOADER_GLOBAL};`,
      `if (typeof loadBundledPluginPublicSurfaceModuleSync !== "function") {`,
      '  throw new Error("missing facade loader test loader");',
      "}",
      `export const marker = loadBundledPluginPublicSurfaceModuleSync({ dirName: "demo", artifactBasename: "api.js" }).marker;`,
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "demo", "helper.js"),
    ['import { marker } from "../facade.mjs";', "export const circularMarker = marker;", ""].join(
      "\n",
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "demo", "api.js"),
    ['import "./helper.js";', 'export const marker = "circular-ok";', ""].join("\n"),
    "utf8",
  );
  return rootDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetFacadeLoaderStateForTest();
  setFacadeLoaderJitiFactoryForTest(undefined);
  delete (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL];
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
});

describe("plugin-sdk facade loader", () => {
  it("honors bundled plugin dir overrides outside the package root", () => {
    const overrideA = createBundledPluginDir("openclaw-facade-loader-a-", "override-a");
    const overrideB = createBundledPluginDir("openclaw-facade-loader-b-", "override-b");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideA;
    const fromA = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromA.marker).toBe("override-a");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = overrideB;
    const fromB = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    expect(fromB.marker).toBe("override-b");
  });

  it("shares loaded facade ids with facade-runtime", () => {
    const dir = createBundledPluginDir("openclaw-facade-loader-ids-", "identity-check");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

    const first = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });
    const second = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(first).toBe(second);
    expect(first.marker).toBe("identity-check");
    expect(listImportedBundledPluginFacadeIds()).toEqual(["demo"]);
    expect(listImportedFacadeRuntimeIds()).toEqual(["demo"]);
  });

  it("keeps Windows dist facade loads off Jiti native import", () => {
    const dir = createTempDirSync("openclaw-facade-loader-windows-dist-");
    const bundledPluginsDir = path.join(dir, "dist");
    fs.mkdirSync(path.join(bundledPluginsDir, "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(bundledPluginsDir, "demo", "api.js"),
      'export const marker = "windows-dist-ok";\n',
      "utf8",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

    const createJitiCalls: Parameters<FacadeLoaderJitiFactory>[] = [];
    setFacadeLoaderJitiFactoryForTest(((...args) => {
      createJitiCalls.push(args);
      return vi.fn(() => ({
        marker: "windows-dist-ok",
      })) as unknown as ReturnType<FacadeLoaderJitiFactory>;
    }) as FacadeLoaderJitiFactory);
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      expect(
        loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
          dirName: "demo",
          artifactBasename: "api.js",
        }).marker,
      ).toBe("windows-dist-ok");
      expect(createJitiCalls).toHaveLength(1);
      expect(createJitiCalls[0]?.[0]).toEqual(expect.any(String));
      expect(createJitiCalls[0]?.[1]).toEqual(
        expect.objectContaining({
          tryNative: false,
        }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("breaks circular facade re-entry during module evaluation", () => {
    const dir = createCircularPluginDir("openclaw-facade-loader-circular-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;
    (globalThis as typeof globalThis & Record<string, unknown>)[FACADE_LOADER_GLOBAL] =
      loadBundledPluginPublicSurfaceModuleSync;

    const loaded = loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
      dirName: "demo",
      artifactBasename: "api.js",
    });

    expect(loaded.marker).toBe("circular-ok");
  });

  it("clears the cache on load failure so retries re-execute", () => {
    const dir = createThrowingPluginDir("openclaw-facade-loader-throw-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = dir;

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");

    expect(listImportedBundledPluginFacadeIds()).toEqual([]);

    expect(() =>
      loadBundledPluginPublicSurfaceModuleSync<{ marker: string }>({
        dirName: "bad",
        artifactBasename: "api.js",
      }),
    ).toThrow("plugin load failure");
  });
});
