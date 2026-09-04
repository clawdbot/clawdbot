import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import {
  DESKTOP_OBSERVE_PATH,
  handleDesktopObserveUpgrade,
  mintDesktopObserverToken,
} from "./observe-bridge.js";
import type { RfbPreauthDescriptor } from "./rfb-preauth.js";

const cleanup: Array<() => Promise<void>> = [];
const logPaths = createSuiteLogPathTracker("desktop-observer-diagnostics-");
const logCaptures: ReturnType<typeof createDiagnosticLogRecordCapture>[] = [];

beforeAll(async () => logPaths.setup());
beforeEach(() =>
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logPaths.nextPath() }),
);
afterAll(async () => logPaths.cleanup());

afterEach(async () => {
  try {
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((run) => run()));
    await flushLogger();
    for (const capture of logCaptures) {
      await capture.flush();
    }
  } finally {
    for (const capture of logCaptures.splice(0)) {
      capture.cleanup();
    }
    resetLogger();
    vi.useRealTimers();
  }
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
    getBufferedAmount?: (ws: WebSocket) => number;
    stream?: Duplex;
    preauth?: RfbPreauthDescriptor;
  } = {},
) {
  // macOS sockaddr_un cannot hold the test runner's nested temporary path.
  const root = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oc-desktop-observe-"));
  const localSocketPath = path.join(root, "desktop.sock");
  let desktopPeer: net.Socket | undefined;
  const peerConnected = createDeferred<net.Socket>();
  const server = net.createServer((socket) => {
    desktopPeer = socket;
    peerConnected.resolve(socket);
  });
  cleanup.push(async () => {
    desktopPeer?.destroy();
    params.stream?.destroy();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(localSocketPath, resolve);
  });
  const release = vi.fn();
  const closeObserver = vi.fn();
  const httpServer = http.createServer();
  cleanup.push(
    async () =>
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      }),
  );
  httpServer.on("upgrade", (req, socket, head) => {
    handleDesktopObserveUpgrade(req, socket, head, {
      registry: {
        claimStream: () => params.stream,
        attachObserver: (_environmentId, observer) => {
          closeObserver.mockImplementation((code: number, reason: string) => {
            observer.close(code, reason);
          });
          return { release };
        },
      },
      ...(params.getBufferedAmount ? { getBufferedAmount: params.getBufferedAmount } : {}),
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP test server address");
  }
  const minted = mintDesktopObserverToken({
    sourceKey: "worker:pump",
    ownerEpoch: 2,
    control: params.control ?? false,
    attachment: params.stream
      ? { kind: "stream", streamId: "synthetic-stream" }
      : { kind: "unix-socket", socketPath: localSocketPath },
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
  return {
    closeObserver,
    desktopPeer: params.stream ?? (await peerConnected.promise),
    observerUrl: ws.url,
    release,
    ws,
  };
}

function readSocketBytes(socket: Duplex, byteLength: number): Promise<Buffer> {
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

describe.runIf(process.platform !== "win32")("worker desktop observer proxy", () => {
  it("keeps an idle observer alive without adding bytes to RFB and retires on owner close", async () => {
    const logCapture = createDiagnosticLogRecordCapture();
    logCaptures.push(logCapture);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const harness = await createProxyHarness({ control: true });
    const pings: Buffer[] = [];
    const onDesktopData = vi.fn();
    harness.ws.on("ping", (data) => pings.push(data));
    harness.desktopPeer.on("data", onDesktopData);

    vi.advanceTimersByTime(25_000);
    await expect.poll(() => pings.length).toBe(1);
    vi.advanceTimersByTime(25_000);
    await expect.poll(() => pings.length).toBe(2);
    expect(onDesktopData).not.toHaveBeenCalled();

    const closed = new Promise<number>((resolve) => {
      harness.ws.once("close", resolve);
    });
    harness.closeObserver(1012, "desktop tunnel closed");
    await expect(closed).resolves.toBe(1012);
    await expect
      .poll(async () => {
        await logCapture.flush();
        return logCapture.records.filter((record) => record.message === "desktop observer closed");
      })
      .toHaveLength(1);
    expect(logCapture.records[0]?.attributes).toMatchObject({
      sourceKey: "worker:pump",
      ownerEpoch: 2,
      trigger: "owner-close",
      cleanupCode: 1012,
      closeCode: 1012,
    });
    expect(JSON.stringify(logCapture.records)).not.toContain(harness.observerUrl);
    expect(harness.release).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(25_000);
    expect(pings).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

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
    const logCapture = createDiagnosticLogRecordCapture();
    logCaptures.push(logCapture);
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
    await expect
      .poll(async () => {
        await logCapture.flush();
        return logCapture.records.filter((record) => record.message === "desktop observer closed");
      })
      .toHaveLength(1);
    expect(logCapture.records[0]?.attributes).toMatchObject({
      trigger: "stream-close",
      cleanupCode: 1000,
      closeCode: 1000,
    });
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
    const logCapture = createDiagnosticLogRecordCapture();
    logCaptures.push(logCapture);
    const harness = await createProxyHarness();
    const closed = new Promise<void>((resolve) => {
      harness.desktopPeer.once("close", resolve);
    });
    const token = new URL(harness.observerUrl).searchParams.get("token");
    harness.ws.close(1001, `browser left\n${token}`);
    await closed;
    await logCapture.flush();
    expect(logCapture.records).toHaveLength(1);
    expect(logCapture.records[0]?.attributes).toMatchObject({
      trigger: "browser-close",
      cleanupCode: 1000,
      closeCode: 1001,
    });
    expect(logCapture.records[0]?.attributes?.closeReason).toBeUndefined();
    const serialized = JSON.stringify(logCapture.records);
    expect(serialized).not.toContain("browser left");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(harness.observerUrl);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it("expires unused credential-bearing tokens without a later token operation", async () => {
    const harness = await createProxyHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const minted = mintDesktopObserverToken({
      sourceKey: "worker:unused",
      ownerEpoch: 1,
      control: false,
      attachment: { kind: "unix-socket", socketPath: "/tmp/unused-desktop.sock" },
      preauth: {
        auth: "vnc-password",
        credentials: { password: "synthetic-memory-only-password" },
      },
    });

    vi.advanceTimersByTime(60_000);
    // Wall-clock expiry still lies ahead; only the timer could have retired this token.
    expect(minted.expiresAtMs).toBeGreaterThan(Date.now());
    const observerUrl = new URL(harness.observerUrl);
    observerUrl.searchParams.set("token", minted.token);
    await expectUnauthorizedObserver(observerUrl.toString());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "bounds browser writes, resumes on drain, and closes a blocked desktop (control: %s)",
    async (control) => {
      const received: Buffer[] = [];
      let blocked = true;
      let releaseWrite: (() => void) | undefined;
      let gatewaySocket: WebSocket | undefined;
      const stream = new Duplex({
        writableHighWaterMark: 1,
        read() {},
        write(chunk, _encoding, callback) {
          received.push(Buffer.from(chunk));
          if (blocked) {
            releaseWrite = callback;
          } else {
            callback();
          }
        },
      });
      const harness = await createProxyHarness({
        control,
        stream,
        getBufferedAmount: (ws) => {
          gatewaySocket = ws;
          return ws.bufferedAmount;
        },
      });
      const pulse = new Promise<void>((resolve) => {
        harness.ws.once("message", () => resolve());
      });
      stream.push(Buffer.from("synthetic-server-pulse"));
      await pulse;
      const handshake = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);
      harness.ws.send(handshake);
      await expect.poll(() => releaseWrite).toBeDefined();
      expect(gatewaySocket?.isPaused).toBe(true);
      expect(stream.writableLength).toBe(handshake.length);

      const keyEvent = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
      const framebufferRequest = Buffer.from([3, 1, 0, 0, 0, 0, 0, 64, 0, 64]);
      harness.ws.send(Buffer.concat([keyEvent, framebufferRequest]));
      blocked = false;
      releaseWrite?.();
      releaseWrite = undefined;
      const expected = Buffer.concat([
        handshake,
        ...(control ? [keyEvent] : []),
        framebufferRequest,
      ]);
      await expect.poll(() => Buffer.concat(received)).toEqual(expected);
      await expect.poll(() => gatewaySocket?.isPaused).toBe(false);

      blocked = true;
      harness.ws.send(framebufferRequest);
      await expect.poll(() => releaseWrite).toBeDefined();
      expect(gatewaySocket?.isPaused).toBe(true);
      const closed = new Promise<number>((resolve) => {
        harness.ws.once("close", resolve);
      });
      harness.closeObserver(1012, "desktop tunnel closed");
      await expect(closed).resolves.toBe(1012);
      expect(stream.destroyed).toBe(true);
      expect(stream.listenerCount("drain")).toBe(0);
      expect(harness.release).toHaveBeenCalledOnce();
    },
  );

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
