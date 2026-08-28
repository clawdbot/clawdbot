import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  DESKTOP_OBSERVE_PATH,
  handleDesktopObserveUpgrade,
  mintDesktopObserverToken,
} from "./observe-bridge.js";
import type { RfbPreauthDescriptor } from "./rfb-preauth.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe("worker desktop observer tokens", () => {
  it("mints opaque tokens that expire after 60 seconds", () => {
    const minted = mintDesktopObserverToken({
      sourceKey: "worker:one",
      ownerEpoch: 3,
      control: true,
      attachment: { kind: "unix-socket", socketPath: "/tmp/desktop.sock" },
      nowMs: 1_000,
    });
    expect(minted.token).toMatch(/^[a-f0-9]{48}$/u);
    expect(minted.expiresAtMs).toBe(61_000);
  });
});

async function createProxyHarness(
  params: {
    control?: boolean;
    getBufferedAmount?: () => number;
    preauth?: RfbPreauthDescriptor;
  } = {},
) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "desktop-observe-"));
  const localSocketPath = path.join(root, "desktop.sock");
  let desktopPeer: net.Socket | undefined;
  const peerConnected = new Promise<net.Socket>((resolve) => {
    const server = net.createServer((socket) => {
      desktopPeer = socket;
      resolve(socket);
    });
    server.listen(localSocketPath);
    cleanup.push(
      async () =>
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    );
  });
  const release = vi.fn();
  const closeObserver = vi.fn();
  const httpServer = http.createServer();
  httpServer.on("upgrade", (req, socket, head) => {
    handleDesktopObserveUpgrade(req, socket, head, {
      registry: {
        claimStream: () => undefined,
        attachObserver: (_environmentId, observer) => {
          closeObserver.mockImplementation((code: number, reason: string) => {
            observer.close(code, reason);
          });
          return { release };
        },
      },
      ...(params.getBufferedAmount ? { getBufferedAmount: () => params.getBufferedAmount!() } : {}),
    });
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }
  cleanup.push(async () => {
    desktopPeer?.destroy();
    await new Promise<void>((resolveClose) => {
      httpServer.close(() => resolveClose());
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  const minted = mintDesktopObserverToken({
    sourceKey: "worker:pump",
    ownerEpoch: 2,
    control: params.control ?? false,
    attachment: { kind: "unix-socket", socketPath: localSocketPath },
    ...(params.preauth ? { preauth: params.preauth } : {}),
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}${DESKTOP_OBSERVE_PATH}?token=${minted.token}`,
  );
  cleanup.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { closeObserver, desktopPeer: await peerConnected, observerUrl: ws.url, release, ws };
}

function readSocketBytes(socket: net.Socket, byteLength: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= byteLength) {
        socket.off("data", onData);
        resolve(Buffer.concat(chunks));
      }
    };
    socket.on("data", onData);
  });
}

async function expectUnauthorizedObserver(url: string): Promise<void> {
  const ws = new WebSocket(url);
  cleanup.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => reject(new Error("observer token was unexpectedly accepted")));
    ws.once("unexpected-response", (_request, response) => {
      expect(response.statusCode).toBe(401);
      response.resume();
      resolve();
    });
    ws.once("error", () => undefined);
  });
}

describe("worker desktop observer proxy", () => {
  it("clears the credential-bearing token timer when the token is consumed", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    await createProxyHarness({
      preauth: {
        auth: "ard-account",
        credentials: { username: "operator", password: "memory-only-password" },
      },
    });
    const expiryCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 60_000);
    expect(expiryCallIndex).toBeGreaterThanOrEqual(0);
    const expiryTimer = setTimeoutSpy.mock.results[expiryCallIndex]?.value;
    expect(clearTimeoutSpy).toHaveBeenCalledWith(expiryTimer);
  });

  it("rejects consumed, expired, and unknown tokens", async () => {
    const harness = await createProxyHarness();
    await expectUnauthorizedObserver(harness.observerUrl);

    const expired = mintDesktopObserverToken({
      sourceKey: "worker:expired",
      ownerEpoch: 1,
      control: false,
      attachment: { kind: "unix-socket", socketPath: "/tmp/expired.sock" },
      nowMs: 0,
    });
    const observerUrl = new URL(harness.observerUrl);
    observerUrl.searchParams.set("token", expired.token);
    await expectUnauthorizedObserver(observerUrl.toString());
    observerUrl.searchParams.set("token", "0".repeat(48));
    await expectUnauthorizedObserver(observerUrl.toString());
  });

  it("drops view-only input while forwarding framebuffer requests", async () => {
    const harness = await createProxyHarness();
    const fromDesktop = new Promise<Buffer>((resolve) => {
      harness.ws.once("message", (data) => resolve(Buffer.from(data as Buffer)));
    });
    harness.desktopPeer.write(Buffer.from("RFB 003.008\n"));
    await expect(fromDesktop).resolves.toEqual(Buffer.from("RFB 003.008\n"));

    const handshake = Buffer.concat([Buffer.from("RFB 003.008\n", "ascii"), Buffer.from([1, 1])]);
    const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
    const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
    const fromWebSocket = readSocketBytes(
      harness.desktopPeer,
      handshake.length + framebufferRequest.length,
    );
    harness.ws.send(Buffer.concat([handshake, keyEvent, framebufferRequest]));
    await expect(fromWebSocket).resolves.toEqual(Buffer.concat([handshake, framebufferRequest]));

    const closed = new Promise<void>((resolve) => {
      harness.ws.once("close", () => resolve());
    });
    harness.desktopPeer.destroy();
    await closed;
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("keeps controlling observers on the plain pass-through path", async () => {
    const harness = await createProxyHarness({ control: true });
    const bytes = Buffer.concat([Buffer.from("RFB 003.008\n", "ascii"), Buffer.from([1, 0])]);
    const fromWebSocket = readSocketBytes(harness.desktopPeer, bytes.length);
    harness.ws.send(bytes);
    await expect(fromWebSocket).resolves.toEqual(bytes);
  });

  it("closes malformed view-only streams with a policy violation", async () => {
    const harness = await createProxyHarness();
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      harness.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    harness.ws.send(
      Buffer.concat([Buffer.from("RFB 003.008\n", "ascii"), Buffer.from([1, 1, 254])]),
    );
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "invalid view-only RFB stream",
    });
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("propagates websocket close to the unix socket", async () => {
    const harness = await createProxyHarness();
    const closed = new Promise<void>((resolve) => {
      harness.desktopPeer.once("close", resolve);
    });
    harness.ws.close();
    await closed;
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("pauses and resumes unix-socket reads around websocket backpressure", async () => {
    let bufferedAmount = 5 * 1024 * 1024;
    const pause = vi.spyOn(net.Socket.prototype, "pause");
    const resume = vi.spyOn(net.Socket.prototype, "resume");
    const harness = await createProxyHarness({ getBufferedAmount: () => bufferedAmount });
    pause.mockClear();
    resume.mockClear();
    harness.desktopPeer.write(Buffer.from("RFB"));
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
    bufferedAmount = 0;
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
  });
});
