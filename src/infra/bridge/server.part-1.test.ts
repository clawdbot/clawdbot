import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { pollUntil } from "../../../test/helpers/poll.js";
import { approveNodePairing, listNodePairing } from "../node-pairing.js";
import { configureNodeBridgeSocket, startNodeBridgeServer } from "./server.js";

function createLineReader(socket: net.Socket) {
  let buffer = "";
  const pending: Array<(line: string) => void> = [];

  const flush = () => {
    while (pending.length > 0) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const resolve = pending.shift();
      resolve?.(line);
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    flush();
  });

  const readLine = async () => {
    flush();
    const idx = buffer.indexOf("\n");
    if (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      return line;
    }
    return await new Promise<string>((resolve) => pending.push(resolve));
  };

  return readLine;
}

function sendLine(socket: net.Socket, obj: unknown) {
  socket.write(`${JSON.stringify(obj)}\n`);
}

async function waitForSocketConnect(socket: net.Socket) {
  if (!socket.connecting) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

describe("node bridge server", () => {
  let baseDir = "";

  const pickNonLoopbackIPv4 = () => {
    const ifaces = os.networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const info of entries ?? []) {
        if (info.family === "IPv4" && info.internal === false)
          return info.address;
      }
    }
    return null;
  };

  beforeAll(async () => {
    process.env.CLAWDBOT_ENABLE_BRIDGE_IN_TESTS = "1";
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-bridge-test-"));
  });

  afterAll(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
    delete process.env.CLAWDBOT_ENABLE_BRIDGE_IN_TESTS;
  });

  it("enables keepalive on sockets", () => {
    const socket = {
      setNoDelay: vi.fn(),
      setKeepAlive: vi.fn(),
    };
    configureNodeBridgeSocket(socket);
    expect(socket.setNoDelay).toHaveBeenCalledWith(true);
    expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 15_000);
  });

  it("rejects hello when not paired", async () => {
    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    const readLine = createLineReader(socket);
    sendLine(socket, { type: "hello", nodeId: "n1" });
    const line = await readLine();
    const msg = JSON.parse(line) as { type: string; code?: string };
    expect(msg.type).toBe("error");
    expect(msg.code).toBe("NOT_PAIRED");
    socket.destroy();
    await server.close();
  });

  it("does not add a loopback listener when bind already includes loopback", async () => {
    const loopback = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
    });
    expect(loopback.listeners).toHaveLength(1);
    expect(loopback.listeners[0]?.host).toBe("127.0.0.1");
    await loopback.close();

    const wildcard = await startNodeBridgeServer({
      host: "0.0.0.0",
      port: 0,
      pairingBaseDir: baseDir,
    });
    expect(wildcard.listeners).toHaveLength(1);
    expect(wildcard.listeners[0]?.host).toBe("0.0.0.0");
    await wildcard.close();
  });

  it("also listens on loopback when bound to a non-loopback host", async () => {
    const host = pickNonLoopbackIPv4();
    if (!host) return;

    const server = await startNodeBridgeServer({
      host,
      port: 0,
      pairingBaseDir: baseDir,
    });

    const hosts = server.listeners.map((l) => l.host).sort();
    expect(hosts).toContain(host);
    const hasLoopback = hosts.includes("127.0.0.1");
    if (hasLoopback) {
      const socket = net.connect({ host: "127.0.0.1", port: server.port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const readLine = createLineReader(socket);
      sendLine(socket, { type: "hello", nodeId: "n-loopback" });
      const line = await readLine();
      const msg = JSON.parse(line) as { type: string; code?: string };
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("NOT_PAIRED");
      socket.destroy();
    }
    await server.close();
  });

  it("pairs after approval and then accepts hello", async () => {
    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket);
    const readLine = createLineReader(socket);
    sendLine(socket, { type: "pair-request", nodeId: "n2", platform: "ios" });

    // Approve the pending request from the gateway side.
    const pending = await pollUntil(
      async () => {
        const list = await listNodePairing(baseDir);
        return list.pending.find((p) => p.nodeId === "n2");
      },
      { timeoutMs: 3000 },
    );
    expect(pending).toBeTruthy();
    if (!pending) throw new Error("expected a pending request");
    await approveNodePairing(pending.requestId, baseDir);

    const line1 = JSON.parse(await readLine()) as {
      type: string;
      token?: string;
    };
    expect(line1.type).toBe("pair-ok");
    expect(typeof line1.token).toBe("string");
    if (!line1.token) throw new Error("expected pair-ok token");
    const token = line1.token;

    const line2 = JSON.parse(await readLine()) as { type: string };
    expect(line2.type).toBe("hello-ok");

    socket.destroy();

    const socket2 = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket2);
    const readLine2 = createLineReader(socket2);
    sendLine(socket2, { type: "hello", nodeId: "n2", token });
    const line3 = JSON.parse(await readLine2()) as { type: string };
    expect(line3.type).toBe("hello-ok");
    socket2.destroy();

    await server.close();
  });

  it("calls onPairRequested for newly created pending requests", async () => {
    let requested: { nodeId?: string; requestId?: string } | null = null;
    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
      onPairRequested: async (req) => {
        requested = req;
      },
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket);
    sendLine(socket, { type: "pair-request", nodeId: "n3", platform: "ios" });

    await pollUntil(async () => requested, { timeoutMs: 3000 });

    expect(requested?.nodeId).toBe("n3");
    expect(typeof requested?.requestId).toBe("string");

    socket.destroy();
    await server.close();
  });

  it("handles req/res RPC after authentication", async () => {
    let lastRequest: { nodeId?: string; id?: string; method?: string } | null =
      null;

    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
      onRequest: async (nodeId, req) => {
        lastRequest = { nodeId, id: req.id, method: req.method };
        return { ok: true, payloadJSON: JSON.stringify({ ok: true }) };
      },
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket);
    const readLine = createLineReader(socket);
    sendLine(socket, {
      type: "pair-request",
      nodeId: "n3-rpc",
      platform: "ios",
    });

    // Approve the pending request from the gateway side.
    const pending = await pollUntil(
      async () => {
        const list = await listNodePairing(baseDir);
        return list.pending.find((p) => p.nodeId === "n3-rpc");
      },
      { timeoutMs: 3000 },
    );
    expect(pending).toBeTruthy();
    if (!pending) throw new Error("expected a pending request");
    await approveNodePairing(pending.requestId, baseDir);

    const line1 = JSON.parse(await readLine()) as { type: string };
    expect(line1.type).toBe("pair-ok");
    const line2 = JSON.parse(await readLine()) as { type: string };
    expect(line2.type).toBe("hello-ok");

    sendLine(socket, { type: "req", id: "r1", method: "health" });
    const res = JSON.parse(await readLine()) as {
      type: string;
      id?: string;
      ok?: boolean;
      payloadJSON?: string | null;
      error?: unknown;
    };
    expect(res.type).toBe("res");
    expect(res.id).toBe("r1");
    expect(res.ok).toBe(true);
    expect(res.payloadJSON).toBe(JSON.stringify({ ok: true }));
    expect(res.error).toBeUndefined();

    expect(lastRequest).toEqual({
      nodeId: "n3-rpc",
      id: "r1",
      method: "health",
    });

    socket.destroy();
    await server.close();
  });

  it("passes node metadata to onAuthenticated and onDisconnected", async () => {
    let lastAuthed: {
      nodeId?: string;
      displayName?: string;
      platform?: string;
      version?: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      remoteIp?: string;
      permissions?: Record<string, boolean>;
    } | null = null;

    let disconnected: {
      nodeId?: string;
      displayName?: string;
      platform?: string;
      version?: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      remoteIp?: string;
      permissions?: Record<string, boolean>;
    } | null = null;

    let resolveDisconnected: (() => void) | null = null;
    const disconnectedP = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });

    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
      onAuthenticated: async (node) => {
        lastAuthed = node;
      },
      onDisconnected: async (node) => {
        disconnected = node;
        resolveDisconnected?.();
      },
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket);
    const readLine = createLineReader(socket);
    sendLine(socket, {
      type: "pair-request",
      nodeId: "n4",
      displayName: "Node",
      platform: "ios",
      version: "1.0",
      deviceFamily: "iPad",
      modelIdentifier: "iPad16,6",
      permissions: { screenRecording: true, notifications: false },
    });

    // Approve the pending request from the gateway side.
    const pending = await pollUntil(
      async () => {
        const list = await listNodePairing(baseDir);
        return list.pending.find((p) => p.nodeId === "n4");
      },
      { timeoutMs: 3000 },
    );
    expect(pending).toBeTruthy();
    if (!pending) throw new Error("expected a pending request");
    const approved = await approveNodePairing(pending.requestId, baseDir);
    const token = approved?.node?.token ?? "";
    expect(token.length).toBeGreaterThan(0);

    const line1 = JSON.parse(await readLine()) as { type: string };
    expect(line1.type).toBe("pair-ok");
    const line2 = JSON.parse(await readLine()) as { type: string };
    expect(line2.type).toBe("hello-ok");
    socket.destroy();

    const socket2 = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket2);
    const readLine2 = createLineReader(socket2);
    sendLine(socket2, {
      type: "hello",
      nodeId: "n4",
      token,
      displayName: "Different name",
      platform: "ios",
      version: "2.0",
      deviceFamily: "iPad",
      modelIdentifier: "iPad99,1",
      permissions: { screenRecording: false },
    });
    const line3 = JSON.parse(await readLine2()) as { type: string };
    expect(line3.type).toBe("hello-ok");

    await pollUntil(
      async () => (lastAuthed?.nodeId === "n4" ? lastAuthed : null),
      { timeoutMs: 3000 },
    );

    expect(lastAuthed?.nodeId).toBe("n4");
    // Prefer paired metadata over hello payload (token verifies the stored node record).
    expect(lastAuthed?.displayName).toBe("Node");
    expect(lastAuthed?.platform).toBe("ios");
    expect(lastAuthed?.version).toBe("1.0");
    expect(lastAuthed?.deviceFamily).toBe("iPad");
    expect(lastAuthed?.modelIdentifier).toBe("iPad16,6");
    expect(lastAuthed?.permissions).toEqual({
      screenRecording: false,
      notifications: false,
    });
    expect(lastAuthed?.remoteIp?.includes("127.0.0.1")).toBe(true);

    socket2.destroy();
    await disconnectedP;
    expect(disconnected?.nodeId).toBe("n4");
    expect(disconnected?.remoteIp?.includes("127.0.0.1")).toBe(true);

    await server.close();
  });
});
