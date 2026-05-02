import type { RuntimeEnv } from "../runtime.js";
import type { CliPluginRegistryPolicy } from "./command-catalog.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

let configGuardModulePromise: Promise<typeof import("./program/config-guard.js")> | undefined;

function loadConfigGuardModule() {
  configGuardModulePromise ??= import("./program/config-guard.js");
  return configGuardModulePromise;
}

export async function ensureCliCommandBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  suppressDoctorStdout?: boolean;
  skipConfigGuard?: boolean;
  allowInvalid?: boolean;
  loadPlugins?: boolean;
  pluginRegistry?: CliPluginRegistryPolicy;
}) {
  if (!params.skipConfigGuard) {
    const { ensureConfigReady } = await loadConfigGuardModule();
    await ensureConfigReady({
      runtime: params.runtime,
      commandPath: params.commandPath,
      ...(params.allowInvalid ? { allowInvalid: true } : {}),
      ...(params.suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
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
