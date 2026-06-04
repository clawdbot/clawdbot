/** Resolves createRequire from process.getBuiltinModule without static CommonJS imports. */
export function resolveNodeRequireFromMeta(metaUrl: string): NodeJS.Require | null {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return null;
  }
  try {
    const moduleNamespace = getBuiltinModule("module") as {
      createRequire?: (id: string) => NodeJS.Require;
    };
    const createRequire =
      typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
    return createRequire ? createRequire(metaUrl) : null;
  } catch {
    return null;
  }
}
