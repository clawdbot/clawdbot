// CLI startup presentation and config-before-plugin bootstrap.
import type { ConfigFileSnapshot } from "../config/types.js";
import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

const hasJsonFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V");

export async function applyCliExecutionStartupPresentation(params: {
  argv?: string[];
  routeLogsToStderrOnSuppress?: boolean;
  startupPolicy: CliStartupPolicy;
  showBanner?: boolean;
  version?: string;
}) {
  // Machine-readable commands must route diagnostics away before startup can print.
  if (params.startupPolicy.suppressDoctorStdout && params.routeLogsToStderrOnSuppress !== false) {
    routeLogsToStderr();
  }
  if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) {
    return;
  }
  if (params.argv && (hasJsonFlag(params.argv) || hasVersionFlag(params.argv))) {
    return;
  }
  const { emitCliBanner } = await import("./banner.js");
  if (params.argv) {
    emitCliBanner(params.version, { argv: params.argv });
    return;
  }
  emitCliBanner(params.version);
}

export async function ensureCliExecutionBootstrap(params: {
  runtime: RuntimeEnv;
  commandPath: string[];
  startupPolicy: CliStartupPolicy;
  allowInvalid?: boolean;
  beforeStateMigrations?: (snapshot?: ConfigFileSnapshot) => Promise<boolean>;
  loadPlugins?: boolean;
  skipConfigGuard?: boolean;
  validateConfigOnly?: boolean;
  skipPristineCoreStateMigrations?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}) {
  const {
    runtime,
    commandPath,
    startupPolicy,
    allowInvalid,
    beforeStateMigrations,
    skipPristineCoreStateMigrations,
    skipPristineStartupStateMigrations,
  } = params;
  const { suppressDoctorStdout, pluginRegistry } = startupPolicy;
  const loadPlugins = params.loadPlugins ?? startupPolicy.loadPlugins;
  const skipConfigGuard = params.skipConfigGuard ?? startupPolicy.skipConfigGuard;
  const validateConfigOnly = params.validateConfigOnly ?? startupPolicy.validateConfigOnly;
  if (!skipConfigGuard) {
    await measureCliCommandStartup("config-ready", async () => {
      const { ensureConfigReady } = await configGuardModuleLoader.load();
      await ensureConfigReady({
        runtime,
        commandPath,
        measure: (stage, run) => measureCliCommandStartup(stage, run),
        ...(allowInvalid ? { allowInvalid: true } : {}),
        ...(validateConfigOnly ? { validateConfigOnly: true } : {}),
        ...(beforeStateMigrations ? { beforeStateMigrations } : {}),
        ...(suppressDoctorStdout ? { suppressDoctorStdout: true } : {}),
        ...(skipPristineStartupStateMigrations ? { skipPristineStartupStateMigrations: true } : {}),
        ...(skipPristineCoreStateMigrations ? { skipPristineCoreStateMigrations: true } : {}),
      });
    });
  }
  if (!loadPlugins) {
    return;
  }
  await measureCliCommandStartup("plugin-registry", () =>
    ensureCliPluginRegistryLoaded({
      scope: pluginRegistry.scope,
      routeLogsToStderr: suppressDoctorStdout,
    }),
  );
}
