import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

export const loadPluralKitRuntime = createLazyRuntimeModule(() => import("../pluralkit.js"));

export const loadPreflightAudioRuntime = createLazyRuntimeModule(
  () => import("./preflight-audio.js"),
);

export const loadSystemEventsRuntime = createLazyRuntimeModule(() => import("./system-events.js"));

export const loadDiscordThreadingRuntime = createLazyRuntimeModule(() => import("./threading.js"));

export function isPreflightAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}
