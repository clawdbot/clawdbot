/** Direct Gateway extension relay with in-band Browser Relay Authentication v2. */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { WebSocketServer, type WebSocket } from "ws";
import { getRuntimeConfig } from "../../config/config.js";
import {
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
} from "../../control-service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProfile } from "../config.js";
import { getProfileLifecycle } from "../server-context.lifecycle.js";
import {
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  getBrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
  parseExtensionRelayResource,
} from "./auth-v2.js";
import { handlePreAuthWebSocketUpgrade } from "./preauth-websocket-guard.js";
import { readExtensionRelayToken } from "./relay-auth.js";
import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";
import {
  isAllowedExtensionOrigin,
  LEGACY_EXTENSION_RELAY_PROTOCOL,
  requestExtensionProtocolToken,
  requestProtocols,
} from "./relay-request.js";
import {
  attachExtensionWebSocket,
  authenticateExtensionWebSocket,
  EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
} from "./relay-server.js";

const log = createSubsystemLogger("browser").child("extension-relay-gateway");
const GATEWAY_EXTENSION_RELAY_PATH = "/browser/extension";

let wss: WebSocketServer | null = null;
function getWss(): WebSocketServer {
  wss ??= new WebSocketServer({ noServer: true, maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES });
  return wss;
}

function destroy(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function requestedProfileName(resource: string, fallback: string): string {
  return new URL(resource, "http://127.0.0.1").searchParams.get("profile") ?? fallback;
}

function defaultExtensionProfileName(profiles: Record<string, { driver?: string }>): string {
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.driver === "extension") {
      return name;
    }
  }
  return "chrome";
}

async function resolveGatewayRelay(resource: string) {
  let state = getBrowserControlState();
  if (!state) {
    state = await startBrowserControlServiceFromConfig();
    if (!state) {
      throw new Error("Browser control is disabled");
    }
  }
  const profileName = requestedProfileName(
    resource,
    defaultExtensionProfileName(state.resolved.profiles),
  );
  const resolved = resolveProfile(state.resolved, profileName);
  if (!resolved || resolved.driver !== "extension") {
    throw new Error(`Extension browser profile "${profileName}" was not found`);
  }
  const relay = await ensureExtensionRelayForProfile(state, resolved);
  const runtime = state.profiles.get(profileName);
  if (!runtime) {
    throw new Error("Gateway relay profile is unavailable");
  }
  const lifecycle = getProfileLifecycle(runtime);
  const generation = lifecycle.generation;
  return {
    relay,
    profileName,
    assertCurrent: () => {
      if (
        lifecycle.generation !== generation ||
        lifecycle.transitionReason ||
        lifecycle.terminal ||
        getBrowserControlState() !== state ||
        state.extensionRelays?.get(profileName) !== relay ||
        state.profiles.get(profileName) !== runtime ||
        readExtensionRelayToken() !== relay.token ||
        resolveProfile(state.resolved, profileName)?.cdpPort !== relay.port
      ) {
        throw new Error("Gateway relay ingress was superseded");
      }
    },
  };
}

async function prepareGatewayIngress(
  access: Awaited<ReturnType<typeof resolveGatewayRelay>>,
  ws: WebSocket,
): Promise<() => void> {
  access.assertCurrent();
  const relay = access.relay;
  const attach =
    relay.ownership === "borrowed"
      ? await relay.client.prepareIngress(ws)
      : () => attachExtensionWebSocket(relay.bridge, ws);
  return () => {
    access.assertCurrent();
    attach();
    log.info(`extension connected over gateway for profile "${access.profileName}"`);
  };
}

