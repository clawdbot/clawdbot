import { toSafeImportPath } from "./import-specifier.js";

export { toSafeImportPath as toSafeRuntimeImportPath } from "./import-specifier.js";

/** Resolves a runtime import part against a base URL/path after platform-safe normalization. */
export function resolveRuntimeImportSpecifier(baseUrl: string, parts: readonly string[]): string {
  const joined = parts.join("");
  const safeJoined = toSafeImportPath(joined);
  if (safeJoined !== joined) {
    return safeJoined;
  }
  return new URL(joined, toSafeImportPath(baseUrl)).href;
}

/** Imports a lazy runtime module through the normalized runtime specifier. */
export async function importRuntimeModule<T>(
  baseUrl: string,
  parts: readonly string[],
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<T> {
  return (await importModule(resolveRuntimeImportSpecifier(baseUrl, parts))) as T;
}
