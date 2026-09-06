import { fileURLToPath } from "node:url";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";

/** Keep TypeScript tooling imports on the current runtime and its supported loader. */
export async function importToolingTypeScript(
  moduleUrl: string,
  parentUrl: string,
): Promise<Record<string, unknown>> {
  let loaded: unknown;
  if (process.versions.bun) {
    const [{ createJiti }, { buildPluginLoaderAliasMap, buildPluginLoaderJitiOptions }] =
      await Promise.all([import("jiti"), import("../../src/plugins/sdk-alias.js")]);
    const modulePath = fileURLToPath(moduleUrl);
    const aliases = buildPluginLoaderAliasMap(modulePath, "", parentUrl, "src");
    const jiti = createJiti(parentUrl, {
      ...buildPluginLoaderJitiOptions(aliases, { modulePath }),
      tryNative: false,
      interopDefault: false,
      fsCache: false,
    });
    loaded = await jiti.import(moduleUrl);
  } else {
    loaded = await (await import("tsx/esm/api")).tsImport(moduleUrl, parentUrl);
  }
  if (!isRecord(loaded)) {
    throw new Error(`TypeScript import did not return a module namespace: ${moduleUrl}`);
  }
  return loaded;
}
