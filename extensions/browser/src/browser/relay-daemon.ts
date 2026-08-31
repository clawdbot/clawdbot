import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getRuntimeConfig } from "../config/config.js";
import { extractErrorCode } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { readExtensionRelayToken } from "./extension-relay/relay-auth.js";
import {
  type ExtensionRelayHandle,
  startExtensionRelayServer,
} from "./extension-relay/relay-server.js";

const log = createSubsystemLogger("browser").child("relay-daemon");

/** Default grace before a daemon with no extension and no CDP clients exits. */
const RELAY_DAEMON_IDLE_EXIT_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 30 * 1000;

type RelayDaemonExitReason = "port-in-use" | "no-credential" | "idle" | "stopped";

type RelayDaemonRun = {
  /** Resolves when the daemon decides to exit; the caller owns process.exit. */
  done: Promise<RelayDaemonExitReason>;
  /** Bound relay port when the server started; null when startup was refused. */
  port: number | null;
  stop: () => void;
};

/**
 * Run the standalone extension relay daemon: one loopback relay server with no
 * Gateway. The daemon stays alive while the paired extension holds its relay
 * connection or a CDP client is attached, and exits once both sides have been
 * gone for the idle grace so an idle daemon never outlives Chrome.
 */
export async function runExtensionRelayDaemon(params: {
  port: number;
  readToken?: () => string | null;
  /**
   * Accept the legacy one-directional relay auth (Bearer/Basic/token
   * subprotocol). Defaults to false: the standalone daemon is v2-only, so a
   * process that squats the relay port cannot harvest the secret from a legacy
   * client, and an operator's `extensionRelay.allowLegacyAuth=false` is never
   * silently reverted. The extension and mcporter both speak v2.
   */
  allowLegacyAuth?: boolean;
  idleExitMs?: number;
  pollMs?: number;
  now?: () => number;
}): Promise<RelayDaemonRun> {
  const readToken = params.readToken ?? readExtensionRelayToken;
  const allowLegacyAuth = params.allowLegacyAuth ?? false;
  const now = params.now ?? Date.now;
  const idleExitMs = params.idleExitMs ?? RELAY_DAEMON_IDLE_EXIT_MS;
  const pollMs = params.pollMs ?? IDLE_POLL_MS;
  const completion = createDeferred<RelayDaemonExitReason>();

  const token = readToken();
  if (!token) {
    log.warn("relay daemon refused to start: no extension relay credential");
    completion.resolve("no-credential");
    return { done: completion.promise, port: null, stop: () => {} };
  }

  let handle: ExtensionRelayHandle;
  try {
    const config = getRuntimeConfig();
    const resolved = resolveBrowserConfig(config.browser, config);
    const profiles = Object.keys(resolved.profiles).filter((name) => {
      const profile = resolveProfile(resolved, name);
      return profile?.driver === "extension" && profile.cdpPort === params.port;
    });
    // The listener owns this fact. Ambiguous/unconfigured ports never advertise owner access.
    const profileName = profiles.length === 1 ? profiles[0] : undefined;
    handle = await startExtensionRelayServer({
      port: params.port,
      token,
      allowLegacyAuth,
      profileName,
    });
  } catch (error) {
    if (extractErrorCode(error) === "EADDRINUSE") {
      log.info(`relay port ${params.port} is already served; standalone daemon not needed`);
      completion.resolve("port-in-use");
      return { done: completion.promise, port: null, stop: () => {} };
    }
    throw error;
  }
  log.info(`standalone extension relay listening on 127.0.0.1:${handle.port}`);

  let lastActiveAtMs = now();
  let stopped = false;
  const finish = (reason: RelayDaemonExitReason): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(idleTimer);
    void handle.close().then(() => completion.resolve(reason), completion.reject);
  };
  const idleTimer = setInterval(() => {
    if (handle.bridge.extensionConnected || handle.bridge.cdpClientCount > 0) {
      lastActiveAtMs = now();
      return;
    }
    if (now() - lastActiveAtMs >= idleExitMs) {
      log.info("relay daemon idle (no extension, no CDP clients); exiting");
      finish("idle");
    }
  }, pollMs);
  idleTimer.unref?.();

  return {
    done: completion.promise,
    port: handle.port,
    stop: () => finish("stopped"),
  };
}
