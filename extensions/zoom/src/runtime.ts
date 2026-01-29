/**
 * Zoom plugin runtime singleton.
 * Provides access to the Moltbot plugin runtime for logging, state, and channel utilities.
 */
import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setZoomRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getZoomRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Zoom runtime not initialized");
  }
  return runtime;
}
