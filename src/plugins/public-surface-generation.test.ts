import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSyncCore,
  resetFacadeLoaderStateForTest,
} from "../plugin-sdk/facade-loader.js";
import {
  loadActivatedBundledPluginPublicSurfaceModule,
  loadActivatedBundledPluginPublicSurfaceModuleSync,
  testing as facadeRuntimeTesting,
} from "../plugin-sdk/facade-runtime.js";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import { adoptProcessPluginCache, createPluginCache, withPluginCache } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { loadPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { resetPluginRuntimeStateForTest, stageActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

type PublicApi = {
  read: () => string;
  view: { read: () => string; frozen: readonly (() => string)[] };
};
const temp = createTempDirTracker();
const records: PluginRecord[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const disposals = await Promise.allSettled(
    records.splice(0).map(async (record) => await getPluginInstance(record)?.dispose()),
  );
  const failures: unknown[] = disposals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  for (const cleanup of [
    resetPluginRuntimeStateForTest,
    resetFacadeLoaderStateForTest,
    temp.cleanup,
  ]) {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Plugin fixture cleanup failed");
  }
});

function writeSource(root: string, version: string, extension: "ts" | "js" = "ts", size = 1) {
  const annotation = extension === "ts" ? ": string" : "";
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, `state.${extension}`),
    `let value = ${JSON.stringify(version)};
    export const read = () => value;
    export const set = (next${annotation}) => { value = next; };
    export const view = { read, frozen: Object.freeze(Array.from({ length: ${size} }, () => read)) };`,
  );
  fs.writeFileSync(
    path.join(root, `index.${extension}`),
    `import { set } from "./state.js";
    export default { register(value${annotation}) { set(value); } };`,
  );
  fs.writeFileSync(path.join(root, `api.${extension}`), 'export { read, view } from "./state.js";');
  fs.writeFileSync(
    path.join(root, `runtime-api.${extension}`),
    'export { read, view } from "./state.js";',
  );
}

function prepare(
  rootDir: string,
  pluginId = "surface-fixture",
  origin: "global" | "bundled" = "global",
  extension: "ts" | "mts" | "js" = "ts",
  entryDirectory = ".",
) {
  const cache = createPluginCache();
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: pluginId,
    rootDir,
    source: path.join(rootDir, entryDirectory, `index.${extension}`),
    origin,
  });
  registry.plugins.push(record);
  records.push(record);
  const load = withPluginCache(cache, () =>
    createPluginModuleLoader({ tryNative: extension === "js", installNativeSdkResolver: false }),
  );
  const entry = load(record.source, { record, rootDir, registry }) as {
    default: { register: (value: string) => void };
  };
  const instance = expectDefined(getPluginInstance(record), "captured plugin instance");
  return {
    registry,
    record,
    instance,
    entry,
    publish: () => {
      adoptProcessPluginCache(cache);
      stageActivePluginRegistry(registry, pluginId, "default");
    },
  };
}

