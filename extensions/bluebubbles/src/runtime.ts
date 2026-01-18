import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setBlueBubblesRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getBlueBubblesRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("BlueBubbles runtime not initialized");
  }
  return runtime;
}
