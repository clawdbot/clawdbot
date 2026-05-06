import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);
type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;
const moduleWithResolver = Module as typeof Module & {
  _resolveFilename?: ResolveFilename;
};

export function isJavaScriptModulePath(modulePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}

function isMissingTargetModuleError(
  error: { code?: unknown; message?: unknown },
  modulePath: string,
): boolean {
  if (error.code !== "MODULE_NOT_FOUND" || typeof error.message !== "string") {
    return false;
  }
  const firstLine = error.message.split("\n", 1)[0] ?? "";
  return firstLine.includes(`'${modulePath}'`) || firstLine.includes(`"${modulePath}"`);
}

function isSourceTransformFallbackError(error: unknown, modulePath: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code = candidate.code;
  return (
    code === "ERR_REQUIRE_ESM" ||
    code === "ERR_REQUIRE_ASYNC_MODULE" ||
    isMissingTargetModuleError(candidate, modulePath)
  );
}

export function tryNativeRequireJavaScriptModule(
  modulePath: string,
  options: {
    allowWindows?: boolean;
    aliasMap?: Record<string, string>;
    fallbackOnMissingDependency?: boolean;
    fallbackOnNativeError?: boolean;
  } = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
  if (process.platform === "win32" && options.allowWindows !== true) {
    return { ok: false };
  }
  if (!isJavaScriptModulePath(modulePath)) {
    return { ok: false };
  }
  try {
    return { ok: true, moduleExport: requireWithOptionalAliases(modulePath, options.aliasMap) };
  } catch (error) {
    const code =
      error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (
      isSourceTransformFallbackError(error, modulePath) ||
      options.fallbackOnNativeError ||
      (options.fallbackOnMissingDependency === true &&
        (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"))
    ) {
      return { ok: false };
    }
    throw error;
  }
}

function requireWithOptionalAliases(
  modulePath: string,
  aliasMap: Record<string, string> | undefined,
): unknown {
  return withNativeRequireAliases(aliasMap, () => nodeRequire(modulePath));
}

export function withNativeRequireAliases<T>(
  aliasMap: Record<string, string> | undefined,
  run: () => T,
): T {
  if (!aliasMap || Object.keys(aliasMap).length === 0 || !moduleWithResolver._resolveFilename) {
    return run();
  }
  const originalResolveFilename = moduleWithResolver._resolveFilename;
  moduleWithResolver._resolveFilename = ((request, parent, isMain, options) => {
    const aliasTarget = aliasMap[request];
    if (aliasTarget) {
      return aliasTarget;
    }
    return originalResolveFilename(request, parent, isMain, options);
  }) satisfies ResolveFilename;
  try {
    return run();
  } finally {
    moduleWithResolver._resolveFilename = originalResolveFilename;
  }
}
