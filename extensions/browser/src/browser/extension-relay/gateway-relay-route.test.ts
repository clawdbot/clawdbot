import { EventEmitter } from "node:events";
// Gateway extension relay upgrade handler: auth + routing decisions.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getBrowserControlStateMock = vi.fn();
const startBrowserControlServiceFromConfigMock = vi.fn();
vi.mock("../../control-service.js", () => ({
  getBrowserControlState: () => getBrowserControlStateMock(),
  startBrowserControlServiceFromConfig: async () => {
    const state = await startBrowserControlServiceFromConfigMock();
    if (state) {
      getBrowserControlStateMock.mockReturnValue(state);
    }
    return state;
  },
}));

const ensureExtensionRelayForProfileMock = vi.fn();
vi.mock("./relay-lifecycle.js", () => ({
  ensureExtensionRelayForProfile: async (
    state: ReturnType<typeof stateWithExtensionProfile>,
    profile: { name: string; cdpPort: number },
  ) => {
    const result = await ensureExtensionRelayForProfileMock(state, profile);
    const relay = {
      ...result,
      ownership: "owned",
      port: profile.cdpPort,
      token: readExtensionRelayTokenMock(),
    };
    state.extensionRelays.set(profile.name, relay);
    return relay;
  },
}));

const resolveProfileMock = vi.fn();
vi.mock("../config.js", () => ({
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
}));

const configState = vi.hoisted(() => ({ allowLegacyAuth: true }));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({
    browser: { extensionRelay: { allowLegacyAuth: configState.allowLegacyAuth } },
  }),
}));

const attachExtensionWebSocketMock = vi.fn();
const authenticateExtensionWebSocketMock = vi.fn();
vi.mock("./relay-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relay-server.js")>();
  return {
    ...actual,
    attachExtensionWebSocket: (...args: unknown[]) => attachExtensionWebSocketMock(...args),
    authenticateExtensionWebSocket: (...args: unknown[]) =>
      authenticateExtensionWebSocketMock(...args),
  };
});

const readExtensionRelayTokenMock = vi.fn();
vi.mock("./relay-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relay-auth.js")>();
  return {
    ...actual,
    readExtensionRelayToken: () => readExtensionRelayTokenMock(),
  };
});

import { invalidateBrowserRelayAuthV2Authority } from "./auth-v2.js";
import {
  disposeGatewayExtensionRelay,
  handleGatewayExtensionUpgrade,
} from "./gateway-relay-route.js";

const TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);

function fakeSocket() {
  const writes: string[] = [];
  let destroyed = false;
  const socket = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    destroy: () => {
      destroyed = true;
    },
  }) as unknown as Duplex;
  return { socket, writes, isDestroyed: () => destroyed };
}

function req(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers: { origin: "chrome-extension://abc", ...headers } } as IncomingMessage;
}

function relayReq(
  url: string,
  token = TOKEN,
  headers: Record<string, string> = {},
): IncomingMessage {
  return req(url, {
    "sec-websocket-protocol": `openclaw-extension-relay, openclaw-extension-token.${token}`,
    ...headers,
  });
}

function v2Req(url = "/browser/extension"): IncomingMessage {
  return req(url, { "sec-websocket-protocol": "openclaw-extension-relay.v2" });
}

function stateWithExtensionProfile() {
  return {
    profiles: new Map([
      ["chrome", { profile: { name: "chrome", driver: "extension", cdpPort: 18799 } }],
    ]),
    extensionRelays: new Map(),
    resolved: {
      extensionRelayToken: TOKEN,
      profiles: { chrome: { driver: "extension" } },
    },
  };
}

beforeEach(() => {
  configState.allowLegacyAuth = true;
  readExtensionRelayTokenMock.mockReturnValue(TOKEN);
});

afterEach(() => {
  disposeGatewayExtensionRelay();
  invalidateBrowserRelayAuthV2Authority();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function oversizedMaskedTextFrame(): Buffer {
  const payload = Buffer.alloc(18 * 1024, 0x20);
  const header = Buffer.alloc(8);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(payload.length, 2);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  mask.copy(header, 4);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, payload]);
}