describe("managed plugin public surfaces", () => {
  it.each(["global", "bundled"] as const)(
    "shares registration state with captured APIs, refreshes a retained facade, and fences old exports (%s)",
    async (origin) => {
      const root = fs.realpathSync(temp.make("openclaw-public-generation-"));
      writeSource(root, "source-one");
      const first = prepare(root, "surface-fixture", origin);
      first.entry.default.register("registered-one");
      first.publish();
      const loadApi = () =>
        loadPluginPublicArtifactModuleSync<PublicApi>({
          pluginRoot: root,
          artifactBasename: "api.js",
        });
      const loadFacade = () =>
        loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>({
          dirName: first.record.id,
          artifactBasename: "runtime-api.js",
        });
      const lazy = createLazyFacadeObjectValue(() => loadFacade().view);
      const frozen = createLazyFacadeObjectValue(() => loadFacade().view.frozen);

      // Neither public entry has executed yet. The captured graph survives source deletion.
      fs.rmSync(path.join(root, "api.ts"));
      fs.rmSync(path.join(root, "runtime-api.ts"));
      fs.writeFileSync(
        path.join(root, "state.ts"),
        'export const read = () => "uncommitted edit";',
      );
      const originalApi = loadApi();
      const originalRead = originalApi.read;
      expect(originalRead()).toBe("registered-one");
      expect(loadFacade().read()).toBe("registered-one");
      expect(lazy.read()).toBe("registered-one");
      const retainedLazyRead = lazy.read;
      for (const [property, descriptor] of [
        ["read", { configurable: false, writable: false }],
        ["added", { value: "fixed" }],
        [Symbol("fixed"), { get: () => "fixed", configurable: false }],
      ] as const) {
        const before = Object.getOwnPropertyDescriptor(originalApi.view, property);
        expect(Reflect.defineProperty(lazy, property, descriptor)).toBe(false);
        expect(Object.getOwnPropertyDescriptor(originalApi.view, property)).toEqual(before);
      }
      expect(Reflect.set(lazy, "note", "first")).toBe(true);
      expect(Reflect.defineProperty(lazy, "note", { value: "updated" })).toBe(true);
      expect(Reflect.get(originalApi.view, "note")).toBe("updated");
      const configurable = Symbol("configurable");
      expect(
        Reflect.defineProperty(lazy, configurable, { value: "allowed", configurable: true }),
      ).toBe(true);
      expect(Reflect.get(originalApi.view, configurable)).toBe("allowed");
      expect(Object.getOwnPropertyDescriptor(frozen, "length")).toMatchObject({
        value: 1,
        configurable: true,
      });
      expect(Object.keys(frozen)).toEqual(["0"]);
      for (const operation of ["preventExtensions", "seal", "freeze"] as const) {
        const applyIntegrity: (value: object) => object = Object[operation];
        expect(() => applyIntegrity(lazy)).toThrow(TypeError);
        expect(Object.isExtensible(lazy)).toBe(true);
        expect(lazy.read()).toBe("registered-one");
      }
      const probes = [
        vi.spyOn(fs, "existsSync"),
        vi.spyOn(fs, "realpathSync"),
        vi.spyOn(fs, "statSync"),
        vi.spyOn(fs, "openSync"),
      ];
      expect(loadApi()).toBe(originalApi);
      expect(lazy.read()).toBe("registered-one");
      for (const probe of probes) {
        expect(probe).not.toHaveBeenCalled();
        probe.mockRestore();
      }

      await first.instance.dispose();
      writeSource(root, "source-two", "ts", 2);
      const second = prepare(root, "surface-fixture", origin);
      second.entry.default.register("registered-two");
      second.publish();
      expect(loadApi().read()).toBe("registered-two");
      expect(lazy.read()).toBe("registered-two");
      expect(frozen.length).toBe(2);
      expect(Object.keys(frozen)).toEqual(["0", "1"]);
      expect(frozen[1]?.()).toBe("registered-two");
      expect(originalRead).toThrow(/reloaded|disabled|retiring/);
      expect(retainedLazyRead).toThrow(/reloaded|disabled|retiring/);
      expect(() =>
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: first.registry, isWebchatConnect: () => false },
          loadApi,
        ),
      ).toThrow(/reloaded|disabled|retiring/);

      const retained = loadApi();
      const nextRegistry = createEmptyPluginRegistry();
      nextRegistry.plugins.push(second.record);
      stageActivePluginRegistry(nextRegistry, "unrelated-change", "default");
      expect(loadApi()).toBe(retained);
      expect(lazy.read()).toBe("registered-two");
    },
  );

  it("requires exact identity when package siblings have separate module instances", () => {
    const root = fs.realpathSync(temp.make("openclaw-public-cohort-"));
    writeSource(root, "source");
    const first = prepare(root, "first");
    const second = prepare(root, "second");
    first.entry.default.register("first-instance");
    second.entry.default.register("second-instance");
    second.registry.plugins.unshift(first.record);
    second.publish();
    const load = (pluginId?: string) =>
      loadPluginPublicArtifactModuleSync<PublicApi>({
        pluginRoot: root,
        artifactBasename: "api.js",
        pluginId,
      });
    expect(() => load()).toThrow(/ambiguous runtime ownership/);
    expect(load("first").read()).toBe("first-instance");
    expect(load("second").read()).toBe("second-instance");
    expect(
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: second.registry, pluginId: "first", isWebchatConnect: () => false },
        () => load().read(),
      ),
    ).toBe("first-instance");
  });

  it.each([
    ["ts", ".", "."],
    ["ts", "dist", "."],
    ["mts", ".", "."],
    ["js", ".", "."],
    ["ts", "dist", "src"],
  ] as const)(
    "keeps public APIs on the registered %s graph when source and build coexist in %s (entry in %s)",
    (extension, buildDirectory, entryDirectory) => {
      const root = fs.realpathSync(temp.make("openclaw-public-mixed-source-"));
      const buildRoot = path.join(root, buildDirectory);
      fs.mkdirSync(buildRoot, { recursive: true });
      writeSource(buildRoot, "stale-build", "js");
      writeSource(root, "source");
      if (extension === "mts") {
        fs.renameSync(path.join(root, "index.ts"), path.join(root, "index.mts"));
      }
      if (entryDirectory === "src") {
        fs.mkdirSync(path.join(root, "src"));
        fs.writeFileSync(
          path.join(root, "src", "index.ts"),
          'import { set } from "../state.js"; export default { register(value: string) { set(value); } };',
        );
      }
      const active = prepare(root, "surface-fixture", "global", extension, entryDirectory);
      active.entry.default.register("registered-graph");
      active.publish();

      // Resolve both previously unexecuted APIs from the captured inventory.
      fs.rmSync(root, { recursive: true });
      const api = loadPluginPublicArtifactModuleSync<PublicApi>({
        pluginRoot: root,
        artifactBasename: "api.js",
      });
      const runtime = loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>({
        dirName: active.record.id,
        artifactBasename: "runtime-api.js",
      });
      expect(api.read()).toBe("registered-graph");
      expect(runtime.read()).toBe("registered-graph");
      expect(runtime.view).toBe(api.view);
    },
  );

  it.each(["disabled", "uninstalled"] as const)(
    "does not reload a %s plugin through a retained facade or runtime request",
    async (state) => {
      const root = fs.realpathSync(temp.make("openclaw-public-disabled-"));
      writeSource(root, "active");
      const active = prepare(root);
      active.publish();
      const load = () =>
        loadPluginPublicArtifactModuleSync<PublicApi>({
          pluginRoot: root,
          artifactBasename: "api.js",
        });
      const lazy = createLazyFacadeObjectValue(() => load().view);
      expect(lazy.read()).toBe("active");
      const registry = createEmptyPluginRegistry();
      if (state === "disabled") {
        registry.plugins.push(
          createPluginRecord({
            id: active.record.id,
            rootDir: root,
            source: active.record.source,
            enabled: false,
            status: "disabled",
          }),
        );
      }
      stageActivePluginRegistry(registry, state, "gateway-bindable");
      await active.instance.dispose();
      // Keep the package installed, as disable and uninstall --keep-files do.
      writeSource(root, "must-not-execute");
      expect(() => lazy.read()).toThrow(/disabled or uninstalled/);
      expect(() =>
        withPluginRuntimeGatewayRequestScope(
          { pluginRegistry: registry, isWebchatConnect: () => false },
          load,
        ),
      ).toThrow(/no active runtime owner/);
    },
  );

  it("resolves captured public entries through the original root and its canonical alias", () => {
    const directory = fs.realpathSync(temp.make("openclaw-public-alias-"));
    const root = path.join(directory, "source");
    const alias = path.join(directory, "linked");
    fs.mkdirSync(root);
    fs.symlinkSync(root, alias, "junction");
    writeSource(root, "captured");
    const active = prepare(alias);
    active.publish();
    fs.rmSync(path.join(root, "api.ts"));
    for (const pluginRoot of [root, alias]) {
      expect(
        loadPluginPublicArtifactModuleSync<PublicApi>({
          pluginRoot,
          artifactBasename: "api.js",
        }).read(),
      ).toBe("captured");
    }
  });

  it.each([
    ["ts", "sync", loadActivatedBundledPluginPublicSurfaceModuleSync],
    ["ts", "async", loadActivatedBundledPluginPublicSurfaceModule],
    ["js", "sync", loadActivatedBundledPluginPublicSurfaceModuleSync],
    ["js", "async", loadActivatedBundledPluginPublicSurfaceModule],
  ] as const)(
    "keeps %s bundled inspection libraries usable while fencing %s activated runtime exports",
    async (extension, _mode, loadActivated) => {
      const directory = fs.realpathSync(temp.make("openclaw-public-bundled-"));
      const pluginId = "bundled-surface-fixture";
      const root = path.join(directory, pluginId);
      fs.mkdirSync(root);
      writeSource(root, "library", extension);
      fs.writeFileSync(path.join(root, "openclaw.plugin.json"), JSON.stringify({ id: pluginId }));
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", directory);
      const active = prepare(root, pluginId, "bundled", extension);
      active.entry.default.register("registered");
      active.publish();
      stageActivePluginRegistry(active.registry, "bundled", "gateway-bindable");
      facadeRuntimeTesting.setFacadeActivationCheckRuntimeForTest(
        await import("../plugin-sdk/facade-activation-check.runtime.js"),
      );
      const request = { dirName: pluginId, artifactBasename: "api.js" };
      const library = loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request);
      const runtime = await loadActivated<PublicApi>(request);
      const retainedRead = runtime.read;
      expect(library.read()).toBe("registered");
      expect(runtime.read()).toBe("registered");
      const disabled = createEmptyPluginRegistry();
      disabled.plugins.push(
        createPluginRecord({ ...active.record, enabled: false, status: "disabled" }),
      );
      stageActivePluginRegistry(disabled, "disabled", "gateway-bindable");
      await active.instance.dispose();
      const inspection = loadBundledPluginPublicSurfaceModuleSyncCore<PublicApi>(request);
      if (extension === "js") {
        expect(inspection).toBe(library);
        expect(library.read()).toBe("registered");
      } else {
        // Vitest deep-compares unequal references; retired export getters must stay fenced.
        expect(Object.is(inspection, library)).toBe(false);
        expect(inspection.read()).toBe("library");
        expect(() => library.read()).toThrow(/reloaded|disabled|retiring/);
      }
      expect(retainedRead).toThrow(/reloaded|disabled|retiring/);
      expect(() => runtime.read()).toThrow(/reloaded or disabled/);
      await expect(async () => await loadActivated(request)).rejects.toThrow(/access blocked/);
    },
  );
});
