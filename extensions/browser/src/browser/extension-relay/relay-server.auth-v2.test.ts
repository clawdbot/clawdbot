import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  type BrowserRelayAuthChallenge,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
} from "./auth-v2.js";
import {
  authenticateExtensionWebSocket,
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from "./relay-server.js";

const KEY = "0123456789abcdef".repeat(4);

type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

class RawHttpConnection {
  private buffer = Buffer.alloc(0);
  private readonly waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([
        this.buffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      this.waiters.splice(0).forEach((resolve) => resolve());
    });
  }

  static async connect(port: number): Promise<RawHttpConnection> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new RawHttpConnection(socket);
  }

  async request(
    method: string,
    requestPath: string,
    body = "",
    headers: Record<string, string> = {},
  ): Promise<RawResponse> {
    this.socket.write(
      [
        `${method} ${requestPath} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: keep-alive",
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        body,
      ].join("\r\n"),
    );
    return await this.readResponse();
  }

  async upgrade(requestPath: string): Promise<RawResponse> {
    this.socket.write(
      [
        `GET ${requestPath} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
    return await this.readResponse({ headersOnly: true });
  }

  private async waitForData(): Promise<void> {
    if (this.socket.destroyed) {
      throw new Error("socket closed before response completed");
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private async readResponse(options: { headersOnly?: boolean } = {}): Promise<RawResponse> {
    let headerEnd = this.buffer.indexOf("\r\n\r\n");
    while (headerEnd < 0) {
      await this.waitForData();
      headerEnd = this.buffer.indexOf("\r\n\r\n");
    }
    const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
    const [statusLine, ...headerLines] = headerText.split("\r\n");
    const headers = Object.fromEntries(
      headerLines.map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }),
    );
    const contentLength = options.headersOnly ? 0 : Number(headers["content-length"] ?? 0);
    const responseLength = headerEnd + 4 + contentLength;
    while (this.buffer.length < responseLength) {
      await this.waitForData();
    }
    const body = this.buffer.subarray(headerEnd + 4, responseLength).toString("utf8");
    this.buffer = this.buffer.subarray(responseLength);
    return {
      status: Number(/^HTTP\/1\.1 (\d+)/u.exec(statusLine ?? "")?.[1] ?? 0),
      headers,
      body,
    };
  }

  close(): void {
    this.socket.destroy();
  }
}

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

function createWebSocketAuthHarness() {
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
  const prepareAuthenticated = vi.fn(async () => vi.fn());
  authenticateExtensionWebSocket({
    ws: socket,
    authority,
    resource: "/extension",
    prepareAuthenticated,
  });
  return { authority, close, issueChallenge, prepareAuthenticated, send, socket };
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

  it("keeps challenge, complete, version, and CDP upgrade on one socket", async () => {
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
    connection.close();
  });

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
