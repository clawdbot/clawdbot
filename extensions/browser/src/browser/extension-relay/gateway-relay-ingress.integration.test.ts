import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { handleGatewayExtensionUpgrade } from "./gateway-relay-route.js";
import type { RelayOwnerClient } from "./owner-client.js";
import { RELAY_OWNER_LIMIT } from "./owner-protocol.js";
import { withConnectedDaemon } from "./relay-coexistence.test-support.js";
import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
});

it.each(["peer-close", "preparation-failure", "superseded"] as const)(
  "releases a paused legacy ingress after %s without retiring the standalone relay",
  async (outcome) => {
    await withConnectedDaemon(async ({ token, extension }) => {
      const state = await startBrowserControlServiceFromConfig();
      if (!state) {
        throw new Error("Expected Browser control state");
      }
      const profile = createBrowserControlContext().forProfile("chrome").profile;
      const relay = await ensureExtensionRelayForProfile(state, profile);
      if (relay.ownership !== "borrowed") {
        throw new Error("Expected borrowed relay");
      }
      const release = createDeferred<void>();
      const prepared = createDeferred<{ ws: WebSocket; client: RelayOwnerClient }>();
      const prepareIngress = relay.client.prepareIngress.bind(relay.client);
      vi.spyOn(relay.client, "prepareIngress").mockImplementation(async (ws) => {
        // Hold only the final preparation handoff, after the real owner has
        // authenticated and allocated its ingress stream. No protocol owner is mocked.
        const attach = await prepareIngress(ws);
        prepared.resolve({ ws, client: relay.client });
        await release.promise;
        if (outcome === "preparation-failure") {
          throw new Error("ingress preparation interrupted");
        }
        return attach;
      });
      const server = http.createServer();
      server.on("upgrade", (req, socket, head) => {
        void handleGatewayExtensionUpgrade(req, socket, head);
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback listener");
      }
      const peer = net.createConnection({ host: "127.0.0.1", port: address.port });
      const candidate = new WebSocket(
        `ws://127.0.0.1:${address.port}/browser/extension?profile=chrome`,
        ["openclaw-extension-relay", `openclaw-extension-token.${token}`],
        {
          origin: "chrome-extension://legacy-ingress-cleanup",
          createConnection: () => peer,
        },
      );
      try {
        await once(candidate, "open");
        candidate.send(
          JSON.stringify({
            type: "hello",
            userAgent: "legacy-candidate",
            browserVersion: "Chrome/candidate",
            extensionVersion: "2",
            tabs: [],
          }),
        );
        const { ws, client } = await prepared.promise;
        expect(ws.isPaused).toBe(true);
        // A hello waiting in the transport must not replace the active extension.
        await expect(client.status()).resolves.toMatchObject({
          identity: { browserVersion: "Chrome/test" },
        });
        const serverClosed = once(ws, "close");
        const peerClosed = once(candidate, "close");
        if (outcome === "peer-close") {
          peer.resetAndDestroy();
          await serverClosed;
        } else if (outcome === "superseded") {
          await stopBrowserControlService();
          await serverClosed;
        }
        release.resolve();
        await serverClosed;
        const [code] = await peerClosed;
        if (outcome === "preparation-failure") {
          expect(code).toBe(1011);
        }
        if (outcome !== "superseded") {
          await expect(client.status()).resolves.toMatchObject({
            ready: true,
            identity: { browserVersion: "Chrome/test" },
          });
          // Capacity is checked by the real owner: the abandoned ingress must
          // leave the entire stream budget available, not merely close its peer.
          for (let index = 0; index < RELAY_OWNER_LIMIT; index += 1) {
            await client.openTransport();
          }
        }
        expect(extension.readyState).toBe(WebSocket.OPEN);
        await stopBrowserControlService();
        expect(extension.readyState).toBe(WebSocket.OPEN);
      } finally {
        release.resolve();
        candidate.terminate();
        await stopBrowserControlService();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });
  },
);
