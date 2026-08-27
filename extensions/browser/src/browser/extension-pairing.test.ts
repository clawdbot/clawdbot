import fs from "node:fs";
import path from "node:path";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { relayTestKey } from "../../chrome-extension/relay-key.test-support.js";
import { buildBrowserExtensionPairing } from "./extension-pairing.js";

const RELAY_KEY = relayTestKey(5);
const ensureToken = async () => RELAY_KEY;

describe("buildBrowserExtensionPairing", () => {
  it("pairs with the first writer's key when its file is already open but empty", async () => {
    await withTempDir("openclaw-pairing-", async (dir) => {
      const stateDir = fs.realpathSync(dir);
      const credentials = path.join(stateDir, "credentials");
      fs.mkdirSync(credentials, { mode: 0o700 });
      const secretPath = path.join(credentials, "browser-extension-relay.secret");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: credentials },
        async () => {
          const fd = fs.openSync(secretPath, "wx", 0o600);
          try {
            const before = fs.fstatSync(fd);
            const pairing = buildBrowserExtensionPairing({ cfg: {}, localTransport: "gateway" });
            fs.writeFileSync(fd, `${RELAY_KEY}\n`);
            const result = await pairing;
            expect(new URL(result.pairingString).hash).toBe(`#${RELAY_KEY}`);
            expect(result.topology).toBe("local");
            expect(fs.readFileSync(secretPath, "utf8")).toBe(`${RELAY_KEY}\n`);
            expect(fs.statSync(secretPath)).toMatchObject({ dev: before.dev, ino: before.ino });
          } finally {
            fs.closeSync(fd);
          }
        },
      );
    });
  });

  it("preserves the standalone host relay for local manual pairing compatibility", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: undefined }, async () => {
      await expect(
        buildBrowserExtensionPairing({
          cfg: {
            gateway: { port: 19_089 },
            browser: {
              profiles: { chrome: { driver: "extension", cdpPort: 19_199 } },
            },
          },
          ensureToken,
        }),
      ).resolves.toEqual({
        pairingString: `ws://127.0.0.1:19199/extension?gateway=ws%3A%2F%2F127.0.0.1%3A19089#${RELAY_KEY}`,
        relayPort: 19_199,
        topology: "local",
      });
    });
  });

  it("routes local native bootstrap through the Gateway while retaining relay metadata", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: undefined }, async () => {
      await expect(
        buildBrowserExtensionPairing({
          cfg: {
            gateway: { port: 19_089 },
            browser: {
              profiles: { chrome: { driver: "extension", cdpPort: 19_199 } },
            },
          },
          localTransport: "gateway",
          ensureToken,
        }),
      ).resolves.toEqual({
        pairingString: `ws://127.0.0.1:19089/browser/extension?gateway=ws%3A%2F%2F127.0.0.1%3A19089#${RELAY_KEY}`,
        relayPort: 19_199,
        topology: "local",
      });
    });
  });

  it.each([
    {
      label: "remote TLS Gateway",
      gatewayUrl: "wss://gateway.example.com:9444",
      encodedGateway: "wss%3A%2F%2Fgateway.example.com%3A9444",
    },
    {
      label: "loopback SSH tunnel to a remote Gateway",
      gatewayUrl: "ws://127.0.0.1:29089",
      encodedGateway: "ws%3A%2F%2F127.0.0.1%3A29089",
    },
  ])("keeps browser-node bootstrap on the host-local relay for $label", async (testCase) => {
    await expect(
      buildBrowserExtensionPairing({
        cfg: {
          gateway: {
            mode: "remote",
            remote: { url: testCase.gatewayUrl },
          },
          browser: {
            profiles: { chrome: { driver: "extension", cdpPort: 19_198 } },
          },
        },
        ensureToken,
      }),
    ).resolves.toEqual({
      pairingString: `ws://127.0.0.1:19198/extension?gateway=${testCase.encodedGateway}#${RELAY_KEY}`,
      relayPort: 19_198,
      topology: "browser-node",
    });
  });

  it("keeps an explicit remote Gateway direct and manual-only", async () => {
    await expect(
      buildBrowserExtensionPairing({
        cfg: {
          browser: {
            profiles: { chrome: { driver: "extension", cdpPort: 19_197 } },
          },
        },
        gatewayUrl: "wss://gateway.example.com:9443",
        ensureToken,
      }),
    ).resolves.toEqual({
      pairingString: `wss://gateway.example.com:9443/browser/extension?gateway=wss%3A%2F%2Fgateway.example.com%3A9443#${RELAY_KEY}`,
      relayPort: 19_197,
      topology: "direct-remote",
    });
  });

  it("requires an explicit certificate hostname for local Gateway TLS", async () => {
    await expect(
      buildBrowserExtensionPairing({
        cfg: { gateway: { tls: { enabled: true } } },
        ensureToken,
      }),
    ).rejects.toThrow("--gateway-url wss://<certificate-host>");
  });
});
