import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
  getModelsCommandSecretTargetIds,
} from "./load-config.runtime.js";

export type LoadedModelsConfig = {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  diagnostics: string[];
};

export async function loadModelsConfigWithSource(params: {
  commandName: string;
  runtime?: RuntimeEnv;
}): Promise<LoadedModelsConfig> {
  const runtimeConfig = getRuntimeConfig();
  const pinnedSourceConfig = getRuntimeConfigSourceSnapshot();
  const sourceConfig = pinnedSourceConfig ?? runtimeConfig;
  const { resolvedConfig, diagnostics } = await resolveCommandConfigWithSecrets({
    config: runtimeConfig,
    commandName: params.commandName,
    targetIds: getModelsCommandSecretTargetIds(),
    runtime: params.runtime,
  });
  if (pinnedSourceConfig) {
    setRuntimeConfigSnapshot(resolvedConfig, sourceConfig);
  } else {
    setRuntimeConfigSnapshot(resolvedConfig);
  }
  return {
    sourceConfig,
    resolvedConfig,
    diagnostics,
  };
}

export async function loadModelsConfig(params: {
  commandName: string;
  runtime?: RuntimeEnv;
}): Promise<OpenClawConfig> {
  return (await loadModelsConfigWithSource(params)).resolvedConfig;
}
