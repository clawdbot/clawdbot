import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createSuiteLogPathTracker } from "../../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import { createNodeDesktopStreamBroker } from "./node-stream-broker.js";

const cleanups: Array<() => Promise<void>> = [];
const logPaths = createSuiteLogPathTracker("node-stream-broker-diagnostics-");
const logCaptures: ReturnType<typeof createDiagnosticLogRecordCapture>[] = [];

beforeAll(async () => logPaths.setup());
beforeEach(() =>
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logPaths.nextPath() }),
);
afterAll(async () => logPaths.cleanup());

afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
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

async function startBrokerServer(params: {
  broker: ReturnType<typeof createNodeDesktopStreamBroker>;
  session: { connId: string; pairingGeneration: string };
  pairingCurrent?: () => boolean | Promise<boolean>;
}) {
  const registry = {
    getForPairingGeneration: (_nodeId: string, pairingGeneration: string) =>
      pairingGeneration === params.session.pairingGeneration
        ? { connId: params.session.connId }
        : undefined,
    isConnectionCurrentPairingState: async (connId: string) =>
      connId === params.session.connId && (await (params.pairingCurrent?.() ?? true)),
  };
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    void params.broker.handleUpgrade(req, socket, head, registry as never);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected broker test address");
  }
  cleanups.push(
    async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return `ws://127.0.0.1:${address.port}`;
}

