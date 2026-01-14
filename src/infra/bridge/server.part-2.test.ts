import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pollUntil } from "../../../test/helpers/poll.js";
import { approveNodePairing, listNodePairing } from "../node-pairing.js";
import { startNodeBridgeServer } from "./server.js";

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

  const _pickNonLoopbackIPv4 = () => {
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

  it("supports invoke roundtrip to a connected node", async () => {
    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket);
    const readLine = createLineReader(socket);
    sendLine(socket, { type: "pair-request", nodeId: "n5", platform: "ios" });

    // Approve the pending request from the gateway side.
    const pending = await pollUntil(
      async () => {
        const list = await listNodePairing(baseDir);
        return list.pending.find((p) => p.nodeId === "n5");
      },
      { timeoutMs: 3000 },
    );
    expect(pending).toBeTruthy();
    if (!pending) throw new Error("expected a pending request");
    await approveNodePairing(pending.requestId, baseDir);

    const pairOk = JSON.parse(await readLine()) as {
      type: string;
      token?: string;
    };
    expect(pairOk.type).toBe("pair-ok");
    expect(typeof pairOk.token).toBe("string");
    if (!pairOk.token) throw new Error("expected pair-ok token");
    const token = pairOk.token;

    const helloOk = JSON.parse(await readLine()) as { type: string };
    expect(helloOk.type).toBe("hello-ok");

    const responder = (async () => {
      while (true) {
        const frame = JSON.parse(await readLine()) as {
          type: string;
          id?: string;
          command?: string;
        };
        if (frame.type !== "invoke") continue;
        sendLine(socket, {
          type: "invoke-res",
          id: frame.id,
          ok: true,
          payloadJSON: JSON.stringify({ echo: frame.command }),
        });
        break;
      }
    })();

    const res = await server.invoke({
      nodeId: "n5",
      command: "canvas.eval",
      paramsJSON: JSON.stringify({ javaScript: "1+1" }),
      timeoutMs: 3000,
    });

    expect(res.ok).toBe(true);
    const payload = JSON.parse(String(res.payloadJSON ?? "null")) as {
      echo?: string;
    };
    expect(payload.echo).toBe("canvas.eval");

    await responder;
    socket.destroy();

    // Ensure invoke works only for connected nodes (hello with token on a new socket).
    const socket2 = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket2);
    const readLine2 = createLineReader(socket2);
    sendLine(socket2, { type: "hello", nodeId: "n5", token });
    const hello2 = JSON.parse(await readLine2()) as { type: string };
    expect(hello2.type).toBe("hello-ok");
    socket2.destroy();

    await server.close();
  });

  it("tracks connected node caps and hardware identifiers", async () => {
    const server = await startNodeBridgeServer({
      host: "127.0.0.1",
      port: 0,
      pairingBaseDir: baseDir,
    });

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    await waitForSocketConnect(socket);
    const readLine = createLineReader(socket);
    sendLine(socket, {
      type: "pair-request",
      nodeId: "n-caps",
      displayName: "Node",
      platform: "ios",
      version: "1.0",
      deviceFamily: "iPad",
      modelIdentifier: "iPad14,5",
      caps: ["canvas", "camera"],
      commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
      permissions: { accessibility: true },
    });

    // Approve the pending request from the gateway side.
    const pending = await pollUntil(
      async () => {
        const list = await listNodePairing(baseDir);
        return list.pending.find((p) => p.nodeId === "n-caps");
      },
      { timeoutMs: 3000 },
    );
    expect(pending).toBeTruthy();
    if (!pending) throw new Error("expected a pending request");
    await approveNodePairing(pending.requestId, baseDir);

    const pairOk = JSON.parse(await readLine()) as { type: string };
    expect(pairOk.type).toBe("pair-ok");
    const helloOk = JSON.parse(await readLine()) as { type: string };
    expect(helloOk.type).toBe("hello-ok");

    const connected = server.listConnected();
    const node = connected.find((n) => n.nodeId === "n-caps");
    expect(node?.deviceFamily).toBe("iPad");
    expect(node?.modelIdentifier).toBe("iPad14,5");
    expect(node?.caps).toEqual(["canvas", "camera"]);
    expect(node?.commands).toEqual([
      "canvas.eval",
      "canvas.snapshot",
      "camera.snap",
    ]);
    expect(node?.permissions).toEqual({ accessibility: true });

    const after = await listNodePairing(baseDir);
    const paired = after.paired.find((p) => p.nodeId === "n-caps");
    expect(paired?.caps).toEqual(["canvas", "camera"]);
    expect(paired?.commands).toEqual([
      "canvas.eval",
      "canvas.snapshot",
      "camera.snap",
    ]);
    expect(paired?.permissions).toEqual({ accessibility: true });

    socket.destroy();
    await server.close();
  });
});
