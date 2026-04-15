import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "./runtime-api.js";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>("BlueBubbles runtime not initialized");
type LegacyRuntimeLogShape = { log?: (message: string) => void };
export const setBlueBubblesRuntime = runtimeStore.setRuntime;

export function clearBlueBubblesRuntime(): void {
  runtimeStore.clearRuntime();
}

export function tryGetBlueBubblesRuntime(): PluginRuntime | null {
  return runtimeStore.tryGetRuntime();
}

export function getBlueBubblesRuntime(): PluginRuntime {
  return runtimeStore.getRuntime();
}

export function warnBlueBubbles(message: string): void {
  const formatted = `[bluebubbles] ${message}`;
  // Backward-compatible with tests/legacy injections that pass { log }.
  const log = (runtimeStore.tryGetRuntime() as unknown as LegacyRuntimeLogShape | null)?.log;
  if (typeof log === "function") {
    log(formatted);
    return;
  }
  console.warn(formatted);
}
