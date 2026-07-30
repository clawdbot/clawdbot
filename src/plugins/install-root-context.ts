import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveConfigDir } from "../utils.js";

const PLUGIN_INSTALL_ROOT_CONTEXT_KEY = Symbol.for("openclaw.pluginInstallRootContext");

/** Immutable roots that own installed plugin artifacts and their registry. */
export type PluginInstallRoots = Readonly<{
  extensionsDir: string;
  gitDir: string;
  npmDir: string;
  stateDir: string;
}>;

const pluginInstallRootContext = resolveGlobalSingleton<AsyncLocalStorage<PluginInstallRoots>>(
  PLUGIN_INSTALL_ROOT_CONTEXT_KEY,
  () => new AsyncLocalStorage(),
);

/** Resolve the ordinary operator-owned plugin roots before a run redirects state. */
export function resolvePluginInstallRoots(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): PluginInstallRoots {
  const configDir = resolveConfigDir(env, homedir);
  return Object.freeze({
    extensionsDir: path.join(configDir, "extensions"),
    gitDir: path.join(configDir, "git"),
    npmDir: path.join(configDir, "npm"),
    stateDir: resolveStateDir(env, homedir),
  });
}

/** Return run-pinned install roots, or resolve the caller's ordinary roots. */
export function resolveActivePluginInstallRoots(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): PluginInstallRoots {
  return pluginInstallRootContext.getStore() ?? resolvePluginInstallRoots(env, homedir);
}

/**
 * Keep plugin discovery on one operator-owned install generation while a run
 * redirects OPENCLAW_STATE_DIR for ephemeral sessions and runtime state.
 */
export function withPluginInstallRoots<T>(roots: PluginInstallRoots, run: () => T): T {
  return pluginInstallRootContext.run(roots, run);
}
