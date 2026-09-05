import { getRuntimeConfig } from "../../config/config.js";
import { loadFacadeModuleAtLocationSync } from "../../plugin-sdk/facade-loader.js";
import { shouldRejectHardlinkedPluginFiles } from "../hardlink-policy.js";
import { getPluginInstance } from "../plugin-instance-scope.js";
import { resolvePluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import { resolvePluginRootPublicSurfacePath } from "../public-surface-runtime.js";
import { getPluginRegistryForContext } from "../runtime-context.js";

function readColdPluginRecords() {
  let config;
  try {
    config = getRuntimeConfig();
  } catch {
    config = {};
  }
  return resolvePluginMetadataSnapshot({ config }).plugins;
}

/** Package-root embedding API; runtime instances and cold callers share the public-surface loader. */
export async function monitorWebChannel(...args: unknown[]): Promise<unknown> {
  const registry = getPluginRegistryForContext();
  // An admitted runtime never falls back to installed bytes after disable or uninstall.
  const records = registry
    ? registry.plugins.filter((record) => record.status === "loaded")
    : readColdPluginRecords();
  const matches = records.flatMap((record) => {
    const pluginRoot = record.rootDir;
    if (!pluginRoot) {
      return [];
    }
    const resolve = (artifactBasename: string) =>
      resolvePluginRootPublicSurfacePath({
        pluginRoot,
        pluginId: record.id,
        entrySource: record.source,
        artifactBasename,
      });
    const modulePath = resolve("runtime-api.js");
    return modulePath && resolve("light-runtime-api.js")
      ? [{ record, modulePath, pluginRoot }]
      : [];
  });
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `plugin runtime boundary is ambiguous for entries [light-runtime-api, runtime-api]: ${matches.map(({ record }) => record.id).join(", ")}`
        : "web channel plugin runtime is unavailable: missing plugin that provides light-runtime-api and runtime-api",
    );
  }
  const { record, modulePath, pluginRoot } = matches[0]!;
  const owner = registry?.plugins.find((entry) => entry === record);
  const instance = owner ? getPluginInstance(owner) : undefined;
  if (owner && !instance) {
    throw new Error(`Plugin ${owner.id} has no runtime module owner`);
  }
  const loaded = loadFacadeModuleAtLocationSync<{
    monitorWebChannel: (...args: unknown[]) => Promise<unknown>;
  }>({
    location: { modulePath, boundaryRoot: pluginRoot, pluginId: record.id },
    boundary: {
      boundaryLabel: "plugin root",
      rejectHardlinks: shouldRejectHardlinkedPluginFiles({
        origin: record.origin,
        rootDir: pluginRoot,
      }),
    },
  });
  return (instance?.wrap(loaded) ?? loaded).monitorWebChannel(...args);
}
