/**
 * Extension relay lifecycle: one relay server per extension-driver profile,
 * owned by the browser control runtime state.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProfile, type ResolvedBrowserProfile } from "../config.js";
import {
  getProfileLifecycle,
  getOrCreateProfileRuntime,
  isBrowserRuntimeRunning,
  withProfileOperationLease,
} from "../server-context.lifecycle.js";
import type { BrowserServerState, ProfileRuntimeState } from "../server-context.types.js";
import { type ExtensionRelayHandle, startExtensionRelayServer } from "./relay-server.js";

const log = createSubsystemLogger("browser").child("extension-relay");

type PendingRelayEnsure = {
  port: number;
  token: string;
  promise: Promise<ExtensionRelayHandle>;
};

const pendingRelayEnsures = new WeakMap<ProfileRuntimeState, PendingRelayEnsure>();

/** Human guidance for a relay without a paired/connected extension. */
export const EXTENSION_PAIRING_HINT =
  "Install the OpenClaw Chrome extension, then run `openclaw browser extension pair` and paste the pairing string into the extension popup.";

function relays(state: BrowserServerState): Map<string, ExtensionRelayHandle> {
  if (!state.extensionRelays) {
    state.extensionRelays = new Map();
  }
  return state.extensionRelays;
}

/**
 * Start the relay server for one extension-driver profile, reconciling any
 * existing one. Idempotency is keyed on profile name, but the desired (port,
 * token) can drift when the host-local relay secret is rotated or the profile's
 * cdpPort changes — a stale relay would then authenticate the extension against
 * the old token or listen on the wrong port. When the desired config differs,
 * the old relay is closed and a fresh one bound.
 */
export async function ensureExtensionRelayForProfile(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
): Promise<ExtensionRelayHandle> {
  for (;;) {
    if (!isBrowserRuntimeRunning(state)) {
      throw new Error("Browser runtime is stopping");
    }
    // The host-local relay secret can rotate while Browser control stays up.
    // Resolve one canonical desired profile after applying that token so the
    // intentional auth-derived cdpUrl change is not mistaken for config drift.
    const { ensureExtensionRelayToken, readExtensionRelayToken } = await import("./relay-auth.js");
    const token = readExtensionRelayToken() ?? ensureExtensionRelayToken();
    if (state.resolved.extensionRelayToken !== token) {
      state.resolved = { ...state.resolved, extensionRelayToken: token };
    }
    const desiredProfile = resolveProfile(state.resolved, profile.name);
    if (
      profile.driver !== "extension" ||
      desiredProfile?.driver !== "extension" ||
      desiredProfile.cdpPort !== profile.cdpPort
    ) {
      throw new Error(`Extension relay profile "${profile.name}" changed during startup.`);
    }
    // Token rotation changes only the auth-derived CDP URL. Keep the active
    // request's shared profile object aligned with the relay it will use.
    Object.assign(profile, desiredProfile);

    const runtime = getOrCreateProfileRuntime(state, desiredProfile);
    if (
      runtime.profile !== profile &&
      runtime.profile.driver === "extension" &&
      runtime.profile.cdpPort === desiredProfile.cdpPort
    ) {
      Object.assign(runtime.profile, desiredProfile);
    }
    const pending = pendingRelayEnsures.get(runtime);
    if (pending) {
      if (pending.port === desiredProfile.cdpPort && pending.token === token) {
        return await pending.promise;
      }
      try {
        await pending.promise;
      } catch (err) {
        if (getProfileLifecycle(runtime).blockedReason) {
          throw err;
        }
      }
      continue;
    }

    const promise = ensureDesiredRelay({ state, runtime, profile: desiredProfile, token });
    const owned = { port: desiredProfile.cdpPort, token, promise };
    pendingRelayEnsures.set(runtime, owned);
    try {
      return await promise;
    } finally {
      if (pendingRelayEnsures.get(runtime) === owned) {
        pendingRelayEnsures.delete(runtime);
      }
    }
  }
}

async function ensureDesiredRelay(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  profile: ResolvedBrowserProfile;
  token: string;
}): Promise<ExtensionRelayHandle> {
  const { state, runtime, profile, token } = params;
  return await withProfileOperationLease({
    state,
    runtime,
    configRevision: getProfileLifecycle(runtime).configRevision,
    run: async (signal) => {
      const map = relays(state);
      const actor = getProfileLifecycle(runtime);
      const existing = map.get(profile.name);
      if (existing) {
        if (existing.port === profile.cdpPort && existing.token === token) {
          return existing;
        }
        // Never drop the exact old handle until close succeeds; shutdown can retry it.
        actor.cleanupRelays.add(existing);
        await existing.close();
        actor.cleanupRelays.delete(existing);
        if (map.get(profile.name) === existing) {
          map.delete(profile.name);
        }
      }
      let handle: ExtensionRelayHandle | undefined;
      try {
        handle = await startExtensionRelayServer({
          port: profile.cdpPort,
          token,
        });
        actor.cleanupRelays.add(handle);
        signal.throwIfAborted();
        const currentProfile = resolveProfile(state.resolved, profile.name);
        if (
          state.profiles.get(profile.name) !== runtime ||
          currentProfile?.driver !== "extension" ||
          currentProfile.cdpUrl !== profile.cdpUrl ||
          state.resolved.extensionRelayToken !== token
        ) {
          throw new Error(`Extension relay profile "${profile.name}" changed during startup.`);
        }
        map.set(profile.name, handle);
        actor.cleanupRelays.delete(handle);
        log.info(
          `extension relay for profile "${profile.name}" listening on 127.0.0.1:${handle.port}`,
        );
        return handle;
      } catch (err) {
        if (handle) {
          try {
            await handle.close();
            actor.cleanupRelays.delete(handle);
          } catch (closeError) {
            actor.blockedReason = "extension relay cleanup failed";
            throw closeError;
          }
        }
        throw err;
      }
    },
  });
}

/** Start relays for every extension-driver profile (control service startup). */
export async function startConfiguredExtensionRelays(
  state: BrowserServerState,
  resolveProfileByName: (name: string) => ResolvedBrowserProfile | null,
  onWarn: (message: string) => void,
): Promise<void> {
  for (const [name, profile] of Object.entries(state.resolved.profiles)) {
    if (profile.driver !== "extension") {
      continue;
    }
    const resolved = resolveProfileByName(name);
    if (!resolved) {
      continue;
    }
    try {
      await ensureExtensionRelayForProfile(state, resolved);
    } catch (err) {
      onWarn(`extension relay for profile "${name}" failed to start: ${String(err)}`);
    }
  }
}

/** Stop every running relay (runtime shutdown). */
export async function stopExtensionRelays(state: BrowserServerState): Promise<void> {
  const map = state.extensionRelays;
  if (!map) {
    return;
  }
  let firstError: Error | undefined;
  for (const [name, handle] of map) {
    try {
      await handle.close();
      if (map.get(name) === handle) {
        map.delete(name);
      }
    } catch (err) {
      log.warn(`extension relay for profile "${name}" failed to stop: ${String(err)}`);
      firstError ??=
        err instanceof Error ? err : new Error("Extension relay cleanup failed.", { cause: err });
    }
  }
  if (firstError) {
    throw firstError;
  }
}
