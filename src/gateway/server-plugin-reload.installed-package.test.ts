import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writePersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
} from "../plugins/runtime.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];
const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    closeOpenClawStateDatabaseForTest();
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
  }
});

it("loads installed package roots from the durable ledger and refreshes their helpers without restarting siblings", async () => {
  const bootstrap = await import("./server-plugin-bootstrap.js");
  const root = makeTrackedTempDir("openclaw-gateway-plugin-ledger-reload", tempDirs);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
  };
  const writePackage = (id: string) => {
    const packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName: id,
      pluginId: id,
      version: "1.0.0",
    });
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id, activation: { onStartup: true }, configSchema: { type: "object" } }),
    );
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "A";');
    fs.writeFileSync(
      path.join(packageDir, "dist", "index.js"),
      `const helper = require("./helper.cjs");
const instance = require("node:crypto").randomUUID();
let starts = 0, stops = 0;
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerService({ id: ${JSON.stringify(id)}, start() { starts++; }, stop() { stops++; } });
  api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => {
    respond(true, { helper, instance, starts, stops });
  });
} };`,
    );
    return packageDir;
  };
  await withEnvAsync(env, async () => {
    const siblingDir = writePackage("sibling");
    const initialConfig: OpenClawConfig = {
      plugins: {
        allow: ["sibling"],
        entries: { sibling: { enabled: true } },
        load: { paths: [siblingDir] },
        slots: { memory: "none" },
      },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const log = { ...createSubsystemLogger("gateway/plugins"), ...logs };
    const initial = bootstrap.prepareGatewayPluginLoad({
      cfg: initialConfig,
      workspaceDir,
      env,
      log,
      baseMethods: [],
      ambientEnvTriggers: "suppress",
    });
    let currentServices: PluginServicesHandle | null = await startPluginServices({
      registry: initial.pluginRegistry,
      config: initialConfig,
      workspaceDir,
    });
    const owner = createGatewayPluginRuntimeGeneration({
      getServices: () => currentServices,
      setServices: (handle) => {
        currentServices = handle;
      },
    });
    const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, workspaceDir);
    const loaded = [initial];
    cleanups.push(async () => {
      try {
        await currentServices?.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 });
      } finally {
        for (const generation of loaded) {
          generation.retireGatewayRuntimeBindings?.();
        }
        await registryOwner.close();
      }
    });
    const runtime = {
      pluginRuntime: registryOwner,
      pluginWorkspaceDir: workspaceDir,
      kernel: { pluginRuntimeGeneration: owner },
      runtimeState: { cronState: {}, gatewayLifetimeSidecars: [] },
      ambientEnvTriggers: "suppress",
      coreGatewayMethodNames: [],
      baseMethods: [],
      channelManager: {
        pauseChannelStarts: () => () => {},
        setAmbientAutostartSuppressedChannelIds: vi.fn(),
      },
      clients: new Set(),
      broadcast: vi.fn(),
    } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
    const probe = async (id: string) => {
      const method = `${id}.probe`;
      const respond = vi.fn();
      const handler = runtime.pluginRuntime.registry.gatewayHandlers[method];
      assert.ok(handler, `${method} must be registered`);
      await handler({
        req: { type: "req", id: "ledger-reload", method },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as GatewayRequestHandlerOptions["context"],
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          helper: expect.any(String),
          instance: expect.any(String),
          starts: 1,
          stops: 0,
        },
        undefined,
        undefined,
      );
      const response = respond.mock.calls[0];
      assert.ok(response);
      return response[1];
    };
    const sibling = await probe("sibling");
    const siblingRecord = initial.pluginRegistry.plugins.find((record) => record.id === "sibling");
    const siblingHandler = initial.pluginRegistry.gatewayHandlers["sibling.probe"];
    const packageDir = writePackage("installed-probe");
    const config: OpenClawConfig = {
      plugins: {
        ...initialConfig.plugins,
        allow: ["sibling", "installed-probe"],
        entries: { sibling: { enabled: true }, "installed-probe": { enabled: true } },
      },
    };
    // Managed npm roots live outside discovery directories and are owned by the persisted ledger.
    writePersistedInstalledPluginIndexSync(
      loadInstalledPluginIndex({
        config,
        env,
        workspaceDir,
        installRecords: {
          "installed-probe": {
            source: "npm",
            spec: "installed-probe@1.0.0",
            installPath: packageDir,
          },
        },
      }),
      { env },
    );
    const reload = async () =>
      await reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => bootstrap,
          prepareAttachedPluginRuntime: async (candidate) => {
            loaded.push(candidate);
            return {
              publish: () => {
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  workspaceDir,
                  runtime.pluginRuntime.registry,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: () => {},
            };
          },
        },
        {
          nextConfig: config,
          sourceConfig: config,
          changedPaths: [],
          pluginLifecycle: {
            reason: "reload",
            operationId: "installed-package-reload",
            pluginIds: ["installed-probe"],
          },
          commitRuntime: async (publication) => {
            publication?.publish();
            setRuntimeConfigSnapshot(config);
            publication?.afterCommit?.();
          },
          env,
        },
      );
    await reload();
    const first = await probe("installed-probe");
    expect(first.helper).toBe("A");
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "B";');
    await reload();
    const second = await probe("installed-probe");
    expect(second.helper).toBe("B");
    expect(second.instance).not.toBe(first.instance);
    expect(runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling")).toBe(
      siblingRecord,
    );
    expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(siblingHandler);
    expect(await probe("sibling")).toEqual(sibling);
  });
});
