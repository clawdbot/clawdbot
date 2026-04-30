let pluralkitRuntimePromise: Promise<typeof import("../pluralkit.js")> | undefined;
let preflightAudioRuntimePromise: Promise<typeof import("./preflight-audio.js")> | undefined;
let systemEventsRuntimePromise: Promise<typeof import("./system-events.js")> | undefined;
let discordThreadingRuntimePromise: Promise<typeof import("./threading.js")> | undefined;

export async function loadPluralKitRuntime() {
  pluralkitRuntimePromise ??= import("../pluralkit.js");
  return await pluralkitRuntimePromise;
}

export async function loadPreflightAudioRuntime() {
  preflightAudioRuntimePromise ??= import("./preflight-audio.js");
  return await preflightAudioRuntimePromise;
}

export async function loadSystemEventsRuntime() {
  systemEventsRuntimePromise ??= import("./system-events.js");
  return await systemEventsRuntimePromise;
}

export async function loadDiscordThreadingRuntime() {
  discordThreadingRuntimePromise ??= import("./threading.js");
  return await discordThreadingRuntimePromise;
}

export function isPreflightAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}
