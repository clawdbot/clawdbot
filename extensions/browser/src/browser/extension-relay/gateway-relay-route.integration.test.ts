import { once } from "node:events";
import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { parsePairingString } from "../../../chrome-extension/modules/relay-core.js";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import { getBrowserControlState, stopBrowserControlService } from "../../control-service.js";
import { buildBrowserExtensionPairing } from "../extension-pairing.js";
import { getFreePort } from "../test-port.js";
import { createRelayProof, randomRelayNonce, relayKeyIdFromHex } from "./auth-v2-crypto.js";
import { BROWSER_RELAY_EXTENSION_SUBPROTOCOL } from "./auth-v2.js";
import { handleGatewayExtensionUpgrade } from "./gateway-relay-route.js";

const RELAY_KEY = relayTestKey(8);

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
});

describe.sequential("local Gateway extension relay wakeup", () => {
  it("starts Browser control and the CDP relay from the first authenticated extension request", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-relay-wakeup-"));
    try {
      const gatewayPort = await getFreePort();
      let relayPort = await getFreePort();
      while (relayPort === gatewayPort) {
        relayPort = await getFreePort();
      }
      await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "credentials", "browser-extension-relay.secret"),
        `${RELAY_KEY}\n`,
        { mode: 0o600 },
      );

      const config = {
        gateway: {
          port: gatewayPort,
          auth: { mode: "token" as const, token: "gateway-integration-test" },
        },
        browser: {
          enabled: true,
          extensionRelay: { allowLegacyAuth: false },
          profiles: { chrome: { driver: "extension" as const, cdpPort: relayPort } },
        },
      };
      setRuntimeConfigSnapshot(config, config);

      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_GATEWAY_PORT: String(gatewayPort),
        },
        async () => {
          const gatewayServer = http.createServer((_req, res) => {
            res.writeHead(426);
            res.end();
          });
          gatewayServer.on("upgrade", (req, socket, head) => {
            void handleGatewayExtensionUpgrade(req, socket, head);
          });
          let extension: WebSocket | undefined;
          try {
            await new Promise<void>((resolve) => {
              gatewayServer.listen(gatewayPort, "127.0.0.1", resolve);
            });
            expect(getBrowserControlState()).toBeNull();

            const pairing = await buildBrowserExtensionPairing({
              cfg: config,
              localTransport: "gateway",
              ensureToken: async () => RELAY_KEY,
            });
            expect(pairing).toMatchObject({ relayPort, topology: "local" });
            const parsed = parsePairingString(pairing.pairingString);
            if (!parsed) {
              throw new Error("local pairing did not parse");
            }

            extension = new WebSocket(parsed.relayUrl, BROWSER_RELAY_EXTENSION_SUBPROTOCOL, {
              origin: "chrome-extension://gateway-wakeup-integration",
            });
            await once(extension, "open");
            const clientNonce = randomRelayNonce();
            const challengeMessage = once(extension, "message");
            extension.send(
              JSON.stringify({
                type: "auth.hello",
                v: 2,
                keyId: relayKeyIdFromHex(RELAY_KEY),
                clientNonce,
              }),
            );
            const [challengeData] = (await challengeMessage) as [RawData];
            const challenge = JSON.parse(rawDataText(challengeData));
            const okMessage = once(extension, "message");
            extension.send(
              JSON.stringify({
                type: "auth.response",
                v: 2,
                sessionId: challenge.sessionId,
                clientProof: createRelayProof(RELAY_KEY, "client", challenge),
              }),
            );
            const [okData] = (await okMessage) as [RawData];
            expect(JSON.parse(rawDataText(okData))).toMatchObject({ type: "auth.ok", v: 2 });
            extension.send(
              JSON.stringify({
                type: "hello",
                userAgent: "gateway-wakeup-test",
                browserVersion: "Chrome/test",
                extensionVersion: "2",
                tabs: [],
              }),
            );

            await expect
              .poll(
                () =>
                  getBrowserControlState()?.extensionRelays?.get("chrome")?.bridge
                    .extensionConnected,
              )
              .toBe(true);
            const relay = getBrowserControlState()?.extensionRelays?.get("chrome");
            expect(relay?.port).toBe(pairing.relayPort);
            if (!relay) {
              throw new Error("extension relay did not start");
            }

            const authorization = Buffer.from(`openclaw-internal:${relay.internalToken}`).toString(
              "base64",
            );
            const response = await fetch(`http://127.0.0.1:${pairing.relayPort}/json/version`, {
              headers: { Authorization: `Basic ${authorization}` },
            });
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
              Browser: "Chrome/test",
              webSocketDebuggerUrl: `ws://127.0.0.1:${pairing.relayPort}/cdp`,
            });
          } finally {
            extension?.terminate();
            await stopBrowserControlService();
            await closeServer(gatewayServer);
          }
        },
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
