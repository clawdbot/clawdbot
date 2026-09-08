import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveManagedCodexNativeCommand } from "./managed-binary.js";

/** The caller owns the canonical temporary root and joins children before removing it. */
export async function createCodexNativeTestState(root: string) {
  const home = path.join(root, "home");
  const codexHome = path.join(home, ".codex");
  const cwd = path.join(root, "workspace");
  const tmp = path.join(root, "tmp");
  await Promise.all([codexHome, cwd, tmp].map((dir) => fs.mkdir(dir, { recursive: true })));
  const require = createRequire(import.meta.url);
  const launcher = path.join(
    path.dirname(require.resolve("@openai/codex/package.json")),
    "bin/codex.js",
  );
  const command = resolveManagedCodexNativeCommand(launcher);
  if (!command) {
    throw new Error("Install the pinned @openai/codex platform package before native tests.");
  }
  const proxy = "http://127.0.0.1:9";
  // Both native proofs use a child-only allowlist, never the operator's environment.
  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
  return { command, launcher, cwd, codexHome, tmp, env };
}
