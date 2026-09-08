// A config writer receives the committed revision before its own policy retires its socket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import * as restartSentinel from "../infra/restart-sentinel.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient } from "./client.js";
import { startGatewayServerCore } from "./server-start.js";

type ConfigSnapshot = { hash: string; config: OpenClawConfig };
type ConfigAck = { hash: string; sentinel: { payload: { stats: { requiresRestart: boolean } } } };

describe("config writer policy-close ordering", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const clients: GatewayClient[] = [];
  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "config-policy-response",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.stopAndWait()));
    await server?.close();
    server = undefined;
    await state.cleanup();
    resetLogger();
    clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
  });

  it.each([
    { method: "config.patch", policy: "token" },
    { method: "config.apply", policy: "token" },
    { method: "config.patch", policy: "origin" },
    { method: "config.apply", policy: "origin" },
  ] as const)(
    "acknowledges $method before closing its $policy-revoked writer",
    async ({ method, policy }) => {
      const token = "config-response-old-token";
      const nextToken = "config-response-new-token";
      const origin = "https://writer.example.test";
      await state.writeConfig({
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token },
          controlUi: { enabled: false, allowedOrigins: [origin] },
          reload: { mode: "hybrid" },
        },
        logging: { level: "silent", consoleLevel: "silent" },
        agents: { defaults: { workspace: state.workspaceDir } },
      });
      const port = await getFreePort();
      server = await startGatewayServerCore(port, { controlUiEnabled: false });
      await server.startupSettled;
      const held = createDeferredCore();
      const published = createDeferredCore<restartSentinel.RestartSentinelPayload>();
      const writeSentinel = restartSentinel.writeRestartSentinel;
      vi.spyOn(restartSentinel, "writeRestartSentinel").mockImplementation(async (payload) => {
        published.resolve(payload);
        await held.promise;
        return await writeSentinel(payload);
      });
      const connect = async (credential: string, browser = false) => {
        const closed = createDeferredCore();
        const connected = createDeferredCore();
        let didClose = false;
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: credential,
          clientName: browser ? "openclaw-control-ui" : "gateway-client",
          clientVersion: "1.0.0",
          mode: browser ? "webchat" : "backend",
          ...(browser ? { origin } : {}),
          deviceIdentity: browser
            ? loadOrCreateDeviceIdentity({
                path: state.path("browser-identity.sqlite"),
              })
            : null,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          hostDeps: {
            loadDeviceAuthToken: () => null,
            storeDeviceAuthToken: () => {},
            clearDeviceAuthToken: () => {},
          },
          onHelloOk: () => connected.resolve(),
          onConnectError: (error) => connected.reject(error),
          onClose: (code, reason) => {
            didClose = true;
            client.stop();
            connected.reject(new Error(`closed ${code}: ${reason}`));
            closed.resolve();
          },
        });
        clients.push(client);
        client.start();
        await connected.promise;
        return { client, closed: closed.promise, didClose: () => didClose };
      };
      try {
        const writer = await connect(token, policy === "origin");
        const peer = await connect(token, policy === "origin");
        const before = await writer.client.request<ConfigSnapshot>("config.get");
        const change =
          policy === "token"
            ? { gateway: { auth: { token: nextToken } } }
            : { gateway: { controlUi: { allowedOrigins: ["https://retained.example.test"] } } };
        const nextConfig = structuredClone(before.config);
        nextConfig.gateway = {
          ...nextConfig.gateway,
          ...(policy === "token"
            ? { auth: { ...nextConfig.gateway?.auth, token: nextToken } }
            : {
                controlUi: {
                  ...nextConfig.gateway?.controlUi,
                  allowedOrigins: ["https://retained.example.test"],
                },
              }),
        };
        const result = writer.client.request<ConfigAck>(method, {
          baseHash: before.hash,
          raw: JSON.stringify(method === "config.apply" ? nextConfig : change),
          ...(method === "config.patch" && policy === "origin"
            ? { replacePaths: ["gateway.controlUi.allowedOrigins"] }
            : {}),
        });
        void result.catch(() => {});
        const publication = await Promise.race([
          published.promise,
          result.then(() => {
            throw new Error("RPC completed before its sentinel");
          }),
        ]);
        expect(publication.stats?.requiresRestart).toBe(false);
        await peer.closed;
        expect(writer.didClose()).toBe(false);
        const staleRead = writer.client.request("health");
        void staleRead.catch(() => {});
        held.resolve();
        const response = await result;
        expect(response).toMatchObject({
          hash: expect.any(String),
          sentinel: { payload: { stats: { requiresRestart: false } } },
        });
        expect(response.hash).not.toBe(before.hash);
        await writer.closed;
        await expect(staleRead).rejects.toThrow();
        const fresh = await connect(policy === "token" ? nextToken : token);
        expect((await fresh.client.request<ConfigSnapshot>("config.get")).hash).toBe(response.hash);
      } finally {
        held.resolve();
      }
    },
  );
});
