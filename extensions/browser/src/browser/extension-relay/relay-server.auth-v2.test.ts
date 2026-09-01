import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  type BrowserRelayAuthChallenge,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  BrowserRelayAuthV2Authority,
  getBrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
  parseRelayAuthHello,
  parseStrictJsonObject,
} from "./auth-v2.js";
import { RawHttpConnection } from "./relay-http.test-support.js";
import {
  authenticateExtensionWebSocket,
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from "./relay-server.js";

const KEY = "0123456789abcdef".repeat(4);
const SOURCE = "127.0.0.1";

async function authenticate(
  connection: RawHttpConnection,
  flow: "cdp" | "json-list",
  clientNonce = randomRelayNonce(),
): Promise<BrowserRelayAuthChallenge> {
  const binding =
    flow === "cdp"
      ? { method: "SEQUENCE", resource: "/json/version -> /cdp" }
      : { method: "GET", resource: "/json/list" };
  const challengeResponse = await connection.request(
    "POST",
    BROWSER_RELAY_AUTH_CHALLENGE_PATH,
    JSON.stringify({
      v: 2,
      keyId: relayKeyIdFromHex(KEY),
      clientNonce,
      role: "cdp",
      transport: "connection",
      ...binding,
      flow,
    }),
    { "Content-Type": "application/json" },
  );
  expect(challengeResponse.status).toBe(200);
  const challenge = JSON.parse(challengeResponse.body) as BrowserRelayAuthChallenge;
  const completeResponse = await connection.request(
    "POST",
    BROWSER_RELAY_AUTH_COMPLETE_PATH,
    JSON.stringify({
      v: 2,
      sessionId: challenge.sessionId,
      clientProof: createRelayProof(KEY, "client", challenge),
    }),
    { "Content-Type": "application/json" },
  );
  expect(completeResponse.status).toBe(200);
  expect(JSON.parse(completeResponse.body)).toMatchObject({
    type: "auth.ok",
    v: 2,
    sessionId: challenge.sessionId,
  });
  return challenge;
}

function attachTestExtension(handle: ExtensionRelayHandle): void {
  const handlers = handle.bridge.attachExtensionSocket({ send: () => {}, close: () => {} });
  handlers.onMessage(
    JSON.stringify({
      type: "hello",
      userAgent: "test",
      browserVersion: "Chrome/test",
      extensionVersion: "2",
      tabs: [],
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

async function openExtensionSocket(
  handle: ExtensionRelayHandle,
  protocols: string | string[],
  localAddress?: string,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/extension`, protocols, {
    localAddress,
    origin: "chrome-extension://relay-auth-v2-test",
  });
  ws.on("error", () => {});
  await once(ws, "open");
  return ws;
}

async function authenticateV2Extension(
  handle: ExtensionRelayHandle,
  localAddress?: string,
): Promise<WebSocket> {
  const ws = await openExtensionSocket(handle, BROWSER_RELAY_EXTENSION_SUBPROTOCOL, localAddress);
  const challengeMessage = once(ws, "message");
  ws.send(
    JSON.stringify({
      type: "auth.hello",
      v: 2,
      keyId: relayKeyIdFromHex(KEY),
      clientNonce: randomRelayNonce(),
    }),
  );
  const [challengeData] = (await challengeMessage) as [RawData];
  const challenge = JSON.parse(rawDataText(challengeData)) as BrowserRelayAuthChallenge;
  const okMessage = once(ws, "message");
  ws.send(
    JSON.stringify({
      type: "auth.response",
      v: 2,
      sessionId: challenge.sessionId,
      clientProof: createRelayProof(KEY, "client", challenge),
    }),
  );
  const [okData] = (await okMessage) as [RawData];
  expect(JSON.parse(rawDataText(okData))).toMatchObject({
    type: "auth.ok",
    v: 2,
    sessionId: challenge.sessionId,
  });
  return ws;
}

function createWebSocketAuthHarness(
  options: {
    prepareAuthenticated?: () => Promise<() => void>;
    removePreAuthGuard?: () => void;
  } = {},
) {
  const close = vi.fn();
  const send = vi.fn();
  const socket = Object.assign(new EventEmitter(), {
    close,
    readyState: 1,
    send,
    terminate: vi.fn(),
  }) as unknown as WebSocket;
  const authority = new BrowserRelayAuthV2Authority(KEY);
  const issueChallenge = vi.spyOn(authority, "issueChallenge");
  const prepareAuthenticated = vi.fn(options.prepareAuthenticated ?? (async () => vi.fn()));
  authenticateExtensionWebSocket({
    ws: socket,
    authority,
    source: SOURCE,
    resource: "/extension",
    prepareAuthenticated,
    removePreAuthGuard: options.removePreAuthGuard,
  });
  return { authority, close, issueChallenge, prepareAuthenticated, send, socket };
}

function maskedFrame(payload: Buffer, options: { fin: boolean; opcode: number }): Buffer {
  const lengthBytes = payload.length < 126 ? 0 : 2;
  const header = Buffer.alloc(2 + lengthBytes + 4);
  header[0] = (options.fin ? 0x80 : 0) | options.opcode;
  header[1] = 0x80 | (lengthBytes === 0 ? payload.length : 126);
  if (lengthBytes === 2) {
    header.writeUInt16BE(payload.length, 2);
  }
  const maskOffset = 2 + lengthBytes;
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  mask.copy(header, maskOffset);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, masked]);
}

async function sendRawV2Frames(params: {
  port: number;
  subsequentFrames?: Buffer[];
}): Promise<string> {
  const socket = net.createConnection({ host: "127.0.0.1", port: params.port });
  socket.on("error", () => {});
  await once(socket, "connect");
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
  const closed = once(socket, "close");
  const request = Buffer.from(
    [
      "GET /extension HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      `Sec-WebSocket-Protocol: ${BROWSER_RELAY_EXTENSION_SUBPROTOCOL}`,
      "Origin: chrome-extension://relay-auth-v2-test",
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(request);
  if (params.subsequentFrames?.length) {
    await vi.waitFor(() => {
      expect(Buffer.concat(received).toString("utf8").includes("101 Switching Protocols")).toBe(
        true,
      );
    });
    socket.write(Buffer.concat(params.subsequentFrames));
  }
  await closed;
  return Buffer.concat(received).toString("utf8");
}

describe("extension relay WebSocket auth v2 frame boundary", () => {
  it.each([
    ["Buffer", Buffer.alloc(16 * 1024 + 1, 0x20)],
    ["ArrayBuffer", new Uint8Array(16 * 1024 + 1).buffer],
    ["Buffer[]", [Buffer.alloc(8 * 1024), Buffer.alloc(8 * 1024 + 1)]],
  ] satisfies Array<[string, RawData]>)(
    "rejects an oversized text auth frame backed by %s before issuing a challenge",
    (_kind, data) => {
      const harness = createWebSocketAuthHarness();

      harness.socket.emit("message", data, false);

      expect(harness.close).toHaveBeenCalledWith(4003, "browser relay auth frame is too large");
      expect(harness.issueChallenge).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.prepareAuthenticated).not.toHaveBeenCalled();
      harness.socket.emit("close");
    },
  );

  it("rejects a binary auth frame without issuing a challenge or promoting the bridge", () => {
    const harness = createWebSocketAuthHarness();

    harness.socket.emit("message", Buffer.from("{}"), true);

    expect(harness.close).toHaveBeenCalledWith(
      4003,
      "binary browser relay auth frames are not allowed",
    );
    expect(harness.issueChallenge).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.prepareAuthenticated).not.toHaveBeenCalled();
    harness.socket.emit("close");
  });

  it("releases a timed-out pending socket without disturbing active capacity", async () => {
    vi.useFakeTimers();
    try {
      const removePreAuthGuard = vi.fn();
      const harness = createWebSocketAuthHarness({ removePreAuthGuard });
      const activeInvalidated = vi.fn();
      expect(harness.authority.registerAuthenticatedConnection({}, activeInvalidated)).toBe(true);
      for (let index = 0; index < 127; index += 1) {
        expect(harness.authority.registerPendingConnection({}, vi.fn(), `192.0.2.${index}`)).toBe(
          true,
        );
      }
      expect(harness.authority.registerPendingConnection({}, vi.fn(), SOURCE)).toBe(false);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.close).toHaveBeenCalledWith(4008, "browser relay auth timeout");
      expect(removePreAuthGuard).not.toHaveBeenCalled();
      harness.socket.emit("close");
      expect(removePreAuthGuard).toHaveBeenCalledOnce();
      expect(harness.authority.registerPendingConnection({}, vi.fn(), SOURCE)).toBe(true);
      expect(activeInvalidated).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends the proof deadline at promotion while authenticated preparation remains pending", async () => {
    vi.useFakeTimers();
    try {
      let finishPreparation = (_attach: () => void) => {};
      const attach = vi.fn();
      const preparation = new Promise<() => void>((resolve) => {
        finishPreparation = resolve;
      });
      const removePreAuthGuard = vi.fn();
      const harness = createWebSocketAuthHarness({
        prepareAuthenticated: async () => await preparation,
        removePreAuthGuard,
      });
      const clientNonce = randomRelayNonce();
      harness.socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "auth.hello",
            v: 2,
            keyId: relayKeyIdFromHex(KEY),
            clientNonce,
          }),
        ),
        false,
      );
      const challenge = JSON.parse(harness.send.mock.calls[0]?.[0]) as BrowserRelayAuthChallenge;
      harness.socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "auth.response",
            v: 2,
            sessionId: challenge.sessionId,
            clientProof: createRelayProof(KEY, "client", challenge),
          }),
        ),
        false,
      );
      expect(removePreAuthGuard).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(BROWSER_RELAY_CHALLENGE_TTL_MS + 1);
      expect(harness.close).not.toHaveBeenCalled();
      expect(harness.socket.readyState).toBe(WebSocket.OPEN);

      finishPreparation(attach);
      await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());
      expect(harness.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "auth.ok")).toBe(
        true,
      );
      expect(harness.close).not.toHaveBeenCalled();
      harness.socket.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.sequential("extension relay HTTP auth v2", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  let handle: ExtensionRelayHandle | null = null;

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-auth-v2-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      `${KEY}\n`,
      {
        mode: 0o600,
      },
    );
    invalidateBrowserRelayAuthV2Authority();
  });

  afterEach(async () => {
    await handle?.close();
    handle = null;
    invalidateBrowserRelayAuthV2Authority();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("keeps the same-socket CDP upgrade active and rotation-bound", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    attachTestExtension(handle);
    const connection = await RawHttpConnection.connect(handle.port);
    await authenticate(connection, "cdp");
    const version = await connection.request("GET", "/json/version");
    expect(version.status).toBe(200);
    expect(JSON.parse(version.body).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${handle.port}/cdp`);
    const upgraded = await connection.upgrade("/cdp");
    expect(upgraded.status).toBe(101);
    expect(handle.bridge.cdpClientCount).toBe(1);
    const closed = once(connection.socket, "close");
    getBrowserRelayAuthV2Authority("f".repeat(64));
    await closed;
    await vi.waitFor(() => expect(handle?.bridge.cdpClientCount).toBe(0));
    connection.close();
  });

  it("closes malformed WebSocket framing before authentication without an unowned error", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    const issueChallenge = vi.spyOn(getBrowserRelayAuthV2Authority(KEY), "issueChallenge");
    // Client frames must be masked. This fails inside ws, before the auth parser.
    const response = await sendRawV2Frames({
      port: handle.port,
      subsequentFrames: [Buffer.from([0x81, 0x00])],
    });
    expect(response).toContain("101 Switching Protocols");
    expect(response).not.toContain("auth.challenge");
    expect(issueChallenge).not.toHaveBeenCalled();
    expect(handle.bridge.extensionConnected).toBe(false);
  });

  it.each([
    {
      name: "an oversized first auth message",
      payloadBytes: 18 * 1024,
      fragmentBytes: 18 * 1024,
      wireBytes: 18_440,
    },
    {
      name: "fragmented masked pre-auth wire overhead",
      payloadBytes: 16 * 1024,
      fragmentBytes: 91,
      wireBytes: 17_470,
    },
  ])(
    "rejects $name before challenge or bridge promotion",
    async ({ payloadBytes, fragmentBytes, wireBytes }) => {
      handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
      const authority = getBrowserRelayAuthV2Authority(KEY);
      const issueChallenge = vi.spyOn(authority, "issueChallenge");
      const payload = Buffer.from(
        JSON.stringify({
          type: "auth.hello",
          v: 2,
          keyId: relayKeyIdFromHex(KEY),
          clientNonce: randomRelayNonce(),
        }).padEnd(payloadBytes, " "),
      );
      // Valid JSON padding leaves the wire limit as the fragmented case's rejection owner.
      expect(payload.byteLength).toBe(payloadBytes);
      expect(parseRelayAuthHello(parseStrictJsonObject(payload.toString("utf8"))) !== null).toBe(
        true,
      );
      const fragments: Buffer[] = [];
      for (let offset = 0; offset < payload.length; offset += fragmentBytes) {
        const end = Math.min(offset + fragmentBytes, payload.length);
        fragments.push(
          maskedFrame(payload.subarray(offset, end), {
            fin: end === payload.length,
            opcode: offset === 0 ? 0x1 : 0x0,
          }),
        );
      }
      expect(Buffer.concat(fragments).byteLength).toBe(wireBytes);
      const response = await sendRawV2Frames({ port: handle.port, subsequentFrames: fragments });

      expect(response.includes("auth.challenge")).toBe(false);
      expect(response.includes("auth.ok")).toBe(false);
      expect(issueChallenge.mock.calls.length).toBe(0);
      expect(handle.bridge.extensionConnected).toBe(false);
    },
  );

  it("keeps the 64 MiB application receiver after v2 authentication", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    const socket = await authenticateV2Extension(handle);
    socket.send(
      JSON.stringify({
        type: "hello",
        userAgent: "test",
        browserVersion: "Chrome/test",
        extensionVersion: "2",
        tabs: [
          {
            tabId: 1,
            url: `https://example.test/${"a".repeat(16_000)}`,
            title: "one",
            active: true,
          },
          {
            tabId: 2,
            url: `https://example.test/${"b".repeat(16_000)}`,
            title: "two",
            active: false,
          },
        ],
      }),
    );

    await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("retires an authenticated silent extension and immediately fails its pending CDP request", async () => {
    const onStateChange = vi.fn();
    handle = await startExtensionRelayServer({
      port: 0,
      token: KEY,
      allowLegacyAuth: false,
      onStateChange,
    });
    const extension = await authenticateV2Extension(handle);
    let client: WebSocket | undefined;
    let versionConnection: RawHttpConnection | undefined;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      extension.send(
        JSON.stringify({
          type: "hello",
          userAgent: "test",
          browserVersion: "Chrome/test",
          extensionVersion: "2",
          tabs: [{ tabId: 1, url: "https://example.test", title: "one", active: true }],
        }),
      );
      await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));

      const credential = Buffer.from(`openclaw-internal:${handle.internalToken}`).toString(
        "base64",
      );
      client = new WebSocket(`ws://127.0.0.1:${handle.port}/cdp`, {
        headers: { Authorization: `Basic ${credential}` },
      });
      client.on("error", () => {});
      await once(client, "open");
      const clientFrames: Array<Record<string, unknown>> = [];
      client.on("message", (raw: RawData) => {
        clientFrames.push(JSON.parse(rawDataText(raw)) as Record<string, unknown>);
      });

      const attachment = once(extension, "message");
      client.send(
        JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true } }),
      );
      const [attachmentData] = (await attachment) as [RawData];
      const attachCommand = JSON.parse(rawDataText(attachmentData)) as {
        type: string;
        seq: number;
      };
      expect(attachCommand.type).toBe("attach");
      extension.send(
        JSON.stringify({
          type: "result",
          seq: attachCommand.seq,
          result: { targetId: "target-1" },
        }),
      );
      await vi.waitFor(() =>
        expect(clientFrames.some((frame) => frame.method === "Target.attachedToTarget")).toBe(true),
      );
      const attached = clientFrames.find((frame) => frame.method === "Target.attachedToTarget");
      const sessionId = (attached?.params as { sessionId?: string } | undefined)?.sessionId;
      expect(typeof sessionId).toBe("string");

      for (let index = 0; index < 2; index += 1) {
        const ping = once(extension, "message");
        await vi.advanceTimersByTimeAsync(20_000);
        const [pingData] = (await ping) as [RawData];
        expect(JSON.parse(rawDataText(pingData))).toEqual({ type: "ping" });
      }
      expect(extension.readyState).toBe(WebSocket.OPEN);

      const pending = once(extension, "message");
      client.send(JSON.stringify({ id: 2, sessionId, method: "Page.getFrameTree" }));
      const [pendingData] = (await pending) as [RawData];
      expect(JSON.parse(rawDataText(pendingData))).toMatchObject({
        type: "cdp",
        method: "Page.getFrameTree",
      });

      versionConnection = await RawHttpConnection.connect(handle.port);
      expect(
        (
          await versionConnection.request("GET", "/json/version", "", {
            Authorization: `Basic ${credential}`,
          })
        ).status,
      ).toBe(200);

      const closed = once(extension, "close");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(handle.bridge.extensionConnected).toBe(false);
      await vi.waitFor(() =>
        expect(clientFrames.find((frame) => frame.id === 2)).toMatchObject({
          error: { message: "extension disconnected" },
        }),
      );
      const [code, reason] = (await closed) as [number, Buffer];
      expect(code).toBe(4000);
      expect(reason.toString()).toBe("extension heartbeat timeout");
      expect(onStateChange).toHaveBeenCalledTimes(2);

      expect(
        (
          await versionConnection.request("GET", "/json/version", "", {
            Authorization: `Basic ${credential}`,
          })
        ).status,
      ).toBe(503);
    } finally {
      versionConnection?.close();
      client?.terminate();
      extension.terminate();
      await handle?.close();
      handle = null;
      vi.useRealTimers();
    }
  });

  it("keeps an authenticated extension connected while its real socket answers heartbeat pings", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    const extension = await authenticateV2Extension(handle);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      extension.send(
        JSON.stringify({
          type: "hello",
          userAgent: "test",
          browserVersion: "Chrome/test",
          extensionVersion: "2",
          tabs: [{ tabId: 1, url: "https://example.test", title: "initial", active: true }],
        }),
      );
      await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));

      for (let index = 0; index < 4; index += 1) {
        const ping = once(extension, "message");
        await vi.advanceTimersByTimeAsync(20_000);
        const [pingData] = (await ping) as [RawData];
        expect(JSON.parse(rawDataText(pingData))).toEqual({ type: "ping" });
        extension.send(JSON.stringify({ type: "pong" }));
        extension.send(
          JSON.stringify({
            type: "tabs",
            tabs: [{ tabId: 1, url: "https://example.test", title: `beat-${index}`, active: true }],
          }),
        );
        await vi.waitFor(() =>
          expect(handle?.bridge.accessibleTabs()[0]?.title).toBe(`beat-${index}`),
        );
      }

      expect(extension.readyState).toBe(WebSocket.OPEN);
      expect(handle.bridge.extensionConnected).toBe(true);
    } finally {
      extension.terminate();
      await handle?.close();
      handle = null;
      vi.useRealTimers();
    }
  });

  it("collapses loopback aliases into one relay authentication source", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: true });
    const active = await openExtensionSocket(handle, [
      "openclaw-extension-relay",
      `openclaw-extension-token.${KEY}`,
    ]);
    active.send(
      JSON.stringify({
        type: "hello",
        userAgent: "test",
        browserVersion: "Chrome/test",
        extensionVersion: "2",
        tabs: [],
      }),
    );
    await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));

    const attacker = await Promise.all(
      Array.from({ length: 32 }, () =>
        openExtensionSocket(handle!, BROWSER_RELAY_EXTENSION_SUBPROTOCOL, "127.0.0.2"),
      ),
    );
    expect(active.readyState).toBe(WebSocket.OPEN);
    expect(handle.bridge.extensionConnected).toBe(true);

    const overflow = new WebSocket(
      `ws://127.0.0.1:${handle.port}/extension`,
      BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
      { localAddress: "127.0.0.3", origin: "chrome-extension://relay-auth-v2-test" },
    );
    overflow.on("error", () => {});
    const overflowClosed = once(overflow, "close");
    await once(overflow, "open");
    const [overflowCode] = (await overflowClosed) as [number, Buffer];
    expect(overflowCode).toBe(4013);
    expect(active.readyState).toBe(WebSocket.OPEN);
    expect(handle.bridge.extensionConnected).toBe(true);

    const released = once(attacker[0]!, "close");
    attacker[0]!.close();
    await released;
    const promoted = await authenticateV2Extension(handle, "127.0.0.3");
    promoted.send(
      JSON.stringify({
        type: "hello",
        userAgent: "test-v2",
        browserVersion: "Chrome/test-v2",
        extensionVersion: "2",
        tabs: [],
      }),
    );
    await vi.waitFor(() => expect(handle?.bridge.extensionConnected).toBe(true));

    promoted.close();
    active.close();
    for (const socket of attacker.slice(1)) {
      socket.close();
    }
  }, 30_000);

  it("rejects completion on another socket without consuming the original challenge", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY });
    const original = await RawHttpConnection.connect(handle.port);
    const other = await RawHttpConnection.connect(handle.port);
    const challengeResponse = await original.request(
      "POST",
      BROWSER_RELAY_AUTH_CHALLENGE_PATH,
      JSON.stringify({
        v: 2,
        keyId: relayKeyIdFromHex(KEY),
        clientNonce: randomRelayNonce(),
        role: "cdp",
        transport: "connection",
        method: "GET",
        resource: "/json/list",
        flow: "json-list",
      }),
    );
    const challenge = JSON.parse(challengeResponse.body) as BrowserRelayAuthChallenge;
    const completion = JSON.stringify({
      v: 2,
      sessionId: challenge.sessionId,
      clientProof: createRelayProof(KEY, "client", challenge),
    });
    expect((await other.request("POST", BROWSER_RELAY_AUTH_COMPLETE_PATH, completion)).status).toBe(
      409,
    );
    expect(
      (await original.request("POST", BROWSER_RELAY_AUTH_COMPLETE_PATH, completion)).status,
    ).toBe(200);
    original.close();
    other.close();
  });

  it("rejects replayed client nonces across sockets", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY });
    const first = await RawHttpConnection.connect(handle.port);
    const second = await RawHttpConnection.connect(handle.port);
    const nonce = randomRelayNonce();
    const body = JSON.stringify({
      v: 2,
      keyId: relayKeyIdFromHex(KEY),
      clientNonce: nonce,
      role: "cdp",
      transport: "connection",
      method: "GET",
      resource: "/json/list",
      flow: "json-list",
    });
    expect((await first.request("POST", BROWSER_RELAY_AUTH_CHALLENGE_PATH, body)).status).toBe(200);
    expect((await second.request("POST", BROWSER_RELAY_AUTH_CHALLENGE_PATH, body)).status).toBe(
      401,
    );
    first.close();
    second.close();
  });

  it("uses a separate one-GET json-list flow and closes it", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    attachTestExtension(handle);
    const connection = await RawHttpConnection.connect(handle.port);
    await authenticate(connection, "json-list");
    const list = await connection.request("GET", "/json/list");
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual([]);
    expect(list.headers.connection).toBe("close");
    connection.close();
  });

  it("gates K-bearing legacy auth but preserves process-ephemeral internal Basic auth", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY, allowLegacyAuth: false });
    attachTestExtension(handle);
    const bearer = await RawHttpConnection.connect(handle.port);
    expect(
      (await bearer.request("GET", "/json/version", "", { Authorization: `Bearer ${KEY}` })).status,
    ).toBe(401);
    bearer.close();

    const query = await RawHttpConnection.connect(handle.port);
    expect((await query.request("GET", `/json/version?token=${KEY}`)).status).toBe(401);
    query.close();

    const internal = await RawHttpConnection.connect(handle.port);
    const credential = Buffer.from(`openclaw-internal:${handle.internalToken}`).toString("base64");
    expect(
      (await internal.request("GET", "/json/version", "", { Authorization: `Basic ${credential}` }))
        .status,
    ).toBe(200);
    internal.close();
  });

  it("rejects query substitutions and duplicate security fields", async () => {
    handle = await startExtensionRelayServer({ port: 0, token: KEY });
    const query = await RawHttpConnection.connect(handle.port);
    expect(
      (await query.request("POST", `${BROWSER_RELAY_AUTH_CHALLENGE_PATH}?x=1`, JSON.stringify({})))
        .status,
    ).toBe(400);
    query.close();

    const duplicate = await RawHttpConnection.connect(handle.port);
    const nonce = randomRelayNonce();
    const body = `{"v":2,"v":1,"keyId":"${relayKeyIdFromHex(KEY)}","clientNonce":"${nonce}","role":"cdp","transport":"connection","method":"GET","resource":"/json/list","flow":"json-list"}`;
    expect((await duplicate.request("POST", BROWSER_RELAY_AUTH_CHALLENGE_PATH, body)).status).toBe(
      400,
    );
    duplicate.close();
  });
});
