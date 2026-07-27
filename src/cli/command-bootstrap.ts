// Shared command preflight: config readiness plus optional plugin registry activation.
import type { ConfigFileSnapshot } from "../config/types.js";
import type { PluginRuntimeMode } from "../plugins/plugin-runtime-mode.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

function loadConfigGuardModule() {
  return configGuardModuleLoader.load();
}

/** Run the lazy command bootstrap steps selected by command policy. */
export async function ensureCliCommandBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  suppressDoctorStdout?: boolean;
  skipConfigGuard?: boolean;
  allowInvalid?: boolean;
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  loadPlugins?: boolean;
  pluginRegistry?: CliPluginRegistryPolicy;
  skipPristineCoreStateMigrations?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}) {
  const pluginRuntime: PluginRuntimeMode = params.loadPlugins === false ? "none" : "full";
  if (!params.skipConfigGuard) {
    const { ensureConfigReady } = await loadConfigGuardModule();
    // Plugin-free commands must keep doctor from re-entering executable plugin surfaces
    // before the explicit registry-loading gate below.
    await ensureConfigReady({
      runtime: params.runtime,
      commandPath: params.commandPath,
      pluginRuntime,
      ...(params.allowInvalid ? { allowInvalid: true } : {}),
      ...(params.beforeStateMigrations
        ? { beforeStateMigrations: params.beforeStateMigrations }
        : {}),
      ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
      ...(params.skipPristineStartupStateMigrations
        ? { skipPristineStartupStateMigrations: true }
        : {}),
      ...(params.skipPristineCoreStateMigrations ? { skipPristineCoreStateMigrations: true } : {}),
    });
  }
  if (!params.loadPlugins) {
    return;
  }
  const pluginRegistryLoadPolicy =
    params.pluginRegistry ?? resolveCliCommandPathPolicy(params.commandPath).pluginRegistry;
  await ensureCliPluginRegistryLoaded({
    scope: pluginRegistryLoadPolicy.scope,
    routeLogsToStderr: params.suppressDoctorStdout,
  });
}
