// Shared auth rotation uses the real config writer and managed publication owner.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  ensureDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { resetLogger } from "../logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { startGatewayServerCore } from "./server-start.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const OLD_TOKEN = "shared-token-old";
const NEW_TOKEN = "shared-token-new";
const SECRET_REF_TOKEN_ID = "OPENCLAW_SHARED_AUTH_ROTATION_SECRET_REF";
type ConfigSnapshot = { hash: string; config: OpenClawConfig };
type ConfigAck = { hash: string; sentinel: { payload: { stats: { requiresRestart: boolean } } } };

describe("gateway shared auth rotation", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  let port: number;
  const clients: GatewayClient[] = [];

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "shared-auth-rotation",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        [SECRET_REF_TOKEN_ID]: undefined,
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
    port = await getFreePort();
  });

  afterEach(async () => {
    await runQaGatewayFixture(
      async () => {},
      ...clients.splice(0).map((client) => () => client.stopAndWait()),
      async () => {
        await server?.close();
        server = undefined;
      },
      () => state.cleanup(),
      () => resetLogger(),
      () => clearPluginMetadataLifecycleCaches(),
    );
  });

  async function startGateway(token: GatewayAuthConfig["token"] = OLD_TOKEN) {
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
        reload: { mode: "hybrid" },
      },
      logging: { level: "silent", consoleLevel: "silent" },
      agents: { defaults: { workspace: state.workspaceDir } },
    });
    server = await startGatewayServerCore(port, { controlUiEnabled: false });
    await server.startupSettled;
  }

  async function connect(
    options: Pick<
      GatewayClientOptions,
      "token" | "deviceToken" | "deviceIdentity" | "clientName" | "mode" | "origin"
    >,
  ) {
    const connected = createDeferredCore<HelloOk>();
    const closed = createDeferredCore<{ code: number; reason: string }>();
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let hellos = 0;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      platform: "test",
      mode: "backend",
      deviceIdentity: null,
      scopes: ["operator.admin"],
      ...options,
      // Each connection presents only its declared credential, never a cached fallback.
      hostDeps: {
        loadDeviceAuthToken: () => null,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onHelloOk: (hello) => {
        hellos += 1;
        connected.resolve(hello);
      },
      onConnectError: (error) => connected.reject(error),
      onClose: (code, reason) => {
        closeEvents.push({ code, reason });
        connected.reject(new Error(`closed ${code}: ${reason}`));
        closed.resolve({ code, reason });
      },
    });
    clients.push(client);
    client.start();
    const hello = await withTestTimeout(connected.promise, 10_000, "gateway connect timeout");
    return { client, hello, closed: closed.promise, closeEvents, hellos: () => hellos };
  }

  async function openDeviceTokenClient(
    params: { issuerGeneration?: string; browserClient?: boolean } = {},
  ) {
    const identity = loadOrCreateDeviceIdentity({ path: state.path("device-identity.sqlite") });
    const clientName = params.browserClient ? "openclaw-control-ui" : "test";
    const mode = params.browserClient ? "webchat" : "test";
    const pending = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      clientId: clientName,
      clientMode: mode,
      role: "operator",
      scopes: ["operator.admin"],
    });
    await approveDevicePairing(pending.request.requestId, { callerScopes: ["operator.admin"] });
    let issued;
    if (params.issuerGeneration) {
      issued = await ensureDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
        issuer: { kind: "shared-gateway-auth", generation: params.issuerGeneration },
      });
    } else {
      const rotated = await rotateDeviceToken({
        deviceId: identity.deviceId,
        role: "operator",
        scopes: ["operator.admin"],
      });
      expect(rotated.ok).toBe(true);
      issued = rotated.ok ? rotated.entry : undefined;
    }
    expect(issued?.token).toBeTypeOf("string");
    if (!issued) {
      throw new Error("expected issued device token");
    }
    const connection = await connect({
      clientName,
      mode,
      deviceIdentity: identity,
      deviceToken: issued.token,
      ...(params.browserClient ? { origin: `http://127.0.0.1:${port}` } : {}),
    });
    return { ...connection, deviceId: identity.deviceId };
  }

  function requiredSharedGeneration() {
    const generation = resolveSharedGatewaySessionGeneration({
      mode: "token",
      token: OLD_TOKEN,
      allowTailscale: false,
    });
    expect(generation).toBeTypeOf("string");
    if (!generation) {
      throw new Error("expected shared gateway generation");
    }
    return generation;
  }

  async function rotateSharedToken(client: GatewayClient) {
    const before = await client.request<ConfigSnapshot>("config.get");
    const ack = await client.request<ConfigAck>("config.patch", {
      baseHash: before.hash,
      raw: JSON.stringify({ gateway: { auth: { token: NEW_TOKEN } } }),
      restartDelayMs: 1_000,
    });
    expect(ack).toMatchObject({
      hash: expect.any(String),
      sentinel: { payload: { stats: { requiresRestart: false } } },
    });
    return ack;
  }

  async function expectAuthChangedClose(connection: Awaited<ReturnType<typeof connect>>) {
    await expect(
      withTestTimeout(connection.closed, 10_000, "gateway auth rotation did not close socket"),
    ).resolves.toEqual({ code: 4001, reason: "gateway auth changed" });
    await connection.client.stopAndWait();
  }

  it("disconnects existing shared-token websocket sessions after config.patch rotates auth", async () => {
    await startGateway();
    const connection = await connect({ token: OLD_TOKEN });
    await rotateSharedToken(connection.client);
    await expectAuthChangedClose(connection);
  });

  it("keeps existing device-token websocket sessions connected after shared token rotation", async () => {
    await startGateway();
    const connection = await openDeviceTokenClient();
    const ack = await rotateSharedToken(connection.client);
    const followUp = await connection.client.request<ConfigSnapshot>("config.get");
    expect(followUp.hash).toBe(ack.hash);
    expect(connection.closeEvents).toEqual([]);
    expect(connection.hellos()).toBe(1);
  });

  it("disconnects issuer-tagged device-token websocket sessions after shared token rotation", async () => {
    await startGateway();
    const connection = await openDeviceTokenClient({
      issuerGeneration: requiredSharedGeneration(),
    });
    await rotateSharedToken(connection.client);
    await expectAuthChangedClose(connection);
  });

  it.each([
    { label: "browser", browserClient: true },
    { label: "non-browser", browserClient: false },
  ])("preserves issuer-tagged $label device tokens on reconnect", async ({ browserClient }) => {
    await startGateway();
    const issuerGeneration = requiredSharedGeneration();
    const { deviceId, hello } = await openDeviceTokenClient({ issuerGeneration, browserClient });
    const token = hello.auth?.deviceToken;
    expect(token).toBeTypeOf("string");
    if (typeof token !== "string") {
      throw new Error("expected hello device token");
    }
    expect((await getPairedDevice(deviceId))?.tokens?.operator?.issuer).toEqual({
      kind: "shared-gateway-auth",
      generation: issuerGeneration,
    });
    await expect(
      verifyDeviceToken({
        deviceId,
        token,
        role: "operator",
        scopes: ["operator.admin"],
        requiredSharedGatewaySessionGeneration: issuerGeneration,
      }),
    ).resolves.toEqual({
      ok: true,
      issuer: { kind: "shared-gateway-auth", generation: issuerGeneration },
    });
  });

  it("disconnects shared-auth websocket sessions when config.apply rewrites a SecretRef token", async () => {
    setTestEnvValue(SECRET_REF_TOKEN_ID, OLD_TOKEN);
    await startGateway({ source: "env", provider: "default", id: SECRET_REF_TOKEN_ID });
    const connection = await connect({ token: OLD_TOKEN });
    const before = await connection.client.request<ConfigSnapshot>("config.get");
    setTestEnvValue(SECRET_REF_TOKEN_ID, NEW_TOKEN);
    const ack = await connection.client.request<ConfigAck>("config.apply", {
      baseHash: before.hash,
      raw: JSON.stringify(before.config),
    });
    expect(ack).toMatchObject({
      hash: expect.any(String),
      sentinel: { payload: { stats: { requiresRestart: false } } },
    });
    await expectAuthChangedClose(connection);
  });
});
