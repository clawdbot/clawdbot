import { relative, resolve } from "node:path";
import { loadPluginManifestRegistry } from "../../manifest-registry.js";

const sourceExtensionsDir = resolve(process.cwd(), "extensions");
const bundledPluginRoots = new Map(
  loadPluginManifestRegistry({
    config: {},
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: sourceExtensionsDir,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    },
  })
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => [plugin.id, plugin.rootDir] as const),
);

export function getBundledPluginRoots(): ReadonlyMap<string, string> {
  return bundledPluginRoots;
}

export function resolveBundledPluginFile(params: {
  pluginId: string;
  relativePath: string;
}): string {
  const pluginRootDir = bundledPluginRoots.get(params.pluginId);
  if (!pluginRootDir) {
    throw new Error(`missing bundled plugin root for ${params.pluginId}`);
  }
  return resolve(pluginRootDir, params.relativePath);
}

export function bundledPluginFile(params: {
  rootDir: string;
  pluginId: string;
  relativePath: string;
}): string {
  return relative(resolve(params.rootDir, ".."), resolveBundledPluginFile(params)).replaceAll(
    "\\",
    "/",
  );
}
