import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

let discordProviderRuntimePromise:
  | Promise<typeof import("./monitor/provider.runtime.js")>
  | undefined;
let discordProbeRuntimePromise: Promise<typeof import("./probe.runtime.js")> | undefined;
let discordAuditModulePromise: Promise<typeof import("./audit.js")> | undefined;
let discordSendModulePromise: Promise<typeof import("./send.js")> | undefined;
let discordDirectoryLiveModulePromise: Promise<typeof import("./directory-live.js")> | undefined;

export const loadDiscordDirectoryConfigModule = createLazyRuntimeModule(
  () => import("./directory-config.js"),
);
export const loadDiscordResolveChannelsModule = createLazyRuntimeModule(
  () => import("./resolve-channels.js"),
);
export const loadDiscordResolveUsersModule = createLazyRuntimeModule(
  () => import("./resolve-users.js"),
);
export const loadDiscordThreadBindingsManagerModule = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.manager.js"),
);

export async function loadDiscordProviderRuntime() {
  discordProviderRuntimePromise ??= import("./monitor/provider.runtime.js");
  return await discordProviderRuntimePromise;
}

export async function loadDiscordProbeRuntime() {
  discordProbeRuntimePromise ??= import("./probe.runtime.js");
  return await discordProbeRuntimePromise;
}

export async function loadDiscordAuditModule() {
  discordAuditModulePromise ??= import("./audit.js");
  return await discordAuditModulePromise;
}

export async function loadDiscordSendModule() {
  discordSendModulePromise ??= import("./send.js");
  return await discordSendModulePromise;
}

export async function loadDiscordDirectoryLiveModule() {
  discordDirectoryLiveModulePromise ??= import("./directory-live.js");
  return await discordDirectoryLiveModulePromise;
}
