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
  waitForProfileOperation,
  withProfileOperationLease,
} from "../server-context.lifecycle.js";
import type { BrowserServerState, ProfileRuntimeState } from "../server-context.types.js";
import { type ExtensionRelayHandle, startExtensionRelayServer } from "./relay-server.js";

const log = createSubsystemLogger("browser").child("extension-relay");

type PendingRelayEnsure = {
  port: number;
  token: string;
  allowLegacyAuth: boolean;
  promise: Promise<ExtensionRelayHandle>;
};

const pendingRelayEnsures = new WeakMap<ProfileRuntimeState, PendingRelayEnsure>();

/** Human guidance for a relay without a paired/connected extension. */
export const EXTENSION_PAIRING_HINT =
  "Run `openclaw browser extension install`, load the printed unpacked directory once, and wait for automatic setup.";

function relays(state: BrowserServerState): Map<string, ExtensionRelayHandle> {
  if (!state.extensionRelays) {
    state.extensionRelays = new Map();
  }
  return state.extensionRelays;
}

function applyInternalRelayToken(
  state: BrowserServerState,
  profileName: string,
  internalToken: string | null,
): ResolvedBrowserProfile | null {
  const tokens = { ...state.resolved.extensionRelayInternalTokens };
  if (internalToken) {
    tokens[profileName] = internalToken;
  } else {
    delete tokens[profileName];
  }
  state.resolved = { ...state.resolved, extensionRelayInternalTokens: tokens };
  const resolved = resolveProfile(state.resolved, profileName);
  const runtime = state.profiles.get(profileName);
  if (resolved?.driver === "extension" && runtime?.profile.driver === "extension") {
    Object.assign(runtime.profile, resolved);
  }
  return resolved;
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
  signal?: AbortSignal,
): Promise<ExtensionRelayHandle> {
  for (;;) {
    signal?.throwIfAborted();
    if (!isBrowserRuntimeRunning(state)) {
      throw new Error("Browser runtime is stopping");
    }
    // The host-local HMAC key can rotate while Browser control stays up.
    // Resolve one canonical desired profile after adopting the live key.
    const { ensureExtensionRelayToken } = await import("./relay-auth.js");
    const token = await ensureExtensionRelayToken();
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
    // Keep the active request's shared profile object aligned with the relay.
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
      if (
        pending.port === desiredProfile.cdpPort &&
        pending.token === token &&
        pending.allowLegacyAuth === state.resolved.extensionRelay.allowLegacyAuth
      ) {
        const handle = await waitForProfileOperation(pending.promise, signal);
        const current = resolveProfile(state.resolved, profile.name);
        if (current) {
          Object.assign(profile, current);
        }
        return handle;
      }
      try {
        await waitForProfileOperation(pending.promise, signal);
      } catch (err) {
        signal?.throwIfAborted();
        if (getProfileLifecycle(runtime).blockedReason) {
          throw err;
        }
      }
      continue;
    }

    const promise = ensureDesiredRelay({ state, runtime, profile: desiredProfile, token });
    const owned = {
      port: desiredProfile.cdpPort,
      token,
      allowLegacyAuth: state.resolved.extensionRelay.allowLegacyAuth,
      promise,
    };
    pendingRelayEnsures.set(runtime, owned);
    const settlePending = () => {
      if (pendingRelayEnsures.get(runtime) === owned) {
        pendingRelayEnsures.delete(runtime);
      }
    };
    void promise.then(settlePending, settlePending);
    const handle = await waitForProfileOperation(promise, signal);
    const current = resolveProfile(state.resolved, profile.name);
    if (current) {
      Object.assign(profile, current);
    }
    return handle;
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
    ownership: "lifecycle",
    run: async (signal) => {
      const map = relays(state);
      const actor = getProfileLifecycle(runtime);
      const existing = map.get(profile.name);
      if (existing) {
        if (
          existing.port === profile.cdpPort &&
          existing.token === token &&
          existing.allowLegacyAuth === state.resolved.extensionRelay.allowLegacyAuth
        ) {
          const current = applyInternalRelayToken(state, profile.name, existing.internalToken);
          if (current) {
            Object.assign(profile, current);
          }
          return existing;
        }
        // Never drop the exact old handle until close succeeds; shutdown can retry it.
        actor.cleanupRelays.add(existing);
        await existing.close();
        actor.cleanupRelays.delete(existing);
        if (map.get(profile.name) === existing) {
          map.delete(profile.name);
        }
        applyInternalRelayToken(state, profile.name, null);
      }
      let handle: ExtensionRelayHandle | undefined;
      try {
        handle = await startExtensionRelayServer({
          port: profile.cdpPort,
          token,
          allowLegacyAuth: state.resolved.extensionRelay.allowLegacyAuth,
        });
        actor.cleanupRelays.add(handle);
        signal.throwIfAborted();
        const currentProfile = resolveProfile(state.resolved, profile.name);
        if (
          state.profiles.get(profile.name) !== runtime ||
          currentProfile?.driver !== "extension" ||
          currentProfile.cdpPort !== profile.cdpPort ||
          state.resolved.extensionRelayToken !== token
        ) {
          throw new Error(`Extension relay profile "${profile.name}" changed during startup.`);
        }
        map.set(profile.name, handle);
        const currentWithInternalAuth = applyInternalRelayToken(
          state,
          profile.name,
          handle.internalToken,
        );
        if (!currentWithInternalAuth) {
          throw new Error(`Extension relay profile "${profile.name}" disappeared during startup.`);
        }
        Object.assign(profile, currentWithInternalAuth);
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
      applyInternalRelayToken(state, name, null);
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
