import { AsyncLocalStorage } from "node:async_hooks";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** A local command destination, independent of the agent's temporary runtime state. */
export type InstallationTarget = Readonly<{
  stateDir: string;
  configPath: string;
  defaultWorkspaceDir: string;
}>;

const installationTargetContext = resolveGlobalSingleton(
  Symbol.for("openclaw.installationTargetContext"),
  () => new AsyncLocalStorage<InstallationTarget | undefined>(),
);

export const LOCAL_INSTALLATION_TARGET_UNSUPPORTED =
  "This runtime cannot target the diagnosed local installation. Use the saved prompt with a suggested external or manual handoff on this machine.";

export function resolveInstallationTarget(
  env: NodeJS.ProcessEnv = process.env,
): InstallationTarget {
  const stateDir = resolveStateDir(env);
  return Object.freeze({
    stateDir,
    configPath: resolveConfigPath(env, stateDir),
    defaultWorkspaceDir: resolveDefaultAgentWorkspaceDir(env),
  });
}

export function getInstallationTarget(): InstallationTarget | undefined {
  return installationTargetContext.getStore();
}

export function installationTargetEnv(target: InstallationTarget | undefined) {
  return target
    ? Object.freeze({
        OPENCLAW_STATE_DIR: target.stateDir,
        OPENCLAW_CONFIG_PATH: target.configPath,
        OPENCLAW_WORKSPACE_DIR: target.defaultWorkspaceDir,
      })
    : undefined;
}

export function withInstallationTarget<T>(target: InstallationTarget | undefined, run: () => T): T {
  return installationTargetContext.run(target ? Object.freeze({ ...target }) : undefined, run);
}
