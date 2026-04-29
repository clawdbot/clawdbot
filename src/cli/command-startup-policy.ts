import { isTruthyEnvValue } from "../infra/env.js";
import { resolveCliCommandPathPolicy } from "./command-path-policy.js";

export function shouldBypassConfigGuardForCommandPath(commandPath: string[]): boolean {
  return resolveCliCommandPathPolicy(commandPath).bypassConfigGuard;
}

export function shouldSkipRouteConfigGuardForCommandPath(params: {
  commandPath: string[];
  suppressDoctorStdout: boolean;
}): boolean {
  const routeConfigGuard = resolveCliCommandPathPolicy(params.commandPath).routeConfigGuard;
  return (
    routeConfigGuard === "always" ||
    (routeConfigGuard === "when-suppressed" && params.suppressDoctorStdout)
  );
}

export function shouldLoadPluginsForCommandPath(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode: boolean;
}): boolean {
  const loadPlugins = resolveCliCommandPathPolicy(params.commandPath).loadPlugins;
  if (typeof loadPlugins === "function") {
    return loadPlugins({
      argv: params.argv ?? [],
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    });
  }
  return loadPlugins === "always" || (loadPlugins === "text-only" && !params.jsonOutputMode);
}

export function shouldHideCliBannerForCommandPath(
  commandPath: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_HIDE_BANNER) ||
    resolveCliCommandPathPolicy(commandPath).hideBanner
  );
}

export function shouldEnsureCliPathForCommandPath(commandPath: string[]): boolean {
  return commandPath.length === 0 || resolveCliCommandPathPolicy(commandPath).ensureCliPath;
}

export function resolveCliStartupPolicy(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  const suppressDoctorStdout = params.jsonOutputMode;
  return {
    suppressDoctorStdout,
    hideBanner: shouldHideCliBannerForCommandPath(params.commandPath, params.env),
    skipConfigGuard: params.routeMode
      ? shouldSkipRouteConfigGuardForCommandPath({
          commandPath: params.commandPath,
          suppressDoctorStdout,
        })
      : false,
    loadPlugins: shouldLoadPluginsForCommandPath({
      argv: params.argv,
      commandPath: params.commandPath,
      jsonOutputMode: params.jsonOutputMode,
    }),
  };
}
