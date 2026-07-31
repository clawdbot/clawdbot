// Discord plugin module implements channel.loaders behavior.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { DiscordProbe } from "./probe.js";

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
export const loadDiscordTargetResolverModule = createLazyRuntimeModule(
  () => import("./target-resolver.js"),
);

export const loadDiscordProviderRuntime = createLazyRuntimeModule(
  () => import("./monitor/provider.runtime.js"),
);

export const loadDiscordProbeRuntime = createLazyRuntimeModule(() => import("./probe.runtime.js"));

export async function probeDiscordStatusAccount(params: {
  token: string;
  timeoutMs: number;
}): Promise<DiscordProbe> {
  const startedAtMs = Date.now();
  const runtime = await loadDiscordProbeRuntime();
  // The gateway starts its hook deadline before lazy plugin loading. Carry only the remaining
  // budget into the probe or a cold import can let optional metadata outrun the caller.
  const remainingMs = Math.max(1, params.timeoutMs - Math.max(0, Date.now() - startedAtMs));
  return await runtime.probeDiscord(params.token, remainingMs, { includeApplication: true });
}

export const loadDiscordAuditModule = createLazyRuntimeModule(() => import("./audit.js"));

export const loadDiscordSendModule = createLazyRuntimeModule(() => import("./send.js"));

export const loadDiscordDirectoryLiveModule = createLazyRuntimeModule(
  () => import("./directory-live.js"),
);
