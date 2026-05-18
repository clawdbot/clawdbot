import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  type CommandSecretResolutionMode,
  resolveCommandSecretRefsViaGateway,
} from "./command-secret-gateway.js";

export async function resolveCommandConfigWithSecrets<TConfig extends OpenClawConfig>(params: {
  config: TConfig;
  commandName: string;
  targetIds: Set<string>;
  mode?: CommandSecretResolutionMode;
  allowedPaths?: Set<string>;
  forcedActivePaths?: Set<string>;
  optionalActivePaths?: Set<string>;
  runtime?: RuntimeEnv;
  autoEnable?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  resolvedConfig: TConfig;
  effectiveConfig: TConfig;
  diagnostics: string[];
}> {
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config: params.config,
    commandName: params.commandName,
    targetIds: params.targetIds,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
    ...(params.forcedActivePaths ? { forcedActivePaths: params.forcedActivePaths } : {}),
    ...(params.optionalActivePaths ? { optionalActivePaths: params.optionalActivePaths } : {}),
  });
  if (params.runtime) {
    for (const entry of diagnostics) {
      params.runtime.error(`[secrets] ${entry}`);
    }
  }
  const effectiveConfig = params.autoEnable
    ? applyPluginAutoEnable({
        config: resolvedConfig,
        env: params.env ?? process.env,
      }).config
    : resolvedConfig;
  return {
    resolvedConfig: resolvedConfig as TConfig,
    effectiveConfig: effectiveConfig as TConfig,
    diagnostics,
  };
}
