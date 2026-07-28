/**
 * Extension relay lifecycle: one relay server per extension-driver profile,
 * owned by the browser control runtime state.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedBrowserProfile } from "../config.js";
import type { BrowserServerState } from "../server-context.types.js";
import { type ExtensionRelayHandle, startExtensionRelayServer } from "./relay-server.js";

const log = createSubsystemLogger("browser").child("extension-relay");

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
  const map = relays(state);
  // The host-local relay secret can be rotated while Browser control stays up.
  // Treat the file as authoritative so a fresh pairing string works without a
  // service restart, and keep resolved config aligned for future profile reads.
  const { ensureExtensionRelayToken, readExtensionRelayToken } = await import("./relay-auth.js");
  const token = readExtensionRelayToken() ?? ensureExtensionRelayToken();
  if (state.resolved.extensionRelayToken !== token) {
    state.resolved = { ...state.resolved, extensionRelayToken: token };
  }
  const existing = map.get(profile.name);
  if (existing) {
    if (existing.port === profile.cdpPort && existing.token === token) {
      return existing;
    }
    // Port or token changed under this profile; rebind against the new config.
    await existing.close().catch((err: unknown) => {
      log.warn(
        `stale extension relay for profile "${profile.name}" failed to stop: ${String(err)}`,
      );
    });
    map.delete(profile.name);
  }
  const handle = await startExtensionRelayServer({
    port: profile.cdpPort,
    token,
  });
  map.set(profile.name, handle);
  log.info(`extension relay for profile "${profile.name}" listening on 127.0.0.1:${handle.port}`);
  return handle;
}

/**
 * Close relays whose profile was removed or is no longer an extension profile.
 * Prevents orphaned loopback listeners after a profile is deleted or renamed.
 */
export async function pruneRemovedExtensionRelays(
  state: BrowserServerState,
  isActiveExtensionProfile: (name: string) => boolean,
): Promise<void> {
  const map = state.extensionRelays;
  if (!map) {
    return;
  }
  for (const [name, handle] of map) {
    if (isActiveExtensionProfile(name)) {
      continue;
    }
    map.delete(name);
    await handle.close().catch((err: unknown) => {
      log.warn(`removed extension relay for profile "${name}" failed to stop: ${String(err)}`);
    });
  }
}

/** Start relays for every extension-driver profile (control service startup). */
export async function startConfiguredExtensionRelays(
  state: BrowserServerState,
  resolveProfile: (name: string) => ResolvedBrowserProfile | null,
  onWarn: (message: string) => void,
): Promise<void> {
  for (const [name, profile] of Object.entries(state.resolved.profiles)) {
    if (profile.driver !== "extension") {
      continue;
    }
    const resolved = resolveProfile(name);
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
  for (const [name, handle] of map) {
    try {
      await handle.close();
    } catch (err) {
      log.warn(`extension relay for profile "${name}" failed to stop: ${String(err)}`);
    }
  }
  map.clear();
}
