import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  bridgeInvoke,
  bridgeListConnected,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

const decodeWsData = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf-8",
    );
  }
  return "";
};

async function _waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

installGatewayTestHooks();

describe("gateway server node/bridge", () => {
  test("supports gateway-owned node pairing methods and events", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const requestedP = new Promise<{
      type: "event";
      event: string;
      payload?: unknown;
    }>((resolve) => {
      ws.on("message", (data) => {
        const obj = JSON.parse(decodeWsData(data)) as {
          type?: string;
          event?: string;
          payload?: unknown;
        };
        if (obj.type === "event" && obj.event === "node.pair.requested") {
          resolve(obj as never);
        }
      });
    });

    const res1 = await rpcReq(ws, "node.pair.request", {
      nodeId: "n1",
      displayName: "Node",
    });
    expect(res1.ok).toBe(true);
    const req1 = (res1.payload as { request?: { requestId?: unknown } } | null)
      ?.request;
    const requestId = typeof req1?.requestId === "string" ? req1.requestId : "";
    expect(requestId.length).toBeGreaterThan(0);

    const evt1 = await requestedP;
    expect(evt1.event).toBe("node.pair.requested");
    expect((evt1.payload as { requestId?: unknown } | null)?.requestId).toBe(
      requestId,
    );

    const res2 = await rpcReq(ws, "node.pair.request", {
      nodeId: "n1",
      displayName: "Node",
    });
    expect(res2.ok).toBe(true);
    await expect(
      onceMessage(
        ws,
        (o) => o.type === "event" && o.event === "node.pair.requested",
        200,
      ),
    ).rejects.toThrow();

    const resolvedP = new Promise<{
      type: "event";
      event: string;
      payload?: unknown;
    }>((resolve) => {
      ws.on("message", (data) => {
        const obj = JSON.parse(decodeWsData(data)) as {
          type?: string;
          event?: string;
          payload?: unknown;
        };
        if (obj.type === "event" && obj.event === "node.pair.resolved") {
          resolve(obj as never);
        }
      });
    });

    const approveRes = await rpcReq(ws, "node.pair.approve", { requestId });
    expect(approveRes.ok).toBe(true);
    const tokenValue = (
      approveRes.payload as { node?: { token?: unknown } } | null
    )?.node?.token;
    const token = typeof tokenValue === "string" ? tokenValue : "";
    expect(token.length).toBeGreaterThan(0);

    const evt2 = await resolvedP;
    expect((evt2.payload as { requestId?: unknown } | null)?.requestId).toBe(
      requestId,
    );
    expect((evt2.payload as { decision?: unknown } | null)?.decision).toBe(
      "approved",
    );

    const verifyRes = await rpcReq(ws, "node.pair.verify", {
      nodeId: "n1",
      token,
    });
    expect(verifyRes.ok).toBe(true);
    expect((verifyRes.payload as { ok?: unknown } | null)?.ok).toBe(true);

    const listRes = await rpcReq(ws, "node.pair.list", {});
    expect(listRes.ok).toBe(true);
    const paired = (listRes.payload as { paired?: unknown } | null)?.paired;
    expect(Array.isArray(paired)).toBe(true);
    expect(
      (paired as Array<{ nodeId?: unknown }>).some((n) => n.nodeId === "n1"),
    ).toBe(true);

    ws.close();
    await server.close();
    await fs.rm(homeDir, { recursive: true, force: true });
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
  });

  test("routes node.invoke to the node bridge", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      bridgeInvoke.mockResolvedValueOnce({
        type: "invoke-res",
        id: "inv-1",
        ok: true,
        payloadJSON: JSON.stringify({ result: "4" }),
        error: null,
      });

      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const res = await rpcReq(ws, "node.invoke", {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "2+2" },
          timeoutMs: 123,
          idempotencyKey: "idem-1",
        });
        expect(res.ok).toBe(true);

        expect(bridgeInvoke).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "ios-node",
            command: "canvas.eval",
            paramsJSON: JSON.stringify({ javaScript: "2+2" }),
            timeoutMs: 123,
          }),
        );
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("routes camera.list invoke to the node bridge", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      bridgeInvoke.mockResolvedValueOnce({
        type: "invoke-res",
        id: "inv-2",
        ok: true,
        payloadJSON: JSON.stringify({ devices: [] }),
        error: null,
      });

      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const res = await rpcReq(ws, "node.invoke", {
          nodeId: "ios-node",
          command: "camera.list",
          params: {},
          idempotencyKey: "idem-2",
        });
        expect(res.ok).toBe(true);

        expect(bridgeInvoke).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeId: "ios-node",
            command: "camera.list",
            paramsJSON: JSON.stringify({}),
          }),
        );
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.describe returns supported invoke commands for paired nodes", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        const reqRes = await rpcReq<{
          status?: string;
          request?: { requestId?: string };
        }>(ws, "node.pair.request", {
          nodeId: "n1",
          displayName: "iPad",
          platform: "iPadOS",
          version: "dev",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas", "camera"],
          commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
          remoteIp: "10.0.0.10",
        });
        expect(reqRes.ok).toBe(true);
        const requestId = reqRes.payload?.request?.requestId;
        expect(typeof requestId).toBe("string");

        const approveRes = await rpcReq(ws, "node.pair.approve", {
          requestId,
        });
        expect(approveRes.ok).toBe(true);

        const describeRes = await rpcReq<{ commands?: string[] }>(
          ws,
          "node.describe",
          { nodeId: "n1" },
        );
        expect(describeRes.ok).toBe(true);
        expect(describeRes.payload?.commands).toEqual([
          "camera.snap",
          "canvas.eval",
          "canvas.snapshot",
        ]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  test("node.describe works for connected unpaired nodes (caps + commands)", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;

    try {
      const { server, ws } = await startServerWithClient();
      try {
        await connectOk(ws);

        bridgeListConnected.mockReturnValueOnce([
          {
            nodeId: "u1",
            displayName: "Unpaired Live",
            platform: "Android",
            version: "dev-live",
            remoteIp: "10.0.0.12",
            deviceFamily: "Android",
            modelIdentifier: "samsung SM-X926B",
            caps: ["canvas", "camera", "canvas"],
            commands: ["canvas.eval", "camera.snap", "canvas.eval"],
          },
        ]);

        const describeRes = await rpcReq<{
          paired?: boolean;
          connected?: boolean;
          caps?: string[];
          commands?: string[];
          deviceFamily?: string;
          modelIdentifier?: string;
          remoteIp?: string;
        }>(ws, "node.describe", { nodeId: "u1" });
        expect(describeRes.ok).toBe(true);
        expect(describeRes.payload).toMatchObject({
          paired: false,
          connected: true,
          deviceFamily: "Android",
          modelIdentifier: "samsung SM-X926B",
          remoteIp: "10.0.0.12",
        });
        expect(describeRes.payload?.caps).toEqual(["camera", "canvas"]);
        expect(describeRes.payload?.commands).toEqual([
          "camera.snap",
          "canvas.eval",
        ]);
      } finally {
        ws.close();
        await server.close();
      }
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });
});
