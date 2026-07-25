// CLI startup context, banner/log presentation, and bootstrap orchestration.
import type { ConfigFileSnapshot } from "../config/types.js";
import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { ensureCliCommandBootstrap } from "./command-bootstrap.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

const hasJsonFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--json" || arg.startsWith("--json="));

const hasVersionFlag = (argv: readonly string[]) =>
  argv.some((arg) => arg === "--version" || arg === "-V");

export function resolveCliExecutionStartupContext(params: {
  argv: string[];
  protocolCommandPath?: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  // Resolve argv once so startup policy, routing, and bootstrap share the same command path.
  const invocation = resolveCliArgvInvocation(params.argv);
  const { commandPath } = invocation;
  return {
    invocation,
    commandPath,
    startupPolicy: resolveCliStartupPolicy({
      argv: params.argv,
      commandPath,
      protocolCommandPath: params.protocolCommandPath,
      jsonOutputMode: params.jsonOutputMode,
      env: params.env,
      routeMode: params.routeMode,
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
  skipPristineCoreStateMigrations?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}) {
  await ensureCliCommandBootstrap({
    runtime: params.runtime,
    commandPath: params.commandPath,
    suppressDoctorStdout: params.startupPolicy.suppressDoctorStdout,
    allowInvalid: params.allowInvalid,
    ...(params.beforeStateMigrations
      ? { beforeStateMigrations: params.beforeStateMigrations }
      : {}),
    loadPlugins: params.loadPlugins ?? params.startupPolicy.loadPlugins,
    pluginRegistry: params.startupPolicy.pluginRegistry,
    skipConfigGuard: params.skipConfigGuard ?? params.startupPolicy.skipConfigGuard,
    ...(params.skipPristineStartupStateMigrations
      ? { skipPristineStartupStateMigrations: true }
      : {}),
    ...(params.skipPristineCoreStateMigrations ? { skipPristineCoreStateMigrations: true } : {}),
  });
}
