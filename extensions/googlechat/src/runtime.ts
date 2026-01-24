import type { ClawdbotRuntime } from "clawdbot/plugin-sdk";

let runtime: ClawdbotRuntime;

export function setGoogleChatRuntime(r: ClawdbotRuntime): void {
  runtime = r;
}

export function getGoogleChatRuntime(): ClawdbotRuntime {
  if (!runtime) {
    throw new Error("Google Chat runtime not initialized");
  }
  return runtime;
}
