import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setTelegramUserRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getTelegramUserRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Telegram user runtime not initialized");
  }
  return runtime;
}