async function connectAndSend(url: string, metadata: object): Promise<WebSocket> {
  const ws = new WebSocket(url);
  cleanups.push(async () => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(Buffer.from(JSON.stringify(metadata)), { binary: true });
  return ws;
}

async function expectUnauthorized(url: string): Promise<void> {
  const ws = new WebSocket(url);
  cleanups.push(async () => ws.terminate());
  await expect(
    new Promise<number>((resolve, reject) => {
      ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      ws.once("open", () => reject(new Error("unexpected node desktop attachment")));
      ws.once("error", () => undefined);
    }),
  ).resolves.toBe(401);
}

describe("node desktop stream tickets", () => {
  it.each(
    (["desktop", "portal"] as const).flatMap((kind) =>
      (["consumer-destroy", "peer-close", "peer-terminate"] as const).map((closeMode) => ({
        kind,
        closeMode,
      })),
    ),
  )(
    "keeps idle $kind streams alive through remote backpressure and records $closeMode",
    async ({ kind, closeMode }) => {
      const logCapture = createDiagnosticLogRecordCapture();
      logCaptures.push(logCapture);
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const broker = createNodeDesktopStreamBroker();
      const session = { connId: "conn-1", pairingGeneration: "generation-1" };
      const baseUrl = await startBrokerServer({ broker, session });
      const binding = { nodeId: "node-1", ...session };
      const minted = kind === "desktop" ? broker.mint(binding) : broker.mintPortal(binding);
      const ws = await connectAndSend(
        `${baseUrl}${minted.attachPath}`,
        kind === "desktop" ? { auth: "vnc-password" } : { ok: true },
      );
      const { stream } = await minted.attached;
      const pings: Buffer[] = [];
      const streamBytes: Buffer[] = [];
      ws.on("ping", (data) => pings.push(data));
      stream.on("data", (data) => streamBytes.push(data));

      vi.advanceTimersByTime(25_000);
      await expect.poll(() => pings.length).toBe(1);
      expect(streamBytes).toEqual([]);

      // A paused remote peer cannot process pings or send automatic pongs.
      ws.pause();
      vi.advanceTimersByTime(50_000);
      ws.resume();
      await expect.poll(() => pings.length).toBe(3);
      ws.send(Buffer.from("resumed stream bytes"), { binary: true });
      await expect.poll(() => Buffer.concat(streamBytes).toString()).toBe("resumed stream bytes");
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const closed = new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
      });
      const streamClosed = new Promise<void>((resolve) => {
        stream.once("close", () => resolve());
      });
      if (closeMode === "peer-close") {
        ws.close(1012, `peer restart\n${minted.attachPath}`);
      } else if (closeMode === "peer-terminate") {
        ws.terminate();
      } else {
        stream.destroy();
      }
      await Promise.all([closed, streamClosed]);
      await logCapture.flush();
      const records = logCapture.records.filter(
        (record) => record.message === "node stream closed",
      );
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        streamKind: kind,
        nodeId: "node-1",
        connId: "conn-1",
        trigger: "websocket-close",
        closeCode: closeMode === "peer-close" ? 1012 : 1006,
      });
      expect(records[0]?.attributes?.closeReason).toBeUndefined();
      const serialized = JSON.stringify(logCapture.records);
      expect(serialized).not.toContain("peer restart");
      expect(serialized).not.toContain(minted.ticket);
      expect(serialized).not.toContain(minted.attachPath);
      expect(serialized).not.toContain("resumed stream bytes");
      vi.advanceTimersByTime(25_000);
      expect(pings).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("is single-use and resolves one ticket-bound binary stream", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mint({ nodeId: "node-1", ...session });

    await connectAndSend(`${baseUrl}${minted.attachPath}`, { auth: "vnc-password" });
    const attached = await minted.attached;
    expect(attached.auth).toBe("vnc-password");
    attached.stream.destroy();

    await expectUnauthorized(`${baseUrl}${minted.attachPath}`);
  });

  it("buffers early RFB bytes while the pairing binding is rechecked", async () => {
    let pairingChecks = 0;
    let releaseRecheck!: () => void;
    const recheck = new Promise<void>((resolve) => {
      releaseRecheck = resolve;
    });
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({
      broker,
      session,
      pairingCurrent: async () => {
        pairingChecks += 1;
        if (pairingChecks > 1) {
          await recheck;
        }
        return true;
      },
    });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, {
      auth: "vnc-password",
    });
    const earlyBanner = Buffer.from("RFB 003.008\n", "ascii");
    ws.send(earlyBanner, { binary: true });
    await vi.waitFor(() => expect(pairingChecks).toBe(2));
    releaseRecheck();

    const attached = await minted.attached;
    await expect(
      new Promise<Buffer>((resolve) => {
        attached.stream.once("data", resolve);
      }),
    ).resolves.toEqual(earlyBanner);
    attached.stream.destroy();
  });

  it("rejects a stream error during the asynchronous pairing handoff", async () => {
    let pairingChecks = 0;
    let releaseRecheck!: () => void;
    const recheck = new Promise<void>((resolve) => {
      releaseRecheck = resolve;
    });
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({
      broker,
      session,
      pairingCurrent: async () => {
        pairingChecks += 1;
        if (pairingChecks > 1) {
          await recheck;
        }
        return true;
      },
    });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, {
      auth: "vnc-password",
    });
    await vi.waitFor(() => expect(pairingChecks).toBe(2));
    ws.send(Buffer.alloc(65 * 1024), { binary: true });

    await expect(minted.attached).rejects.toThrow();
    releaseRecheck();
  });

  it("rejects invalid metadata without exposing later WebSocket errors", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, { auth: "none" });
    ws.send(Buffer.alloc(65 * 1024), { binary: true });

    await expect(minted.attached).rejects.toThrow();
  });

  it("rejects an expired ticket before upgrading", async () => {
    let now = 1_000;
    const broker = createNodeDesktopStreamBroker({ ttlMs: 60_000, now: () => now });
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    now = minted.expiresAtMs;

    await expectUnauthorized(`${baseUrl}${minted.attachPath}`);
    await expect(minted.attached).rejects.toThrow("expired");
  });

  it("rejects a ticket after connection or pairing generation replacement", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const oldConnection = broker.mint({ nodeId: "node-1", ...session });
    session.connId = "conn-2";
    await expectUnauthorized(`${baseUrl}${oldConnection.attachPath}`);
    await expect(oldConnection.attached).rejects.toThrow("stale");

    const oldGeneration = broker.mint({ nodeId: "node-1", ...session });
    session.pairingGeneration = "generation-2";
    await expectUnauthorized(`${baseUrl}${oldGeneration.attachPath}`);
    await expect(oldGeneration.attached).rejects.toThrow("stale");
  });

  it("rechecks the pairing generation after a delayed metadata frame", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const ws = new WebSocket(`${baseUrl}${minted.attachPath}`);
    cleanups.push(async () => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    session.pairingGeneration = "generation-2";
    ws.send(Buffer.from(JSON.stringify({ auth: "vnc-password" })), { binary: true });

    await expect(minted.attached).rejects.toThrow("stale");
  });

  it.each(["cancelled", "expired"] as const)(
    "rejects a redeemed ticket that is %s while metadata is pending",
    async (outcome) => {
      const logCapture = createDiagnosticLogRecordCapture();
      logCaptures.push(logCapture);
      const broker = createNodeDesktopStreamBroker({ now: () => 1_000 });
      const session = { connId: "conn-1", pairingGeneration: "generation-1" };
      const baseUrl = await startBrokerServer({ broker, session });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const minted = broker.mint({ nodeId: "node-1", ...session });
      const ws = new WebSocket(`${baseUrl}${minted.attachPath}`);
      cleanups.push(async () => ws.terminate());
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      if (outcome === "cancelled") {
        minted.cancel();
      } else {
        vi.advanceTimersByTime(60_000);
      }

      await expect(minted.attached).rejects.toThrow(`node desktop stream ticket ${outcome}`);
      await expect(closed).resolves.toEqual({ code: 1008, reason: "node desktop attach rejected" });
      vi.useRealTimers();
      await expect
        .poll(async () => {
          await logCapture.flush();
          return logCapture.records.filter((record) => record.message === "node stream closed");
        })
        .toHaveLength(1);
      expect(logCapture.records[0]?.attributes).toMatchObject({
        trigger: "attach-rejected",
        closeCode: 1008,
      });
    },
  );

  it("rejects when the raw upgrade socket closes during pairing authorization", async () => {
    let pairingChecks = 0;
    let releaseCheck!: () => void;
    const check = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({
      broker,
      session,
      pairingCurrent: async () => {
        pairingChecks += 1;
        await check;
        return true;
      },
    });
    const minted = broker.mint({ nodeId: "node-1", ...session });
    const url = new URL(baseUrl);
    const socket = net.createConnection(Number(url.port), url.hostname);
    cleanups.push(async () => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(
      [
        `GET ${minted.attachPath} HTTP/1.1`,
        `Host: ${url.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGVzdC1ub25jZS0xMjM0NQ==",
        "",
        "",
      ].join("\r\n"),
    );
    await vi.waitFor(() => expect(pairingChecks).toBe(1));

    socket.destroy();

    await expect(minted.attached).rejects.toThrow("authorization");
    releaseCheck();
  });
});

describe("node portal stream tickets", () => {
  it("pairs a ready portal stream and keeps desktop and portal tickets isolated", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mintPortal({ nodeId: "node-1", ...session });

    await expectUnauthorized(
      `${baseUrl}${minted.attachPath.replace("/node-portal/", "/node-desktop/")}`,
    );
    const ws = await connectAndSend(`${baseUrl}${minted.attachPath}`, { ok: true });
    const attached = await minted.attached;
    const response = new Promise<Buffer>((resolve) => {
      attached.stream.once("data", resolve);
    });
    ws.send(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"), { binary: true });

    await expect(response).resolves.toEqual(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
    attached.stream.destroy();
    await expectUnauthorized(`${baseUrl}${minted.attachPath}`);
  });

  it("rejects unexpected portal readiness metadata", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mintPortal({ nodeId: "node-1", ...session });

    await connectAndSend(`${baseUrl}${minted.attachPath}`, { ok: true, auth: "vnc-password" });

    await expect(minted.attached).rejects.toThrow("invalid node portal attach metadata");
  });

  it("rejects immediately when the node closes before the target is ready", async () => {
    const broker = createNodeDesktopStreamBroker();
    const session = { connId: "conn-1", pairingGeneration: "generation-1" };
    const baseUrl = await startBrokerServer({ broker, session });
    const minted = broker.mintPortal({ nodeId: "node-1", ...session });
    const ws = new WebSocket(`${baseUrl}${minted.attachPath}`);
    cleanups.push(async () => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.close();

    await expect(minted.attached).rejects.toThrow("node portal stream closed before attach");
  });
});
