import { isRecord } from "../../packages/normalization-core/src/record-coerce.js";

/** Use Bun's native TypeScript loader without registering Node-only tsx hooks. */
export async function importToolingTypeScript(
  moduleUrl: string,
  parentUrl: string,
): Promise<Record<string, unknown>> {
  const loaded: unknown = process.versions.bun
    ? await import(moduleUrl)
    : await (await import("tsx/esm/api")).tsImport(moduleUrl, parentUrl);
  if (!isRecord(loaded)) {
    throw new Error(`TypeScript import did not return a module namespace: ${moduleUrl}`);
  }
  return loaded;
}
