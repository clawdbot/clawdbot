/**
 * Gateway-hosted extension relay upgrade handler.
 *
 * Lets the OpenClaw Chrome extension connect DIRECTLY to a remote gateway over
 * `wss://` — no OpenClaw node host on the browser machine. This is the
 * cross-machine path for #53599: a user installs only the extension and pastes
 * a `wss://gateway/browser/extension#<secret>` pairing string.
 *
 * The gateway route is registered with `auth: "plugin"` and no nodeCapability,
 * so the gateway does NOT pre-enforce gateway-token auth (browser WebSockets
 * cannot send an Authorization header anyway). This handler self-validates the
 * host-local relay secret from the WebSocket subprotocol list, then attaches
 * the socket to the same ExtensionRelayBridge the loopback relay uses — so all
 * CDP synthesis, tab-group scoping, and the in-process Playwright /cdp client
 * are unchanged.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { WebSocketServer } from "ws";
import {
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
} from "../../control-service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProfile } from "../config.js";
import { readExtensionRelayToken } from "./relay-auth.js";
import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";
import {
  attachExtensionWebSocket,
  EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
  isAllowedExtensionOrigin,
  requestExtensionProtocolToken,
} from "./relay-server.js";

const log = createSubsystemLogger("browser").child("extension-relay-gateway");

/** Path the browser plugin registers on the gateway (ends in /extension so the pairing parser accepts it). */
const GATEWAY_EXTENSION_RELAY_PATH = "/browser/extension";

// Single noServer WebSocketServer for all gateway-hosted extension upgrades.
let wss: WebSocketServer | null = null;
function getWss(): WebSocketServer {
  wss ??= new WebSocketServer({ noServer: true, maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES });
  return wss;
}

function destroy(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  } catch {
    // socket already gone
  }
}

function requestedProfileName(req: IncomingMessage, fallback: string): string {
  try {
    const value = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("profile");
    return value?.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** First extension-driver profile name, defaulting to the built-in `chrome`. */
function defaultExtensionProfileName(profiles: Record<string, { driver?: string }>): string {
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.driver === "extension") {
      return name;
    }
  }
  return "chrome";
}

/**
 * Handle a gateway upgrade for the extension relay path. Returns true when the
 * request was claimed (handled or rejected), false to let the gateway continue.
 */
export async function handleGatewayExtensionUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const path = (req.url ?? "/").split("?")[0];
  if (path !== GATEWAY_EXTENSION_RELAY_PATH) {
    return false;
  }

  // chrome-extension:// origin hygiene (not a security boundary on its own —
  // the relay secret is the gate — but rejects obvious cross-site sockets).
  if (!isAllowedExtensionOrigin(req)) {
    destroy(socket, "403 Forbidden");
    return true;
  }

  // Authenticate before lazy-starting Browser control. A valid pairing secret
  // may start the service; an arbitrary public WebSocket request may not.
  let state = getBrowserControlState();
  const expectedToken = readExtensionRelayToken();
  const candidate = requestExtensionProtocolToken(req);
  if (!expectedToken || candidate.length === 0 || !safeEqualSecret(expectedToken, candidate)) {
    destroy(socket, "401 Unauthorized");
    return true;
  }

  if (!state) {
    try {
      state = await startBrowserControlServiceFromConfig();
    } catch (err) {
      log.warn(`failed to start Browser control for extension relay: ${String(err)}`);
    }
    if (!state) {
      destroy(socket, "503 Service Unavailable");
      return true;
    }
  }

  const profileName = requestedProfileName(
    req,
    defaultExtensionProfileName(state.resolved.profiles),
  );
  const resolved = resolveProfile(state.resolved, profileName);
  if (!resolved || resolved.driver !== "extension") {
    destroy(socket, "404 Not Found");
    return true;
  }

  let bridge;
  try {
    bridge = (await ensureExtensionRelayForProfile(state, resolved)).bridge;
  } catch (err) {
    log.warn(`failed to start relay for profile "${profileName}": ${String(err)}`);
    destroy(socket, "503 Service Unavailable");
    return true;
  }

  getWss().handleUpgrade(req, socket, head, (ws) => {
    attachExtensionWebSocket(bridge, ws);
    log.info(`extension connected over gateway for profile "${profileName}"`);
  });
  return true;
}

/** Release the shared WebSocketServer (runtime shutdown / tests). */
export function disposeGatewayExtensionRelay(): void {
  wss?.close();
  wss = null;
}
