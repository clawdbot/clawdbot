// Shared command preflight: config readiness plus optional plugin registry activation.
import type { ConfigFileSnapshot } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { CliPluginRegistryPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";
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
  validateConfigOnly?: boolean;
  allowInvalid?: boolean;
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  loadPlugins?: boolean;
  pluginRegistry?: CliPluginRegistryPolicy;
  skipPristineCoreStateMigrations?: boolean;
  skipPristineStartupStateMigrations?: boolean;
  stateMigrationAgentId?: string;
}) {
  if (!params.skipConfigGuard) {
    await measureCliCommandStartup("config-ready", async () => {
      const { ensureConfigReady } = await loadConfigGuardModule();
      await ensureConfigReady({
        runtime: params.runtime,
        commandPath: params.commandPath,
        measure: (stage, run) => measureCliCommandStartup(stage, run),
        ...(params.allowInvalid ? { allowInvalid: true } : {}),
        ...(params.validateConfigOnly ? { validateConfigOnly: true } : {}),
        ...(params.beforeStateMigrations
          ? { beforeStateMigrations: params.beforeStateMigrations }
          : {}),
        ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
        stateMigrationAgentId: params.stateMigrationAgentId,
        ...(params.skipPristineStartupStateMigrations
          ? { skipPristineStartupStateMigrations: true }
          : {}),
        ...(params.skipPristineCoreStateMigrations
          ? { skipPristineCoreStateMigrations: true }
          : {}),
      });
    });
  }
  if (!params.loadPlugins) {
    return;
  }
  const pluginRegistryLoadPolicy =
    params.pluginRegistry ?? resolveCliCommandPathPolicy(params.commandPath).pluginRegistry;
  await measureCliCommandStartup("plugin-registry", () =>
    ensureCliPluginRegistryLoaded({
      scope: pluginRegistryLoadPolicy.scope,
      routeLogsToStderr: params.suppressDoctorStdout,
    }),
  );
}
