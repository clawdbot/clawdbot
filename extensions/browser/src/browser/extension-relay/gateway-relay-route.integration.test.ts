import { once } from "node:events";
import fs from "node:fs/promises";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { parsePairingString } from "../../../chrome-extension/modules/relay-core.js";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { buildBrowserExtensionPairing } from "../extension-pairing.js";
import { runExtensionRelayDaemon } from "../relay-daemon.js";
import { getFreePort } from "../test-port.js";
import {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayAuthChallenge,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
} from "./auth-v2.js";
import { handleGatewayExtensionUpgrade } from "./gateway-relay-route.js";
import { RawHttpConnection } from "./relay-http.test-support.js";

const getPluginRuntimeGatewayRequestScopeMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: () => getPluginRuntimeGatewayRequestScopeMock(),
}));

const RELAY_KEY = relayTestKey(8);
const EXTENSION_HELLO = {
  type: "hello",
  userAgent: "gateway-wakeup-test",
  browserVersion: "Chrome/test",
  extensionVersion: "2",
  tabs: [],
};

async function relayInventory(port: number): Promise<unknown> {
  const connection = await RawHttpConnection.connect(port);
  try {
    const request = async (pathname: string, body?: object) => {
      const response = await connection.request(
        body ? "POST" : "GET",
        pathname,
        body ? JSON.stringify(body) : "",
      );
      expect(response.status).toBe(200);
      return JSON.parse(response.body);
    };
    const challenge = (await request(BROWSER_RELAY_AUTH_CHALLENGE_PATH, {
      v: 2,
      keyId: relayKeyIdFromHex(RELAY_KEY),
      clientNonce: randomRelayNonce(),
      role: "cdp",
      transport: "connection",
      method: "GET",
      resource: "/json/list",
      flow: "json-list",
    })) as BrowserRelayAuthChallenge;
    expect(verifyRelayProof(RELAY_KEY, "server", challenge, challenge.serverProof)).toBe(true);
    const clientProof = createRelayProof(RELAY_KEY, "client", challenge);
    const accepted = await request(BROWSER_RELAY_AUTH_COMPLETE_PATH, {
      v: 2,
      sessionId: challenge.sessionId,
      clientProof,
    });
    expect(
      verifyRelayProof(RELAY_KEY, "accept", challenge, accepted.acceptProof, clientProof),
    ).toBe(true);
    return await request("/json/list");
  } finally {
    connection.close();
  }
}

function encodeUpgradeHead(messages: object[]): Buffer {
  return Buffer.concat(
    messages.map((message) => {
      const payload = Buffer.from(JSON.stringify(message));
      const extended = payload.length >= 126;
      const header = Buffer.alloc(extended ? 8 : 6);
      header[0] = 0x81;
      header[1] = 0x80 | (extended ? 126 : payload.length);
      if (extended) {
        header.writeUInt16BE(payload.length, 2);
      }
      // The fixed zero mask leaves these synthetic payload bytes unchanged.
      return Buffer.concat([header, payload]);
    }),
  );
}

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
  getPluginRuntimeGatewayRequestScopeMock.mockReset();
});

