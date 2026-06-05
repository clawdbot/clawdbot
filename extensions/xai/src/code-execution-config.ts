// Xai helper module supports code execution config behavior.
import { isXaiToolEnabled, type XaiToolAuthContext } from "./tool-auth-shared.js";

export type CodeExecutionConfig = {
  enabled?: boolean;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
};

export function readCodeExecutionConfigRecord(
  config?: CodeExecutionConfig,
): Record<string, unknown> | undefined {
  return config && typeof config === "object" ? (config as Record<string, unknown>) : undefined;
}

export function readPluginCodeExecutionConfig(cfg?: unknown): CodeExecutionConfig | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const entries = (cfg as Record<string, unknown>).plugins;
  const pluginEntries =
    entries && typeof entries === "object"
      ? ((entries as Record<string, unknown>).entries as Record<string, unknown> | undefined)
      : undefined;
  if (!pluginEntries) {
    return undefined;
  }
  const xaiEntry = pluginEntries.xai;
  if (!xaiEntry || typeof xaiEntry !== "object") {
    return undefined;
  }
  const config = (xaiEntry as Record<string, unknown>).config;
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const codeExecution = (config as Record<string, unknown>).codeExecution;
  if (!codeExecution || typeof codeExecution !== "object") {
    return undefined;
  }
  return codeExecution as CodeExecutionConfig;
}

export function resolveCodeExecutionEnabled(params: {
  sourceConfig?: unknown;
  runtimeConfig?: unknown;
  config?: CodeExecutionConfig;
  auth?: XaiToolAuthContext;
}): boolean {
  return isXaiToolEnabled({
    enabled: readCodeExecutionConfigRecord(params.config)?.enabled as boolean | undefined,
    runtimeConfig: params.runtimeConfig as never,
    sourceConfig: params.sourceConfig as never,
    auth: params.auth,
  });
}
