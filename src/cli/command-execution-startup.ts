import { routeLogsToStderr } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { ensureCliCommandBootstrap } from "./command-bootstrap.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";

type CliStartupPolicy = ReturnType<typeof resolveCliStartupPolicy>;

export function resolveCliExecutionStartupContext(params: {
  argv: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const invocation = resolveCliArgvInvocation(params.argv);
  const { commandPath } = invocation;
  return {
    invocation,
    commandPath,
    startupPolicy: resolveCliStartupPolicy({
      argv: params.argv,
      commandPath,
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
  if (params.startupPolicy.suppressDoctorStdout && params.routeLogsToStderrOnSuppress !== false) {
    routeLogsToStderr();
  }
  if (params.startupPolicy.hideBanner || params.showBanner === false || !params.version) {
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
  loadPlugins?: boolean;
  skipConfigGuard?: boolean;
}) {
  await ensureCliCommandBootstrap({
    runtime: params.runtime,
    commandPath: params.commandPath,
    suppressDoctorStdout: params.startupPolicy.suppressDoctorStdout,
    allowInvalid: params.allowInvalid,
    loadPlugins: params.loadPlugins ?? params.startupPolicy.loadPlugins,
    pluginRegistry: params.startupPolicy.pluginRegistry,
    skipConfigGuard: params.skipConfigGuard ?? params.startupPolicy.skipConfigGuard,
  });
}
