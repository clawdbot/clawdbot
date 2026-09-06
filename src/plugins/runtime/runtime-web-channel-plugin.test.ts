import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadFacadeModuleAtLocationSync,
  resetFacadeLoaderStateForTest,
} from "../../plugin-sdk/facade-loader.js";
import { createPluginModuleLoader } from "../loader-module-runtime.js";
import { adoptProcessPluginCache, createPluginCache, withPluginCache } from "../plugin-cache.js";
import { getPluginInstance } from "../plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import type { PluginRecord } from "../registry-types.js";
import { getPluginRegistryForContext } from "../runtime-context.js";
import { resetPluginRuntimeStateForTest, stageActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-fixtures.js";
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { monitorWebChannel } from "./runtime-web-channel-plugin.js";

const cold = vi.hoisted(() => ({
  records: [] as Array<{ id: string; rootDir: string; source: string; origin: "global" }>,
}));
vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: vi.fn(() => ({ plugins: cold.records })),
}));

const temp = createTempDirTracker();
const records: PluginRecord[] = [];
beforeEach(() => {
  cold.records = [];
  vi.clearAllMocks();
  // Shared test cleanup reinstalls a default registry; this fixture owns both cold and live states.
  resetPluginRuntimeStateForTest();
  setRuntimeConfigSnapshot({});
});
afterEach(async () => {
  vi.restoreAllMocks();
  const disposals = await Promise.allSettled(
    records.splice(0).map(async (record) => await getPluginInstance(record)?.dispose()),
  );
  const failures: unknown[] = disposals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  for (const cleanup of [
    resetPluginRuntimeStateForTest,
    resetFacadeLoaderStateForTest,
    clearRuntimeConfigSnapshot,
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

function writeSource(root: string, version: string, surfaceDirectory = root) {
  fs.mkdirSync(surfaceDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(surfaceDirectory, "state.ts"),
    `let value = ${JSON.stringify(version)};
    export const read = () => value;
    export const set = (next: string) => { value = next; };`,
  );
  fs.writeFileSync(
    path.join(surfaceDirectory, "index.ts"),
    'import { set } from "./state.js"; export default { register: set };',
  );
  fs.writeFileSync(
    path.join(surfaceDirectory, "light-runtime-api.ts"),
    'export { read } from "./state.js";',
  );
  fs.writeFileSync(
    path.join(surfaceDirectory, "runtime-api.ts"),
    `import { read } from "./state.js";
    export async function monitorWebChannel(...args: unknown[]) {
      const { suffix } = await import("./lazy.js");
      return [read(), suffix, ...args];
    }`,
  );
  fs.writeFileSync(
    path.join(surfaceDirectory, "lazy.ts"),
    `export const suffix = ${JSON.stringify(`lazy-${version}`)};`,
  );
}

function prepare(rootDir: string, pluginId = "web-fixture") {
  const cache = createPluginCache();
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: pluginId,
    rootDir,
    source: path.join(rootDir, "index.ts"),
    origin: "global",
  });
  registry.plugins.push(record);
  records.push(record);
  const load = withPluginCache(cache, () =>
    createPluginModuleLoader({ tryNative: false, installNativeSdkResolver: false }),
  );
  const entry = load(record.source, { record, rootDir, registry }) as {
    default: { register: (value: string) => void };
  };
  const instance = expectDefined(getPluginInstance(record), "captured web plugin instance");
  return {
    registry,
    record,
    instance,
    entry,
    publish() {
      adoptProcessPluginCache(cache);
      stageActivePluginRegistry(registry, pluginId, "gateway-bindable");
    },
  };
}

describe("web channel package-root monitor", () => {
  it("forwards library monitor calls lazily with exact arguments and runtime receiver", async () => {
    const root = fs.realpathSync(temp.make("openclaw-web-library-"));
    const initialized = path.join(root, "initialized");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
    fs.writeFileSync(path.join(root, "light-runtime-api.js"), "module.exports = {};");
    fs.writeFileSync(
      path.join(root, "runtime-api.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(initialized)}, "loaded");
      const runtime = {
        async monitorWebChannel(...args) {
          return Reflect.apply(args[1], this, args);
        }
      };
      module.exports = runtime;`,
    );
    cold.records = [
      { id: "library-owner", rootDir: root, source: path.join(root, "index.js"), origin: "global" },
    ];
    const library = await import("../../library.js");
    expect(fs.existsSync(initialized)).toBe(false);
    const result = { marker: "complete" };
    const monitor = vi.fn(async (..._args: unknown[]) => result);
    const args = [
      true,
      monitor,
      false,
      vi.fn(),
      { log: vi.fn() },
      new AbortController().signal,
      { accountId: "work" },
    ];
    await expect(library.monitorWebChannel(...args)).resolves.toBe(result);
    expect(fs.readFileSync(initialized, "utf8")).toBe("loaded");
    expect(monitor).toHaveBeenCalledOnce();
    expect(monitor.mock.contexts[0]).toBe(
      loadFacadeModuleAtLocationSync({
        location: {
          modulePath: path.join(root, "runtime-api.js"),
          boundaryRoot: root,
          pluginId: "library-owner",
        },
      }),
    );
    const [receivedArgs] = monitor.mock.calls;
    expect(receivedArgs).toHaveLength(args.length);
    for (const [index, arg] of args.entries()) {
      expect(receivedArgs?.[index]).toBe(arg);
    }
    const monitorError = new Error("monitor failed");
    monitor.mockRejectedValueOnce(monitorError);
    await expect(library.monitorWebChannel(...args)).rejects.toBe(monitorError);
  });

  it("shares registration state, retains captured lazy modules, and follows the next instance", async () => {
    const root = fs.realpathSync(temp.make("openclaw-web-runtime-generation-"));
    writeSource(root, "one");
    const first = prepare(root);
    first.entry.default.register("registered-one");
    first.publish();
    // Public entries and their lazy dependency have not executed when their live files disappear.
    for (const file of ["runtime-api.ts", "light-runtime-api.ts", "lazy.ts"]) {
      fs.rmSync(path.join(root, file));
    }
    const retainedMonitor = monitorWebChannel;
    await expect(retainedMonitor("first", 1)).resolves.toEqual([
      "registered-one",
      "lazy-one",
      "first",
      1,
    ]);
    writeSource(root, "two");
    await expect(retainedMonitor()).resolves.toEqual(["registered-one", "lazy-one"]);
    await first.instance.dispose();
    const second = prepare(root);
    second.entry.default.register("registered-two");
    second.publish();
    await expect(retainedMonitor("next")).resolves.toEqual(["registered-two", "lazy-two", "next"]);
    await expect(
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: first.registry, isWebchatConnect: () => false },
        () => retainedMonitor("stale"),
      ),
    ).rejects.toThrow(/reloaded|disabled|retiring/);
    expect(resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it.each(["disabled", "uninstalled"] as const)(
    "does not cold-load a %s package that remains on disk",
    async (state) => {
      const root = fs.realpathSync(temp.make("openclaw-web-runtime-disabled-"));
      writeSource(root, "active");
      const active = prepare(root);
      active.publish();
      await expect(monitorWebChannel()).resolves.toEqual(["active", "lazy-active"]);
      const registry = createEmptyPluginRegistry();
      if (state === "disabled") {
        registry.plugins.push(
          createPluginRecord({ ...active.record, enabled: false, status: "disabled" }),
        );
      }
      stageActivePluginRegistry(registry, state, "gateway-bindable");
      await active.instance.dispose();
      writeSource(root, "must-not-load");
      cold.records = [
        { id: active.record.id, rootDir: root, source: active.record.source, origin: "global" },
      ];
      await expect(monitorWebChannel()).rejects.toThrow(/runtime is unavailable/);
      expect(resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous runtime owners instead of choosing one", async () => {
    const firstRoot = fs.realpathSync(temp.make("openclaw-web-runtime-first-"));
    const secondRoot = fs.realpathSync(temp.make("openclaw-web-runtime-second-"));
    writeSource(firstRoot, "first");
    writeSource(secondRoot, "second");
    const first = prepare(firstRoot, "first-owner");
    const second = prepare(secondRoot, "second-owner");
    second.registry.plugins.unshift(first.record);
    second.publish();
    await expect(monitorWebChannel()).rejects.toThrow(/ambiguous.*first-owner, second-owner/);
    expect(resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it.each(["entry", "root"] as const)(
    "loads a cold TypeScript embedding from the %s directory with entry sidecar precedence",
    async (location) => {
      expect(getPluginRegistryForContext()).toBeNull();
      const root = fs.realpathSync(temp.make("openclaw-web-runtime-cold-"));
      const entryDirectory = path.join(root, "entry");
      fs.mkdirSync(entryDirectory);
      writeSource(root, "cold", location === "entry" ? entryDirectory : root);
      if (location === "entry") {
        fs.writeFileSync(
          path.join(root, "runtime-api.js"),
          'export const monitorWebChannel = async () => "wrong root";',
        );
      }
      cold.records = [
        {
          id: "cold-owner",
          rootDir: root,
          source: path.join(entryDirectory, "index.ts"),
          origin: "global",
        },
      ];
      await expect(monitorWebChannel("argument")).resolves.toEqual([
        "cold",
        "lazy-cold",
        "argument",
      ]);
    },
  );

  it("reports cold module initialization failures as promise rejections", async () => {
    expect(getPluginRegistryForContext()).toBeNull();
    const root = fs.realpathSync(temp.make("openclaw-web-runtime-failure-"));
    writeSource(root, "failure");
    fs.writeFileSync(
      path.join(root, "runtime-api.ts"),
      'throw new Error("web runtime initialization failed");',
    );
    cold.records = [
      { id: "failure", rootDir: root, source: path.join(root, "index.ts"), origin: "global" },
    ];
    await expect(monitorWebChannel()).rejects.toThrow("web runtime initialization failed");
  });
});
