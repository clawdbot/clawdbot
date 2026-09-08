// CLI startup context, banner/log presentation, and bootstrap orchestration.
import type { ConfigFileSnapshot } from "../config/types.js";
import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { measureCliCommandStartup } from "./command-startup-timing.js";
import { ensureCliPluginRegistryLoaded } from "./plugin-registry-loader.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

const configGuardModuleLoader = createLazyImportLoader(() => import("./program/config-guard.js"));

const hasJsonFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V");

export function resolveCliExecutionStartupContext(params: {
  argv: string[];
  commandPath?: string[];
  jsonOutputMode: boolean;
  machineOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const invocation = resolveCliArgvInvocation(params.argv);
  // Commander owns the action path after parsing option values. Route-first
  // callers omit it and keep using raw argv discovery.
  const commandPath = params.commandPath ?? invocation.commandPath;
  return {
    invocation,
    commandPath,
    startupPolicy: resolveCliStartupPolicy({
      argv: params.argv,
      commandPath,
      jsonOutputMode: params.jsonOutputMode,
      machineOutputMode: params.machineOutputMode,
      env: params.env,
    }),
  };
}

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
