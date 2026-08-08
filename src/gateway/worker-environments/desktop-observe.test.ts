import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  consumeWorkerDesktopObserverToken,
  handleWorkerDesktopUpgrade,
  mintWorkerDesktopObserverToken,
  WORKER_DESKTOP_OBSERVE_PATH,
} from "./desktop-observe.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((run) => run()));
});

describe("worker desktop observer tokens", () => {
  it("are single-use, expire after 60 seconds, and reject unknown values", () => {
    const minted = mintWorkerDesktopObserverToken({
      environmentId: "worker:one",
      ownerEpoch: 3,
      control: true,
      localSocketPath: "/tmp/desktop.sock",
      nowMs: 1_000,
    });
    expect(minted.token).toMatch(/^[a-f0-9]{48}$/u);
    expect(minted.expiresAtMs).toBe(61_000);
    expect(consumeWorkerDesktopObserverToken(minted.token, 2_000)).toMatchObject({
      environmentId: "worker:one",
      ownerEpoch: 3,
      control: true,
    });
    expect(consumeWorkerDesktopObserverToken(minted.token, 2_000)).toBeUndefined();

    const expired = mintWorkerDesktopObserverToken({
      environmentId: "worker:two",
      ownerEpoch: 1,
      control: false,
      localSocketPath: "/tmp/expired.sock",
      nowMs: 5_000,
    });
    expect(consumeWorkerDesktopObserverToken(expired.token, 65_000)).toBeUndefined();
    expect(consumeWorkerDesktopObserverToken("0".repeat(48), 5_000)).toBeUndefined();
  });
});

async function createProxyHarness(params: { getBufferedAmount?: () => number } = {}) {
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
    handleWorkerDesktopUpgrade(req, socket, head, {
      tunnels: {
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
  const minted = mintWorkerDesktopObserverToken({
    environmentId: "worker:pump",
    ownerEpoch: 2,
    control: false,
    localSocketPath,
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${address.port}${WORKER_DESKTOP_OBSERVE_PATH}?token=${minted.token}`,
  );
  cleanup.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { closeObserver, desktopPeer: await peerConnected, release, ws };
}

describe("worker desktop observer proxy", () => {
  it("pumps binary RFB bytes both directions and propagates desktop close", async () => {
    const harness = await createProxyHarness();
    const fromDesktop = new Promise<Buffer>((resolve) => {
      harness.ws.once("message", (data) => resolve(Buffer.from(data as Buffer)));
    });
    harness.desktopPeer.write(Buffer.from("RFB 003.008\n"));
    await expect(fromDesktop).resolves.toEqual(Buffer.from("RFB 003.008\n"));

    const fromWebSocket = new Promise<Buffer>((resolve) => {
      harness.desktopPeer.once("data", resolve);
    });
    harness.ws.send(Buffer.from([1, 2, 3]));
    await expect(fromWebSocket).resolves.toEqual(Buffer.from([1, 2, 3]));

    const closed = new Promise<void>((resolve) => {
      harness.ws.once("close", () => resolve());
    });
    harness.desktopPeer.destroy();
    await closed;
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
