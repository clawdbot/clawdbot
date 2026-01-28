/**
 * Webex plugin runtime singleton
 */

import type { PluginRuntime } from "clawdbot/plugin-sdk";

export type WebexRuntimeEnv = PluginRuntime;

let runtime: WebexRuntimeEnv | undefined;

export function setWebexRuntime(r: WebexRuntimeEnv): void {
  runtime = r;
}

export function getWebexRuntime(): WebexRuntimeEnv {
  if (!runtime) {
    throw new Error("Webex runtime not initialized");
  }
  return runtime;
}

export function getWebexRuntimeOrUndefined(): WebexRuntimeEnv | undefined {
  return runtime;
}
