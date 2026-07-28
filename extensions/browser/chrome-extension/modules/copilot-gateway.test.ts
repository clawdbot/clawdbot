import { describe, expect, it, vi } from "vitest";
import {
  createCopilotTokenStore,
  loadOrCreateCopilotIdentity,
  resolveCopilotClose,
} from "./copilot-gateway-lifecycle.js";
import { CopilotGatewayClient, isDefinitiveGatewayRejection } from "./copilot-gateway.js";
import { GatewayProtocolRequestError } from "./copilot-runtime.js";

function storageArea() {
  const values: Record<string, unknown> = {};
  return {
    async get(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(update: Record<string, unknown>) {
      Object.assign(values, update);
    },
  };
}

function controllableStorageArea() {
  const values: Record<string, unknown> = {};
  let nextWrite: { release: Promise<void>; started: () => void } | undefined;
  const storage = {
    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => {
      const blocked = nextWrite;
      nextWrite = undefined;
      if (blocked) {
        blocked.started();
        await blocked.release;
      }
      Object.assign(values, update);
    }),
  };
  return {
    storage,
    blockNextWrite() {
      let markStarted: (() => void) | undefined;
      let releaseWrite: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      nextWrite = { release, started: () => markStarted?.() };
      return { started, release: () => releaseWrite?.() };
    },
  };
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();

  constructor() {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(name: string, listener: (event: Record<string, unknown>) => void) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", { code, reason }));
  }

  message(frame: Record<string, unknown>) {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  private emit(name: string, event: Record<string, unknown>) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(event);
    }
  }
}

