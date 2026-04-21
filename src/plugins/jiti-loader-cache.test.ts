import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("jiti");
});

async function loadCachedPluginJitiLoader(scope: string) {
  const createJiti = vi.fn((filename: string, options?: Record<string, unknown>) =>
    Object.assign(vi.fn(), {
      filename,
      options,
    }),
  );
  vi.doMock("jiti", () => ({
    createJiti,
  }));

  const { getCachedPluginJitiLoader } = await importFreshModule<
    typeof import("./jiti-loader-cache.js")
  >(import.meta.url, `./jiti-loader-cache.js?scope=${scope}`);

  return { createJiti, getCachedPluginJitiLoader };
}

describe("getCachedPluginJitiLoader", () => {
  it("reuses cached loaders for the same module config and filename", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("cached-loader");

    const cache = new Map();
    const params = {
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/setup-registry.ts",
      argvEntry: "/repo/openclaw.mjs",
      jitiFilename: "file:///repo/src/plugins/source-loader.ts",
    } as const;

    const first = getCachedPluginJitiLoader(params);
    const second = getCachedPluginJitiLoader(params);

    expect(second).toBe(first);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it("keeps loader caches scoped by jiti filename and dist preference", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("filename-scope");

    const cache = new Map();
    const first = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      argvEntry: "/repo/openclaw.mjs",
      preferBuiltDist: true,
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
    });
    const second = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo/api.ts",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      argvEntry: "/repo/openclaw.mjs",
      preferBuiltDist: true,
      jitiFilename: "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
    });

    expect(second).not.toBe(first);
    expect(createJiti).toHaveBeenNthCalledWith(
      1,
      "file:///repo/src/plugins/public-surface-loader.ts",
      expect.objectContaining({
        tryNative: false,
        interopDefault: true,
        alias: expect.any(Object),
      }),
    );
    expect(createJiti).toHaveBeenNthCalledWith(
      2,
      "file:///repo/src/plugins/bundled-channel-config-metadata.ts",
      expect.objectContaining({
        tryNative: false,
        interopDefault: true,
        alias: expect.any(Object),
      }),
    );
    expect(cache.size).toBe(2);
  });

  it("lets callers override alias maps and tryNative while keeping cache keys stable", async () => {
    const { createJiti, getCachedPluginJitiLoader } = await loadCachedPluginJitiLoader("overrides");

    const cache = new Map();
    const first = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      jitiFilename: "file:///repo/src/plugins/loader.ts",
      aliasMap: {
        alpha: "/repo/alpha.js",
        zeta: "/repo/zeta.js",
      },
      tryNative: false,
    });
    const second = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/extensions/demo/index.ts",
      importerUrl: "file:///repo/src/plugins/loader.ts",
      jitiFilename: "file:///repo/src/plugins/loader.ts",
      aliasMap: {
        zeta: "/repo/zeta.js",
        alpha: "/repo/alpha.js",
      },
      tryNative: false,
    });

    expect(second).toBe(first);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(createJiti).toHaveBeenCalledWith(
      "file:///repo/src/plugins/loader.ts",
      expect.objectContaining({
        tryNative: false,
        alias: {
          alpha: "/repo/alpha.js",
          zeta: "/repo/zeta.js",
        },
      }),
    );
  });

  it("lets callers intentionally share loaders behind a custom cache scope key", async () => {
    const { createJiti, getCachedPluginJitiLoader } =
      await loadCachedPluginJitiLoader("cache-scope-key");

    const cache = new Map();
    const first = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-a/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-a.js",
      },
      tryNative: true,
      cacheScopeKey: "bundled:native",
    });
    const second = getCachedPluginJitiLoader({
      cache,
      modulePath: "/repo/dist/extensions/demo-b/api.js",
      importerUrl: "file:///repo/src/plugins/public-surface-loader.ts",
      jitiFilename: "file:///repo/src/plugins/public-surface-loader.ts",
      aliasMap: {
        demo: "/repo/demo-b.js",
      },
      tryNative: true,
      cacheScopeKey: "bundled:native",
    });

    expect(second).toBe(first);
    expect(createJiti).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });
});
