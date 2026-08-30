import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { installPluginMetadataOwner } from "../current-plugin-metadata.test-support.js";
import { createPluginCache, withPluginCache } from "../plugin-cache.js";
import { createPluginMetadataOwner, preparePluginMetadata } from "../plugin-metadata-collection.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "../plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "../test-helpers/fs-fixtures.js";
import { resolvePluginRuntimeLoadContext } from "./load-context.resolve.js";

describe("plugin runtime load context current snapshot ownership", () => {
  const tempDirs: string[] = [];
  let root: string;
  let env: NodeJS.ProcessEnv;
  let releaseOwner: (() => void) | undefined;
  let releaseGateway: (() => void) | undefined;

  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    root = fs.realpathSync(makeTrackedTempDir("openclaw-runtime-metadata", tempDirs));
    const bundledPluginsDir = path.join(root, "bundled");
    mkdirSafeDir(bundledPluginsDir);
    env = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    releaseGateway?.();
    releaseGateway = undefined;
    releaseOwner?.();
    releaseOwner = undefined;
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
  });

  function pluginAt(rootDir: string, pluginId: string) {
    mkdirSafeDir(rootDir);
    return createColdPluginFixture({ rootDir, pluginId });
  }

  it.each(["explicit snapshot", "operation preparation"])(
    "keeps %s isolated from the Gateway startup inventory",
    (mode) => {
      const lifecycle = pluginAt(path.join(root, "lifecycle"), "lifecycle");
      const operation = pluginAt(path.join(root, "operation"), "operation");
      const lifecycleWorkspace = path.join(root, "lifecycle-workspace");
      const otherWorkspace = path.join(root, "other-workspace");
      const workspacePlugin = pluginAt(
        path.join(lifecycleWorkspace, ".openclaw", "extensions", "workspace-plugin"),
        "workspace-plugin",
      );
      const lifecycleConfig: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            lifecycle: { workspace: lifecycleWorkspace },
            other: { workspace: otherWorkspace },
          },
        },
        plugins: {
          load: { paths: [lifecycle.rootDir] },
          allow: [lifecycle.pluginId, workspacePlugin.pluginId],
        },
      };
      const operationWorkspace = path.join(root, "operation-workspace");
      const operationConfig: OpenClawConfig = {
        plugins: { load: { paths: [operation.rootDir] }, allow: [operation.pluginId] },
      };
      const pluginCache = createPluginCache();
      const owner = createPluginMetadataOwner(pluginCache);
      releaseOwner = installPluginMetadataOwner(owner, pluginCache);
      releaseGateway = retainGatewayPluginMetadata();
      const boot = owner.prepare({ config: lifecycleConfig, env });
      owner.publish(boot, { config: lifecycleConfig, env });

      const context = withPluginCache(createPluginCache(), () => {
        const metadataSnapshot =
          mode === "explicit snapshot"
            ? preparePluginMetadata({
                config: operationConfig,
                env,
                workspaceDir: operationWorkspace,
              }).selectedSnapshot
            : undefined;
        return resolvePluginRuntimeLoadContext({
          config: operationConfig,
          env,
          workspaceDir: operationWorkspace,
          ...(metadataSnapshot ? { metadataSnapshot } : {}),
        });
      });

      expect(context.metadataSnapshot?.plugins.map((plugin) => plugin.id)).toEqual([
        operation.pluginId,
      ]);
      expect(context.workspaceDir).toBe(operationWorkspace);
      expect(owner.getActive()).toBe(boot);
      const unchanged = resolvePluginRuntimeLoadContext({
        config: lifecycleConfig,
        env,
        workspaceDir: lifecycleWorkspace,
      });
      expect(unchanged.metadataSnapshot).toBe(boot.workspaces.get(lifecycleWorkspace));
      expect(unchanged.metadataSnapshot?.plugins.map((plugin) => plugin.id)).toEqual([
        lifecycle.pluginId,
        workspacePlugin.pluginId,
      ]);
      const shared = resolvePluginRuntimeLoadContext({ config: lifecycleConfig, env });
      expect(shared.metadataSnapshot).toBe(boot.selectedSnapshot);
      expect(shared.metadataSnapshot?.plugins.map((plugin) => plugin.id)).toEqual([
        lifecycle.pluginId,
      ]);
      const reads = [
        vi.spyOn(fs, "existsSync"),
        vi.spyOn(fs, "lstatSync"),
        vi.spyOn(fs, "openSync"),
        vi.spyOn(fs, "readdirSync"),
        vi.spyOn(fs, "readFileSync"),
        vi.spyOn(fs, "statSync"),
        vi.spyOn(fs.realpathSync, "native"),
      ];
      const reconfigured = resolvePluginRuntimeLoadContext({
        config: operationConfig,
        env,
        workspaceDir: operationWorkspace,
      });
      const metadataReads = reads.flatMap((read) =>
        read.mock.calls.flatMap(([target]) =>
          typeof target === "string" && (target === root || target.startsWith(`${root}${path.sep}`))
            ? [target]
            : [],
        ),
      );
      for (const read of reads) {
        read.mockRestore();
      }
      expect(reconfigured.rawConfig).toBe(operationConfig);
      expect(reconfigured.workspaceDir).toBe(operationWorkspace);
      expect(reconfigured.metadataSnapshot?.plugins.map((plugin) => plugin.id)).toEqual([
        lifecycle.pluginId,
      ]);
      expect(metadataReads).toEqual([]);
      expect(owner.getActive()).toBe(boot);
      for (const plugin of [lifecycle, operation, workspacePlugin]) {
        expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
      }
    },
  );
});