describe("browser copilot Gateway custody", () => {
  it("scopes device identities and issued tokens to one Gateway", async () => {
    const storage = storageArea();
    const gatewayA = "ws://127.0.0.1:18789/";
    const gatewayB = "ws://127.0.0.1:28789/";
    const identityA = await loadOrCreateCopilotIdentity(storage, gatewayA);
    const identityAAgain = await loadOrCreateCopilotIdentity(storage, gatewayA);
    const identityB = await loadOrCreateCopilotIdentity(storage, gatewayB);

    expect(identityAAgain.deviceId).toBe(identityA.deviceId);
    expect(identityB.deviceId).not.toBe(identityA.deviceId);

    const tokenParams = {
      clientId: "openclaw-browser-copilot",
      deviceId: identityA.deviceId,
      role: "operator",
    };
    const tokenA = createCopilotTokenStore(storage, gatewayA);
    const tokenB = createCopilotTokenStore(storage, gatewayB);
    await tokenA.store({ ...tokenParams, token: "test-token", scopes: ["operator.read"] });

    await expect(tokenA.load(tokenParams)).resolves.toEqual({
      token: "test-token",
      scopes: ["operator.read"],
    });
    await expect(tokenB.load(tokenParams)).resolves.toBeNull();
  });

  it("serializes shared credential maps across concurrent Gateway clients", async () => {
    const controlled = controllableStorageArea();
    const gatewayA = "ws://127.0.0.1:18789/";
    const gatewayB = "ws://127.0.0.1:28789/";

    const identityWrite = controlled.blockNextWrite();
    const firstIdentity = loadOrCreateCopilotIdentity(controlled.storage, gatewayA);
    await identityWrite.started;
    const secondIdentity = loadOrCreateCopilotIdentity(controlled.storage, gatewayB);
    identityWrite.release();
    const [identityA, identityB] = await Promise.all([firstIdentity, secondIdentity]);
    await expect(loadOrCreateCopilotIdentity(controlled.storage, gatewayA)).resolves.toMatchObject({
      deviceId: identityA.deviceId,
    });
    await expect(loadOrCreateCopilotIdentity(controlled.storage, gatewayB)).resolves.toMatchObject({
      deviceId: identityB.deviceId,
    });

    const tokenParams = (deviceId: string) => ({
      clientId: "openclaw-browser-copilot",
      deviceId,
      role: "operator",
    });
    const tokenA = createCopilotTokenStore(controlled.storage, gatewayA);
    const tokenB = createCopilotTokenStore(controlled.storage, gatewayB);
    const storeGate = controlled.blockNextWrite();
    const firstStore = tokenA.store({
      ...tokenParams(identityA.deviceId),
      token: "test-token-placeholder",
      scopes: ["operator.read"],
    });
    await storeGate.started;
    const secondStore = tokenB.store({
      ...tokenParams(identityB.deviceId),
      token: "test-token-placeholder",
      scopes: ["operator.write"],
    });
    storeGate.release();
    await Promise.all([firstStore, secondStore]);
    await expect(tokenA.load(tokenParams(identityA.deviceId))).resolves.toMatchObject({
      token: "test-token-placeholder",
    });
    await expect(tokenB.load(tokenParams(identityB.deviceId))).resolves.toMatchObject({
      token: "test-token-placeholder",
    });

    const replacementWrite = controlled.blockNextWrite();
    const replacing = tokenA.store({
      ...tokenParams(identityA.deviceId),
      token: "test-token-placeholder",
      scopes: ["operator.read", "operator.write"],
    });
    await replacementWrite.started;
    const clearing = tokenA.clear(tokenParams(identityA.deviceId));
    replacementWrite.release();
    await Promise.all([replacing, clearing]);
    await expect(tokenA.load(tokenParams(identityA.deviceId))).resolves.toBeNull();
  });

  it("keeps the pairing approval state when the failed socket closes", () => {
    const error = { details: { code: "PAIRING_REQUIRED", pauseReconnect: true } };

    expect(resolveCopilotClose({ connectFailure: { error } })).toEqual({
      retry: true,
      notify: false,
      pendingError: error,
    });
    expect(
      resolveCopilotClose({
        connectFailure: { error: { details: { pauseReconnect: true } } },
      }).retry,
    ).toBe(false);
    expect(
      resolveCopilotClose({
        connectFailure: {
          error: {
            details: { code: "AUTH_DEVICE_TOKEN_MISMATCH", pauseReconnect: false },
          },
        },
      }).retry,
    ).toBe(false);
    expect(resolveCopilotClose({})).toEqual({
      retry: true,
      notify: true,
      pendingError: undefined,
    });
  });

  it("clears a rejected device token before starting a fresh connection", async () => {
    const values: Record<string, unknown> = {};
    let releaseClear: (() => void) | undefined;
    let markClearStarted: (() => void) | undefined;
    const clearStarted = new Promise<void>((resolve) => {
      markClearStarted = resolve;
    });
    let blockNextSet = false;
    const storage = {
      async get(keys: string[]) {
        return Object.fromEntries(keys.map((key) => [key, values[key]]));
      },
      async set(update: Record<string, unknown>) {
        if (blockNextSet) {
          blockNextSet = false;
          markClearStarted?.();
          await new Promise<void>((resolve) => {
            releaseClear = resolve;
          });
        }
        Object.assign(values, update);
      },
    };
    const gatewayScope = "ws://127.0.0.1:18789/";
    const identity = await loadOrCreateCopilotIdentity(storage, gatewayScope);
    const tokenStore = createCopilotTokenStore(storage, gatewayScope);
    const tokenParams = {
      clientId: "openclaw-browser-copilot",
      deviceId: identity.deviceId,
      role: "operator",
    };
    await tokenStore.store({
      ...tokenParams,
      token: "test-token",
      scopes: ["operator.read", "operator.write"],
    });
    blockNextSet = true;
    FakeWebSocket.instances = [];
    vi.stubGlobal("chrome", { runtime: { getManifest: () => ({ version: "test" }) } });
    vi.stubGlobal("navigator", { language: "en", userAgent: "copilot-test" });
    const client = new CopilotGatewayClient({
      storage,
      WebSocketImpl: FakeWebSocket as never,
    });

    try {
      client.start(gatewayScope);
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const first = FakeWebSocket.instances[0];
      first?.message({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "first-nonce" },
      });
      await vi.waitFor(() => expect(first?.sent).toHaveLength(1));
      const firstConnect = first?.sent[0] as {
        id?: string;
        params?: { auth?: { token?: string } };
      };
      expect(firstConnect.params?.auth?.token).toBe("test-token");
      first?.message({
        type: "res",
        id: firstConnect.id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "device token rejected",
          details: { code: "AUTH_DEVICE_TOKEN_MISMATCH", pauseReconnect: true },
        },
      });
      await clearStarted;
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);

      releaseClear?.();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      const second = FakeWebSocket.instances[1];
      second?.message({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "second-nonce" },
      });
      await vi.waitFor(() => expect(second?.sent).toHaveLength(1));
      const secondConnect = second?.sent[0] as { params?: { auth?: { token?: string } } };
      expect(secondConnect.params?.auth?.token).toBeUndefined();
      await expect(tokenStore.load(tokenParams)).resolves.toBeNull();
    } finally {
      releaseClear?.();
      client.stop();
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes server rejection from ambiguous transport failure", () => {
    expect(
      isDefinitiveGatewayRejection(
        new GatewayProtocolRequestError({ code: "INVALID_REQUEST", message: "fixture rejection" }),
      ),
    ).toBe(true);
    expect(isDefinitiveGatewayRejection(new Error("fixture socket closed"))).toBe(false);
  });
});
