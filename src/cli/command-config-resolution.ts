import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  type CommandSecretResolutionMode,
  type CommandSecretsProviderOverrides,
  resolveCommandSecretRefsViaGateway,
} from "./command-secret-gateway.js";

export async function resolveCommandConfigWithSecrets<TConfig extends OpenClawConfig>(params: {
  config: TConfig;
  commandName: string;
  targetIds: Set<string>;
  mode?: CommandSecretResolutionMode;
  allowedPaths?: Set<string>;
  providerOverrides?: CommandSecretsProviderOverrides;
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
    ...(params.providerOverrides ? { providerOverrides: params.providerOverrides } : {}),
  });
  if (params.runtime) {
    for (const entry of diagnostics) {
      params.runtime.log(`[secrets] ${entry}`);
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
