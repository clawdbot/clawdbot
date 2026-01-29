import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setLarkRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getLarkRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Lark runtime not initialized");
  }
  return runtime;
}
