import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PluginLoadFailureError } from "./loader-shared.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { clearActivePluginRegistry, disposePluginRegistryInstances } from "./runtime.js";

afterEach(async () => {
  await clearActivePluginRegistry();
  resetPluginLoaderTestStateForTest();
});

it("imports only replaced plugins and reuses unchanged capability registrations", async () => {
  useNoBundledPlugins();
  const calls = path.join(makePluginLoaderTempDir(), "calls.txt");
  const plugins = ["kept", "changed"].map((id) =>
    writePlugin({
      id,
      body: `
    const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(calls)}, "import:${id}\\n");
    module.exports = { id: "${id}", register(api) {
      fs.appendFileSync(${JSON.stringify(calls)}, "register:${id}\\n");
      api.registerGatewayMethod("${id}.probe", () => {});
      api.registerService({ id: "${id}", start() {} });
      api.registerContextEngine("${id}", () => ({}));
    } };
  `,
    }),
  );
  const options = {
    config: {
      plugins: {
        allow: plugins.map((plugin) => plugin.id),
        load: { paths: plugins.map((plugin) => plugin.file) },
        slots: { memory: "none" },
      },
    },
    cache: false,
  };
  const previous = loadOpenClawPlugins(options);
  const next = loadOpenClawPlugins({
    ...options,
    activate: false,
    runtimeSideEffects: true,
    previousRegistry: previous,
    replacePluginIds: ["changed"],
    throwOnLoadError: true,
  });
  expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual([
    "import:kept",
    "register:kept",
    "import:changed",
    "register:changed",
    "import:changed",
    "register:changed",
  ]);
  const kept = previous.plugins.find((record) => record.id === "kept");
  expect(next.plugins.find((record) => record.id === "kept")).toBe(kept);
  expect(next.plugins.find((record) => record.id === "changed")).not.toBe(
    previous.plugins.find((record) => record.id === "changed"),
  );
  expect(next.gatewayHandlers["kept.probe"]).toBe(previous.gatewayHandlers["kept.probe"]);
  expect(next.services.find((service) => service.pluginId === "kept")).toBe(
    previous.services.find((service) => service.pluginId === "kept"),
  );
  expect(next.contextEngines.get("kept")).toBe(previous.contextEngines.get("kept"));
  expect(next.contextEngines.has("kept")).toBe(true);
  await disposePluginRegistryInstances(next, previous);
});

it.each(["denylist", "owned-channel"])(
  "rechecks %s policy before retaining a previously enabled plugin",
  async (policy) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "policy-probe",
      body: 'module.exports = { id: "policy-probe", register() {} };',
    });
    const channelId = "transport-probe";
    writePluginMetadata({ dir: plugin.dir, id: plugin.id, channels: [channelId] });
    const config = {
      plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
      channels: { [channelId]: { enabled: true } },
    };
    const previous = loadOpenClawPlugins({ config, cache: false });
    const previousRecord = previous.plugins.find((record) => record.id === plugin.id);
    expect(previousRecord).toMatchObject({ enabled: true, status: "loaded" });
    const denied = loadOpenClawPlugins({
      config:
        policy === "denylist"
          ? { ...config, plugins: { ...config.plugins, deny: [plugin.id] } }
          : { ...config, channels: { [channelId]: { enabled: false } } },
      activate: false,
      runtimeSideEffects: true,
      previousRegistry: previous,
    });
    const deniedRecord = denied.plugins.find((record) => record.id === plugin.id);
    expect(deniedRecord).toMatchObject({ enabled: false, status: "disabled" });
    expect(deniedRecord).not.toBe(previousRecord);
    await disposePluginRegistryInstances(denied, previous);
  },
);

it.each([false, true])(
  "rechecks exported memory kind when the selected slot changes (explicit enablement: %s)",
  async (explicitlyEnabled) => {
    useNoBundledPlugins();
    const plugins = ["memory-a", "memory-b", "unrelated"].map((id) =>
      writePlugin({
        id,
        body: `module.exports = { id: "${id}", ${id === "unrelated" ? "" : 'kind: "memory",'}
        register(api) { api.registerGatewayMethod("${id}.probe", () => {}); } };`,
      }),
    );
    const registries: ReturnType<typeof loadOpenClawPlugins>[] = [];
    try {
      for (const memory of ["memory-a", "memory-a", "memory-b", "none"]) {
        const previousRegistry = registries.at(-1);
        const registry = loadOpenClawPlugins({
          config: {
            plugins: {
              allow: plugins.map((plugin) => plugin.id),
              load: { paths: plugins.map((plugin) => plugin.file) },
              slots: { memory },
              entries: explicitlyEnabled
                ? { "memory-a": { enabled: true }, "memory-b": { enabled: true } }
                : undefined,
            },
          },
          cache: false,
          activate: false,
          runtimeSideEffects: true,
          previousRegistry,
        });
        registries.push(registry);
        const selected = memory === "none" ? [] : [memory];
        expect(
          registry.plugins.filter((record) => record.memorySlotSelected).map((record) => record.id),
        ).toEqual(selected);
        expect(Object.keys(registry.gatewayHandlers).toSorted()).toEqual(
          [...selected.map((id) => `${id}.probe`), "unrelated.probe"].toSorted(),
        );
        if (previousRegistry) {
          expect(registry.plugins.find((record) => record.id === "unrelated")).toBe(
            previousRegistry.plugins.find((record) => record.id === "unrelated"),
          );
        }
        if (registries.length === 2) {
          for (const [index, record] of registry.plugins.entries()) {
            expect(record).toBe(previousRegistry!.plugins[index]);
          }
        }
      }
    } finally {
      for (const registry of registries.toReversed()) {
        await disposePluginRegistryInstances(registry);
      }
    }
  },
);

it("exposes failed candidates for awaited instance disposal", async () => {
  useNoBundledPlugins();
  const disposed = path.join(makePluginLoaderTempDir(), "disposed.txt");
  const plugin = writePlugin({
    id: "failed-candidate",
    body: `
    const fs = require("node:fs");
    module.exports = { id: "failed-candidate", register(api) {
      api.lifecycle.onDispose(async () => { await Promise.resolve(); fs.writeFileSync(${JSON.stringify(disposed)}, "disposed"); });
      throw new Error("candidate rejected");
    } };
  `,
  });
  let failure: PluginLoadFailureError | undefined;
  try {
    loadOpenClawPlugins({
      config: {
        plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
      },
      activate: false,
      runtimeSideEffects: true,
      throwOnLoadError: true,
      cache: false,
    });
  } catch (error) {
    if (!(error instanceof PluginLoadFailureError)) {
      throw error;
    }
    failure = error;
  }
  expect(failure?.pluginIds).toEqual([plugin.id]);
  expect(fs.existsSync(disposed)).toBe(false);
  await disposePluginRegistryInstances(failure!.registry);
  expect(fs.readFileSync(disposed, "utf8")).toBe("disposed");
});
