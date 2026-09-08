import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTEXT_FILE = "vitest-home-source.json";
const MAX_CONTEXT_BYTES = 16 * 1024;

export function resolveTestCorepackHome(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  return (
    env.COREPACK_HOME ??
    path.join(
      env.XDG_CACHE_HOME ??
        env.LOCALAPPDATA ??
        path.join(home, process.platform === "win32" ? "AppData/Local" : ".cache"),
      "node/corepack",
    )
  );
}

/** Installed browser binaries, like Corepack, are tooling rather than application state. */
export function resolveTestBrowserCache(env: NodeJS.ProcessEnv, home: string): string | undefined {
  const explicit =
    env.PLAYWRIGHT_BROWSERS_PATH ??
    env.npm_config_playwright_browsers_path ??
    env.npm_package_config_playwright_browsers_path;
  if (explicit) {
    return explicit;
  }
  // Playwright's registry resolves this default at import time, before worker setup.
  const cache =
    process.platform === "darwin"
      ? path.join(home, "Library", "Caches")
      : process.platform === "win32"
        ? env.LOCALAPPDATA || path.join(home, "AppData", "Local")
        : process.platform === "linux"
          ? env.XDG_CACHE_HOME || path.join(home, ".cache")
          : undefined;
  return cache === undefined ? undefined : path.join(cache, "ms-playwright");
}

/** Invocation selection data, never consent to load profiles or stage credentials. */
export function writeTestHomeSource(namespace: string, sourceHome: string): void {
  const context = JSON.stringify({ version: 1, home: path.join(namespace, "home"), sourceHome });
  if (!path.isAbsolute(sourceHome) || Buffer.byteLength(context) > MAX_CONTEXT_BYTES) {
    throw new Error("[vitest] invalid invocation home source");
  }
  fs.writeFileSync(path.join(namespace, CONTEXT_FILE), context, { flag: "wx", mode: 0o600 });
}

/** Only initial live-aware setup uses the launch source; nested fixture homes stay local. */
export function readTestHomeSource(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME;
  const namespace = env.TMPDIR;
  if (
    !namespace ||
    !path.isAbsolute(namespace) ||
    home !== path.join(namespace, "home") ||
    env.USERPROFILE !== home ||
    env.TMP !== namespace ||
    env.TEMP !== namespace
  ) {
    return undefined;
  }
  let fd: number;
  try {
    fd = fs.openSync(path.join(namespace, CONTEXT_FILE), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const buffer = Buffer.alloc(MAX_CONTEXT_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_CONTEXT_BYTES) {
      throw new Error("[vitest] oversized invocation home source");
    }
    const context: unknown = JSON.parse(buffer.toString("utf8", 0, length));
    if (
      !context ||
      typeof context !== "object" ||
      Array.isArray(context) ||
      Object.keys(context).length !== 3 ||
      !("version" in context) ||
      context.version !== 1 ||
      !("home" in context) ||
      context.home !== home ||
      !("sourceHome" in context) ||
      typeof context.sourceHome !== "string" ||
      !path.isAbsolute(context.sourceHome)
    ) {
      throw new Error("[vitest] invalid invocation home source");
    }
    return context.sourceHome;
  } finally {
    fs.closeSync(fd);
  }
}
