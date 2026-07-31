// Gateway extension relay upgrade handler: auth + routing decisions.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getBrowserControlStateMock = vi.fn();
const startBrowserControlServiceFromConfigMock = vi.fn();
vi.mock("../../control-service.js", () => ({
  getBrowserControlState: () => getBrowserControlStateMock(),
  startBrowserControlServiceFromConfig: () => startBrowserControlServiceFromConfigMock(),
}));

const ensureExtensionRelayForProfileMock = vi.fn();
vi.mock("./relay-lifecycle.js", () => ({
  ensureExtensionRelayForProfile: (...args: unknown[]) =>
    ensureExtensionRelayForProfileMock(...args),
}));

const resolveProfileMock = vi.fn();
vi.mock("../config.js", () => ({
  resolveProfile: (...args: unknown[]) => resolveProfileMock(...args),
}));

const attachExtensionWebSocketMock = vi.fn();
vi.mock("./relay-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./relay-server.js")>();
  return {
    ...actual,
    attachExtensionWebSocket: (...args: unknown[]) => attachExtensionWebSocketMock(...args),
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

import { handleGatewayExtensionUpgrade } from "./gateway-relay-route.js";

const TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);

function fakeSocket() {
  const writes: string[] = [];
  let destroyed = false;
  const socket = {
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    destroy: () => {
      destroyed = true;
    },
  } as unknown as Duplex;
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

function stateWithExtensionProfile() {
  return {
    resolved: {
      extensionRelayToken: TOKEN,
      profiles: { chrome: { driver: "extension" } },
    },
  };
}

beforeEach(() => {
  readExtensionRelayTokenMock.mockReturnValue(TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// Default: the requested profile resolves to a valid extension profile.
function primeProfile() {
  resolveProfileMock.mockReturnValue({ name: "chrome", driver: "extension" });
}

async function mockSuccessfulUpgrade() {
  const wsMod = await import("ws");
  vi.spyOn(wsMod.WebSocketServer.prototype, "handleUpgrade").mockImplementation(
    (_req, _socket, _head, cb) => {
      (cb as (ws: unknown) => void)({ readyState: 1 });
    },
  );
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
    expect(writes.join("")).toContain("401");
    expect(ensureExtensionRelayForProfileMock).not.toHaveBeenCalled();
  });

  it("authenticates before lazy-starting browser control on a fresh gateway", async () => {
    const state = stateWithExtensionProfile();
    getBrowserControlStateMock.mockReturnValue(null);
    startBrowserControlServiceFromConfigMock.mockResolvedValue(state);
    primeProfile();
    const bridge = { id: "fresh-bridge" };
    ensureExtensionRelayForProfileMock.mockResolvedValue({ bridge });
    await mockSuccessfulUpgrade();

    const { socket } = fakeSocket();
    const handled = await handleGatewayExtensionUpgrade(
      relayReq("/browser/extension"),
      socket,
      Buffer.alloc(0),
    );

    expect(handled).toBe(true);
    expect(readExtensionRelayTokenMock).toHaveBeenCalledOnce();
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
    expect(attachExtensionWebSocketMock).toHaveBeenCalledWith(bridge, { readyState: 1 });
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
    expect(attachExtensionWebSocketMock).toHaveBeenCalledWith(bridge, { readyState: 1 });
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
    expect(attachExtensionWebSocketMock).toHaveBeenCalledWith(bridge, { readyState: 1 });
  });
});