describe.sequential("local Gateway extension relay wakeup", () => {
  it.each([
    { name: "disabled Browser", enabled: false, driver: "extension" as const },
    { name: "no extension profiles", enabled: true, driver: "openclaw" as const },
  ])("leaves the relay key absent with $name", async ({ enabled, driver }) => {
    await withTempDir("openclaw-relay-service-", async (dir) => {
      const stateDir = await fs.realpath(dir);
      const credentials = path.join(stateDir, "credentials");
      const config = {
        gateway: { auth: { mode: "token" as const, token: "gateway-integration-test" } },
        browser: { enabled, profiles: { chrome: { driver, cdpPort: 18799 } } },
      };
      setRuntimeConfigSnapshot(config, config);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: credentials },
        async () => {
          try {
            const state = await startBrowserControlServiceFromConfig();
            expect(state !== null).toBe(enabled);
            await expect(
              fs.stat(path.join(credentials, "browser-extension-relay.secret")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          } finally {
            await stopBrowserControlService();
          }
        },
      );
    });
  });

  it.each([
    { browserRequestAlreadyWaiting: false, standaloneFirst: false, malformedFrame: false },
    { browserRequestAlreadyWaiting: true, standaloneFirst: false, malformedFrame: false },
    { browserRequestAlreadyWaiting: true, standaloneFirst: true, malformedFrame: false },
    { browserRequestAlreadyWaiting: true, standaloneFirst: true, malformedFrame: true },
    {
      browserRequestAlreadyWaiting: false,
      standaloneFirst: false,
      malformedFrame: false,
      saturatedSource: true,
    },
    { browserRequestAlreadyWaiting: false, standaloneFirst: false, legacy: "open" },
    {
      browserRequestAlreadyWaiting: true,
      standaloneFirst: true,
      legacy: "open",
      malformedFrame: true,
    },
    { browserRequestAlreadyWaiting: false, standaloneFirst: false, legacy: "head" },
    { browserRequestAlreadyWaiting: true, standaloneFirst: true, legacy: "head" },
  ])(
    "authenticates Gateway ingress: waiting=$browserRequestAlreadyWaiting standalone=$standaloneFirst malformed=$malformedFrame legacy=$legacy saturated=$saturatedSource",
    async ({
      browserRequestAlreadyWaiting,
      standaloneFirst,
      malformedFrame,
      legacy,
      saturatedSource,
    }) => {
      const stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-relay-wakeup-")),
      );
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
            extensionRelay: { allowLegacyAuth: Boolean(legacy) },
            profiles: { chrome: { driver: "extension" as const, cdpPort: relayPort } },
          },
        };
        setRuntimeConfigSnapshot(config, config);

        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
            OPENCLAW_GATEWAY_PORT: String(gatewayPort),
          },
          async () => {
            const inventory = {
              type: "tabs",
              tabs: [
                {
                  tabId: 7,
                  url: "https://example.test/initial",
                  title: "Coalesced inventory",
                  active: true,
                },
              ],
            };
            const coalesced =
              legacy === "head" ? encodeUpgradeHead([EXTENSION_HELLO, inventory]) : undefined;
            const gatewayServer = http.createServer((_req, res) => {
              res.writeHead(426);
              res.end();
            });
            let upgradeHeadBytes = 0;
            gatewayServer.on("upgrade", (req, socket, head) => {
              // TCP writes cannot guarantee Node's upgrade-head size; supply that exact boundary.
              const initialHead = coalesced ?? head;
              upgradeHeadBytes = initialHead.byteLength;
              const preparedClientIp = req.headers["x-test-client-ip"];
              getPluginRuntimeGatewayRequestScopeMock.mockReturnValue(
                typeof preparedClientIp === "string"
                  ? { client: { clientIp: preparedClientIp } }
                  : undefined,
              );
              void handleGatewayExtensionUpgrade(req, socket, initialHead);
            });
            let extension: WebSocket | undefined;
            let saturationSockets: WebSocket[] = [];
            let daemon: Awaited<ReturnType<typeof runExtensionRelayDaemon>> | undefined;
            const requestController = new AbortController();
            let browserAvailable: Promise<void> | undefined;
            try {
              await new Promise<void>((resolve) => {
                gatewayServer.listen(gatewayPort, "127.0.0.1", resolve);
              });
              expect(getBrowserControlState()).toBeNull();
              if (standaloneFirst) {
                daemon = await runExtensionRelayDaemon({ port: relayPort });
              }

              const pairing = await buildBrowserExtensionPairing({
                cfg: config,
                localTransport: "gateway",
              });
              expect(pairing).toMatchObject({ relayPort, topology: "local" });
              const parsed = parsePairingString(pairing.pairingString);
              if (!parsed) {
                throw new Error("local pairing did not parse");
              }

              if (browserRequestAlreadyWaiting) {
                await startBrowserControlServiceFromConfig();
                browserAvailable = createBrowserControlContext()
                  .forProfile("chrome")
                  .ensureBrowserAvailable({ signal: requestController.signal });
              }

              const protocols = legacy
                ? ["openclaw-extension-relay", `openclaw-extension-token.${RELAY_KEY}`]
                : BROWSER_RELAY_EXTENSION_SUBPROTOCOL;
              if (saturatedSource) {
                saturationSockets = await Promise.all(
                  Array.from({ length: 32 }, async () => {
                    const ws = new WebSocket(parsed.relayUrl, protocols, {
                      headers: { "x-test-client-ip": "198.51.100.10" },
                    });
                    ws.on("error", () => {});
                    await once(ws, "open");
                    return ws;
                  }),
                );
                const overflow = new WebSocket(parsed.relayUrl, protocols, {
                  headers: { "x-test-client-ip": "198.51.100.10" },
                });
                overflow.on("error", () => {});
                const overflowClosed = once(overflow, "close");
                await once(overflow, "open");
                const [overflowCode] = await overflowClosed;
                expect(overflowCode).toBe(4013);
              }
              extension = new WebSocket(parsed.relayUrl, protocols, {
                ...(saturatedSource ? { headers: { "x-test-client-ip": "203.0.113.20" } } : {}),
                origin: "chrome-extension://gateway-wakeup-integration",
              });
              await once(extension, "open");
              if (!legacy) {
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
                const okMessage = once(extension, "message", {
                  signal: AbortSignal.timeout(2_000),
                });
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
              }
              if (legacy === "head") {
                expect(upgradeHeadBytes).toBe(coalesced?.byteLength);
              } else {
                extension.send(JSON.stringify(EXTENSION_HELLO));
              }

              await expect
                .poll(async () => {
                  const currentRelay = getBrowserControlState()?.extensionRelays?.get("chrome");
                  return currentRelay?.ownership === "borrowed"
                    ? (await currentRelay.client.status()).ready
                    : currentRelay?.bridge.extensionConnected;
                })
                .toBe(true);
              await expect(browserAvailable ?? Promise.resolve()).resolves.toBeUndefined();
              const relay = getBrowserControlState()?.extensionRelays?.get("chrome");
              expect(relay?.port).toBe(pairing.relayPort);
              if (!relay) {
                throw new Error("extension relay did not start");
              }
              if (coalesced) {
                await expect(relayInventory(relayPort)).resolves.toMatchObject(inventory.tabs);
              }
              if (standaloneFirst) {
                expect(relay.ownership).toBe("borrowed");
                if (relay.ownership !== "borrowed") {
                  throw new Error("Expected borrowed relay");
                }
                await expect(relay.client.status()).resolves.toMatchObject({
                  ready: true,
                  identity: { extensionVersion: "2", browserVersion: "Chrome/test" },
                });
                const profile = createBrowserControlContext().forProfile("chrome").profile;
                expect(new URL(profile.cdpUrl).username).toBe("");
                if (malformedFrame) {
                  const closed = once(extension, "close");
                  extension.send("invalid client frame", { mask: false });
                  const [code] = await closed;
                  expect(code).toBe(1002);
                  await expect.poll(async () => (await relay.client.status()).ready).toBe(false);
                }
                await stopBrowserControlService();
                const contender = await runExtensionRelayDaemon({ port: relayPort });
                await expect(contender.done).resolves.toBe("port-in-use");
                return;
              }
              if (relay.ownership !== "owned") {
                throw new Error("Expected owned relay");
              }

              for (let request = 0; request < 3; request += 1) {
                const profile = createBrowserControlContext().forProfile("chrome").profile;
                const cdpUrl = new URL(profile.cdpUrl);
                expect(cdpUrl.username).toBe("openclaw-internal");
                expect(cdpUrl.password === relay.internalToken).toBe(true);
                expect(getBrowserControlState()?.extensionRelays?.get("chrome")).toBe(relay);
                expect(extension.readyState).toBe(WebSocket.OPEN);
              }

              const authorization = Buffer.from(
                `openclaw-internal:${relay.internalToken}`,
              ).toString("base64");
              const response = await fetch(`http://127.0.0.1:${pairing.relayPort}/json/version`, {
                headers: { Authorization: `Basic ${authorization}` },
              });
              expect(response.status).toBe(200);
              await expect(response.json()).resolves.toMatchObject({
                Browser: "Chrome/test",
                webSocketDebuggerUrl: `ws://127.0.0.1:${pairing.relayPort}/cdp`,
              });
            } finally {
              requestController.abort();
              await browserAvailable?.catch(() => {});
              extension?.terminate();
              for (const socket of saturationSockets) {
                socket.terminate();
              }
              await stopBrowserControlService();
              daemon?.stop();
              await daemon?.done;
              await closeServer(gatewayServer);
            }
          },
        );
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
