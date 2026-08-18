// Creates temporary OpenClaw directories for runtime scratch work.
import { getWorkerDeploySecureTempRoot } from "../worker/worker-deploy-runtime-registry.js";

/** Preferred shared OpenClaw temp root on POSIX systems when ownership and permissions are safe. */
export const DEFAULT_POSIX_TMP_ROOT = "/tmp/openclaw";

type SecureDirStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
  uid?: number;
};

/** Injectable filesystem/platform hooks for resolving the preferred temp root in tests. */
export type ResolvePreferredOpenClawTmpDirOptions = {
  accessSync?: (path: string, mode?: number) => void;
  chmodSync?: (path: string, mode: number) => void;
  getuid?: () => number | undefined;
  lstatSync?: (path: string) => SecureDirStat;
  mkdirSync?: (path: string, opts: { recursive: boolean; mode?: number }) => void;
  platform?: NodeJS.Platform;
  tmpdir?: () => string;
  warn?: (message: string) => void;
};

type ResolveSecureTempRoot = typeof import("@openclaw/fs-safe/temp").resolveSecureTempRoot;

let resolveSecureTempRootRuntime: ResolveSecureTempRoot | undefined;
declare const WORKER_DEPLOY_BUILD: boolean;

function loadResolveSecureTempRoot(): ResolveSecureTempRoot {
  if (resolveSecureTempRootRuntime) {
    return resolveSecureTempRootRuntime;
  }
  const injected = getWorkerDeploySecureTempRoot();
  if (injected) {
    resolveSecureTempRootRuntime = injected;
    return injected;
  }
  if (typeof WORKER_DEPLOY_BUILD === "boolean" && WORKER_DEPLOY_BUILD) {
    throw new Error("worker temp-root runtime was not registered before use");
  }
  // Keep this module browser-import safe: fs-safe's temp barrel owns Node-only
  // workspaces, so load it only when the Node runtime actually resolves a temp root.
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    throw new Error("Node module loading is unavailable for secure temp-root resolution");
  }
  const moduleNamespace = getBuiltinModule("module") as {
    createRequire?: (id: string) => NodeJS.Require;
  };
  if (typeof moduleNamespace.createRequire !== "function") {
    throw new Error("Node createRequire is unavailable for secure temp-root resolution");
  }
  const require = moduleNamespace.createRequire(import.meta.url);
  const fsSafeTemp = require("@openclaw/fs-safe/temp") as typeof import("@openclaw/fs-safe/temp");
  resolveSecureTempRootRuntime = fsSafeTemp.resolveSecureTempRoot;
  return resolveSecureTempRootRuntime;
}

/** Resolves a safe OpenClaw temp root, falling back to user-scoped os.tmpdir paths when needed. */
export function resolvePreferredOpenClawTmpDir(
  options: ResolvePreferredOpenClawTmpDirOptions = {},
): string {
  return loadResolveSecureTempRoot()({
    ...options,
    preferredDir: DEFAULT_POSIX_TMP_ROOT,
    fallbackPrefix: "openclaw",
    warningPrefix: "[openclaw]",
    unsafeFallbackLabel: "OpenClaw temp dir",
    skipPreferredOnWindows: true,
  });
}