/** Handle the plugin-owned Gateway upgrade path. */
export async function handleGatewayExtensionUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<boolean> {
  const resource = parseExtensionRelayResource(req.url ?? "/", GATEWAY_EXTENSION_RELAY_PATH);
  if (!resource) {
    return (req.url ?? "/").split("?")[0] === GATEWAY_EXTENSION_RELAY_PATH
      ? (destroy(socket, "400 Bad Request"), true)
      : false;
  }
  if (!isAllowedExtensionOrigin(req)) {
    destroy(socket, "403 Forbidden");
    return true;
  }

  const protocols = requestProtocols(req);
  // Gateway resolves trusted-proxy attribution before plugin dispatch. The raw
  // peer is only a fallback for direct harnesses outside that request scope.
  const source =
    getPluginRuntimeGatewayRequestScope()?.client?.clientIp ??
    req.socket?.remoteAddress ??
    "unknown";
  const token = readExtensionRelayToken();
  if (!token) {
    invalidateBrowserRelayAuthV2Authority();
    destroy(socket, "401 Unauthorized");
    return true;
  }

  if (protocols.length === 1 && protocols[0] === BROWSER_RELAY_EXTENSION_SUBPROTOCOL) {
    const authority = getBrowserRelayAuthV2Authority(token);
    if (
      !handlePreAuthWebSocketUpgrade({
        wss: getWss(),
        req,
        socket,
        head,
        onUpgrade: (ws, removePreAuthGuard) => {
          authenticateExtensionWebSocket({
            ws,
            authority,
            source,
            resource,
            removePreAuthGuard,
            prepareAuthenticated: async () => {
              // The proof may finish while an operator rotates the host key. Never
              // let an old authenticated socket lazy-start or claim a new bridge.
              if (readExtensionRelayToken() !== token) {
                throw new Error("browser relay key rotated during authentication");
              }
              const attach = await prepareGatewayIngress(await resolveGatewayRelay(resource), ws);
              return () => {
                if (readExtensionRelayToken() !== token) {
                  throw new Error("Relay key rotated");
                }
                attach();
              };
            },
          });
        },
      })
    ) {
      destroy(socket, "400 Bad Request");
    }
    return true;
  }

  if (protocols.includes(BROWSER_RELAY_EXTENSION_SUBPROTOCOL)) {
    destroy(socket, "400 Bad Request");
    return true;
  }

  const config = getRuntimeConfig();
  const allowLegacyAuth = config.browser?.extensionRelay?.allowLegacyAuth !== false;
  const legacyToken = requestExtensionProtocolToken(req);
  if (
    !allowLegacyAuth ||
    !protocols.includes(LEGACY_EXTENSION_RELAY_PROTOCOL) ||
    legacyToken.length === 0 ||
    !safeEqualSecret(token, legacyToken)
  ) {
    destroy(socket, "401 Unauthorized");
    return true;
  }

  let resolved;
  try {
    resolved = await resolveGatewayRelay(resource);
  } catch (err) {
    log.warn(`failed to start Browser control for legacy extension relay: ${String(err)}`);
    destroy(socket, "503 Service Unavailable");
    return true;
  }
  const authority = getBrowserRelayAuthV2Authority(token);
  getWss().handleUpgrade(req, socket, head, (ws) => {
    // Pause before the first read tick, including upgrade-head bytes. Pausing
    // after receiver events begin cannot hold already-buffered application frames.
    ws.pause();
    // Borrowed ingress never passes through the local bridge's socket binding.
    ws.on("error", (err) => log.warn(`relay socket error: ${String(err)}`));
    if (
      !authority.registerAuthenticatedConnection(ws, () =>
        ws.close(4003, "browser relay key rotated"),
      )
    ) {
      ws.terminate();
      return;
    }
    ws.once("close", () => authority.releaseConnection(ws));
    void prepareGatewayIngress(resolved, ws)
      .then((attach) => {
        if (ws.readyState === 1) {
          attach();
        }
      })
      .catch(() => ws.close(1011, "Relay ingress unavailable"))
      // Failure must also drain the closing handshake instead of stranding a paused peer.
      .finally(() => ws.resume());
    log.warn(`legacy extension authentication accepted for profile "${resolved.profileName}"`);
  });
  return true;
}

export function disposeGatewayExtensionRelay(): void {
  if (!wss) {
    return;
  }
  for (const client of wss.clients) {
    client.terminate();
  }
  wss.close();
  wss = null;
}