// Default: the requested profile resolves to a valid extension profile.
function primeProfile() {
  resolveProfileMock.mockReturnValue({ name: "chrome", driver: "extension", cdpPort: 18799 });
}

async function mockSuccessfulUpgrade() {
  const wsMod = await import("ws");
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  });
  vi.spyOn(wsMod.WebSocketServer.prototype, "handleUpgrade").mockImplementation(
    (_req, _socket, _head, cb) => {
      (cb as (socket: unknown) => void)(ws);
    },
  );
  return ws;
}

describe("handleGatewayExtensionUpgrade", () => {
  it("ignores non-relay paths", async () => {
    const { socket } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(req("/other"), socket, Buffer.alloc(0));
    expect(handled).toBe(false);
    expect(getBrowserControlStateMock).not.toHaveBeenCalled();
  });

  it("503s when authenticated lazy startup cannot enable browser control", async () => {
    getBrowserControlStateMock.mockReturnValue(null);
    startBrowserControlServiceFromConfigMock.mockResolvedValue(null);
    const { socket, writes, isDestroyed } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension"),
      socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(writes.join("")).toContain("503");
    expect(isDestroyed()).toBe(true);
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
  });

  it("403s a non-extension origin", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    const { socket, writes } = fakeSocket();
    await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension", TOKEN, { origin: "https://evil.example" }),
      socket,
      Buffer.alloc(0),
    );
    expect(writes.join("")).toContain("403");
  });

  it("401s a missing, wrong, or length-mismatched token", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    const missing = fakeSocket();
    await handleGatewayExtensionUpgrade(req("/browser/extension"), missing.socket, Buffer.alloc(0));
    expect(missing.writes.join("")).toContain("401");

    const wrong = fakeSocket();
    await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension", "b".repeat(64)),
      wrong.socket,
      Buffer.alloc(0),
    );
    expect(wrong.writes.join("")).toContain("401");

    const short = fakeSocket();
    await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension", "short"),
      short.socket,
      Buffer.alloc(0),
    );
    expect(short.writes.join("")).toContain("401");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
  });

  it("rejects relay secrets in the public request URL", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    const { socket, writes } = fakeSocket();
    await handleGatewayExtensionUpgrade(
      req("/browser/extension?token=" + TOKEN),
      socket,
      Buffer.alloc(0),
    );
    expect(writes.join("")).toContain("400");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
  });

  it("authenticates before lazy-starting browser control on a fresh gateway", async () => {
    const state = stateWithExtensionProfile();
    getBrowserControlStateMock.mockReturnValue(null);
    startBrowserControlServiceFromConfigMock.mockResolvedValue(state);
    primeProfile();
    const bridge = { id: "fresh-bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    const ws = await mockSuccessfulUpgrade();

    const { socket } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension"),
      socket,
      Buffer.alloc(0),
    );

    expect(handled).toBe(true);
    expect(readExtensionRelayTokenMock).toHaveBeenCalled();
    expect(() => ws.emit("error", new Error("Invalid WebSocket frame"))).not.toThrow();
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
    await expect
      .poll(() => attachExtensionWebSocketMock.mock.calls)
      .toContainEqual([bridge, expect.objectContaining({ readyState: 1 })]);
  });

  it("does not lazy-start or attach v2 before the in-band client proof succeeds", async () => {
    getBrowserControlStateMock.mockReturnValue(null);
    startBrowserControlServiceFromConfigMock.mockResolvedValue(stateWithExtensionProfile());
    primeProfile();
    const bridge = { id: "v2-bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    await mockSuccessfulUpgrade();

    const handled = await handleGatewayExtensionUpgrade(
      v2Req(),
      fakeSocket().socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(authenticateExtensionWebSocketMock).toHaveBeenCalledOnce();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
    expect(attachExtensionWebSocketMock).not.toHaveBeenCalled();

    const authParams = authenticateExtensionWebSocketMock.mock.calls[0]?.[0] as {
      prepareAuthenticated: () => Promise<() => void>;
      resource: string;
    };
    expect(authParams.resource).toBe("/browser/extension");
    const attach = await authParams.prepareAuthenticated();
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
    expect(ensureExtensionRelayForProfileMock).toHaveBeenCalledOnce();
    expect(attachExtensionWebSocketMock).not.toHaveBeenCalled();
    attach();
    await expect
      .poll(() => attachExtensionWebSocketMock.mock.calls)
      .toContainEqual([bridge, expect.objectContaining({ readyState: 1 })]);
  });

  it("rejects oversized direct-Gateway upgrade-head data before ws auth or lazy startup", async () => {
    const { socket, writes, isDestroyed } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      v2Req(),
      socket,
      oversizedMaskedTextFrame(),
    );

    const response = writes.join("");
    expect(handled).toBe(true);
    expect(response.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
    expect(isDestroyed()).toBe(true);
    expect(response.includes("auth.challenge")).toBe(false);
    expect(response.includes("auth.ok")).toBe(false);
    expect(authenticateExtensionWebSocketMock.mock.calls.length).toBe(0);
    expect(startBrowserControlServiceFromConfigMock.mock.calls.length).toBe(0);
    expect(ensureExtensionRelayForProfileMock.mock.calls.length).toBe(0);
    expect(attachExtensionWebSocketMock.mock.calls.length).toBe(0);
  });

  it("binds v2 to the exact profile resource and refuses mixed-protocol downgrade", async () => {
    await mockSuccessfulUpgrade();
    const valid = fakeSocket();
    await handleGatewayExtensionUpgrade(
      v2Req("/browser/extension?profile=chrome"),
      valid.socket,
      Buffer.alloc(0),
    );
    expect(authenticateExtensionWebSocketMock.mock.calls[0]?.[0]).toMatchObject({
      resource: "/browser/extension?profile=chrome",
    });

    const duplicate = fakeSocket();
    await handleGatewayExtensionUpgrade(
      v2Req("/browser/extension?profile=chrome&profile=other"),
      duplicate.socket,
      Buffer.alloc(0),
    );
    expect(duplicate.writes.join("")).toContain("400");

    const mixed = fakeSocket();
    await handleGatewayExtensionUpgrade(
      req("/browser/extension", {
        "sec-websocket-protocol": `openclaw-extension-relay.v2, openclaw-extension-relay, openclaw-extension-token.${TOKEN}`,
      }),
      mixed.socket,
      Buffer.alloc(0),
    );
    expect(mixed.writes.join("")).toContain("400");
  });

  it("accepts legacy only while the explicit migration gate is enabled", async () => {
    configState.allowLegacyAuth = false;
    const denied = fakeSocket();
    await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension"),
      denied.socket,
      Buffer.alloc(0),
    );
    expect(denied.writes.join("")).toContain("401");
    expect(getBrowserControlStateMock).not.toHaveBeenCalled();
  });

  it("attaches the socket to the bridge on a valid token", async () => {
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    const bridge = { id: "bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    // Real handleUpgrade would need a live socket; stub it to fire the callback.
    await mockSuccessfulUpgrade();
    const { socket } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension"),
      socket,
      Buffer.alloc(0),
    );
    expect(handled).toBe(true);
    expect(ensureExtensionRelayForProfileMock).toHaveBeenCalledOnce();
    await expect
      .poll(() => attachExtensionWebSocketMock.mock.calls)
      .toContainEqual([bridge, expect.objectContaining({ readyState: 1 })]);
  });

  it("authenticates against the live relay secret when Browser state is stale", async () => {
    readExtensionRelayTokenMock.mockReturnValue(ROTATED_TOKEN);
    getBrowserControlStateMock.mockReturnValue(stateWithExtensionProfile());
    primeProfile();
    const bridge = { id: "rotated-bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    await mockSuccessfulUpgrade();

    const stale = fakeSocket();
    await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension", TOKEN),
      stale.socket,
      Buffer.alloc(0),
    );
    expect(stale.writes.join("")).toContain("401");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();

    const rotated = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension", ROTATED_TOKEN),
      rotated.socket,
      Buffer.alloc(0),
    );

    expect(handled).toBe(true);
    expect(ensureExtensionRelayForProfileMock).toHaveBeenCalledOnce();
    await expect
      .poll(() => attachExtensionWebSocketMock.mock.calls)
      .toContainEqual([bridge, expect.objectContaining({ readyState: 1 })]);
  });
});
