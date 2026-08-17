// @vitest-environment node
// Store-owned "forget this browser" credential reset: token-only, gateway-scoped,
// and it drops the tab's shared/bootstrap credentials so a reconnect cannot
// silently resume the old session. Split from gateway-store.test.ts (max-lines).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayBrowserClientOptions } from "../api/gateway.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar.ts";
import { loadDeviceAuthToken, storeDeviceAuthToken } from "../lib/nodes/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

class FakeGatewayClient {
  readonly instanceId: string;

  constructor(readonly opts: GatewayBrowserClientOptions) {
    this.instanceId = opts.instanceId ?? "";
  }

  start() {}

  stop() {}

  request = vi.fn(
    (_method: string, _params: unknown): Promise<unknown> =>
      Promise.reject(new Error("unexpected gateway request")),
  );

  addEventListener() {
    return () => {};
  }
}

function createStore() {
  const clients: FakeGatewayClient[] = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = new FakeGatewayClient(opts);
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  const current = () => {
    const client = clients.at(-1);
    if (!client) {
      throw new Error("expected a gateway client");
    }
    return client;
  };
  return { gateway, clients, current };
}

describe("createApplicationGateway stored device credential", () => {
  const DEVICE_ID = "device-1";
  const OTHER_GATEWAY = "wss://other-remote.example.test";

  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    vi.stubGlobal("location", {
      protocol: "http:",
      host: "127.0.0.1:18789",
      hostname: "127.0.0.1",
      origin: "http://127.0.0.1:18789",
      pathname: "/",
    } as Location);
  });

  afterEach(() => {
    setAvatarGatewayOrigin(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function seedDeviceIdentity() {
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({
        version: 1,
        deviceId: DEVICE_ID,
        publicKey: "AA",
        privateKey: "AA",
        createdAtMs: 1,
      }),
    );
  }

  it("forgets only the current gateway's operator token and reconnects", () => {
    const { gateway, clients } = createStore();
    gateway.start();
    const gatewayUrl = gateway.connection.gatewayUrl;
    seedDeviceIdentity();
    storeDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl,
      role: "operator",
      token: "current-gateway-token",
      scopes: ["operator.read"],
    });
    storeDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl: OTHER_GATEWAY,
      role: "operator",
      token: "other-gateway-token",
      scopes: ["operator.read"],
    });

    expect(gateway.hasStoredDeviceToken?.()).toBe(true);
    const clientsBefore = clients.length;
    expect(gateway.forgetDeviceToken?.()).toBe(true);

    expect(loadDeviceAuthToken({ deviceId: DEVICE_ID, gatewayUrl, role: "operator" })).toBeNull();
    expect(
      loadDeviceAuthToken({ deviceId: DEVICE_ID, gatewayUrl: OTHER_GATEWAY, role: "operator" })
        ?.token,
    ).toBe("other-gateway-token");
    // Token-only reset: the browser device identity survives.
    expect(localStorage.getItem("openclaw-device-identity-v1")).not.toBeNull();
    expect(clients.length).toBe(clientsBefore + 1);
    expect(gateway.hasStoredDeviceToken?.()).toBe(false);
  });

  it("reports no stored credential and skips reconnect when nothing is stored", () => {
    const { gateway, clients } = createStore();
    gateway.start();
    const clientsBefore = clients.length;

    expect(gateway.hasStoredDeviceToken?.()).toBe(false);
    expect(gateway.forgetDeviceToken?.()).toBe(false);
    expect(clients.length).toBe(clientsBefore);
  });

  it("drops this tab's shared credentials so forget cannot resume the old session", () => {
    // Regression (review P1): connection auth prefers shared/bootstrap tokens
    // over stored device auth, so a token-bearing tab must lose them too or
    // the reconnect silently reuses the old session.
    const { gateway, current } = createStore();
    gateway.start();
    gateway.connect({ token: "page-shared-token", password: "gate-password" });
    expect(current().opts.token).toBe("page-shared-token");
    const gatewayUrl = gateway.connection.gatewayUrl;
    seedDeviceIdentity();
    storeDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl,
      role: "operator",
      token: "stored-device-token",
      scopes: ["operator.read"],
    });

    expect(gateway.forgetDeviceToken?.()).toBe(true);

    expect(current().opts.token).toBeUndefined();
    expect(current().opts.bootstrapToken).toBeUndefined();
    expect(current().opts.password).toBeUndefined();
    expect(gateway.connection.token).toBe("");
    expect(loadDeviceAuthToken({ deviceId: DEVICE_ID, gatewayUrl, role: "operator" })).toBeNull();
  });

  it("forgets a credential persisted only under a role alias", () => {
    // Regression: an alias-keyed entry (" operator ") is accepted by the
    // reader, so Forget must actually delete it instead of reporting success
    // while the stale credential stays selectable.
    const { gateway } = createStore();
    gateway.start();
    const gatewayUrl = gateway.connection.gatewayUrl;
    seedDeviceIdentity();
    storeDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl,
      role: "operator",
      token: "alias-token",
      scopes: ["operator.read"],
    });
    const storageKey = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    ).find((candidate) => candidate?.startsWith("openclaw.device.auth.v1:"));
    if (!storageKey) {
      throw new Error("missing device-auth storage key");
    }
    const store = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    store.tokens = { " operator ": store.tokens.operator };
    localStorage.setItem(storageKey, JSON.stringify(store));

    expect(gateway.hasStoredDeviceToken?.()).toBe(true);
    expect(gateway.forgetDeviceToken?.()).toBe(true);
    expect(loadDeviceAuthToken({ deviceId: DEVICE_ID, gatewayUrl, role: "operator" })).toBeNull();
    expect(gateway.hasStoredDeviceToken?.()).toBe(false);
  });

  it("clears the credential without auto-connecting a stopped gateway", () => {
    const { gateway, clients } = createStore();
    const gatewayUrl = gateway.connection.gatewayUrl;
    seedDeviceIdentity();
    storeDeviceAuthToken({
      deviceId: DEVICE_ID,
      gatewayUrl,
      role: "operator",
      token: "current-gateway-token",
      scopes: ["operator.read"],
    });

    expect(gateway.forgetDeviceToken?.()).toBe(true);

    expect(loadDeviceAuthToken({ deviceId: DEVICE_ID, gatewayUrl, role: "operator" })).toBeNull();
    expect(clients.length).toBe(0);
  });
});
