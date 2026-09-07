import { createRequire } from "node:module";

const storeModulePath = createRequire(import.meta.url).resolve("@openclaw/fs-safe/store");

/** Native fixture processes must reread state under the same cross-process write lock. */
export function managedServiceStateUpdateScript(statePath: string, update: string): string {
  return `await require(${JSON.stringify(storeModulePath)}).jsonStore({
    filePath: ${JSON.stringify(statePath)}, lock: true,
  }).updateOr({}, (state) => { ${update}; return state; })`;
}
