// Ios Node E2E tests cover the dev iOS node smoke script.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";

type ScriptResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type GatewayFrame = {
  id: string;
  method: string;
  params?: {
    command?: string;
    idempotencyKey?: string;
  };
  type: string;
};

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    wss?.close(() => resolve());
    if (!wss) {
      resolve();
    }
  });
  wss = undefined;

  await new Promise<void>((resolve, reject) => {
    server?.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    if (!server) {
      resolve();
    }
  });
  server = undefined;
});

function invokePayload(
  command: string,
  mode: "empty" | "invalid-payload-json" | "primitive-device-info" | "valid",
): unknown {
  if (mode === "primitive-device-info" && command === "device.info") {
    return "ok";
  }
  if (mode === "invalid-payload-json" && command === "device.status") {
    return { payloadJSON: "{" };
  }
  if (mode === "empty") {
    return {};
  }
  switch (command) {
    case "device.info":
      return { systemName: "iOS", systemVersion: "18.0" };
    case "device.status":
      return { battery: { state: "charging" } };
    case "system.notify":
      return { delivered: true };
    case "contacts.search":
      return { contacts: [] };
    case "calendar.events":
      return { events: [] };
    case "reminders.list":
      return { reminders: [] };
    case "motion.pedometer":
      return { steps: 12 };
    case "photos.latest":
      return { photos: [] };
    default:
      return { ok: true };
  }
}

async function listenGateway(params: {
  mode: "empty" | "invalid-payload-json" | "primitive-device-info" | "valid";
  invokeParams: Array<{ command?: string; idempotencyKey?: string }>;
}): Promise<string> {
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as GatewayFrame;
      if (frame.type !== "req") {
        return;
      }
      if (frame.method === "connect") {
        ws.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { connected: true } }),
        );
        return;
      }
      if (frame.method === "health") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { status: "ok" } }));
        return;
      }
      if (frame.method === "node.list") {
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              nodes: [
                {
                  nodeId: "ios-node",
                  displayName: "iPhone",
                  platform: "iOS",
                  connected: true,
                },
              ],
            },
          }),
        );
        return;
      }
      if (frame.method === "node.invoke") {
        params.invokeParams.push(frame.params ?? {});
        ws.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              ok: true,
              nodeId: "ios-node",
              command: frame.params?.command,
              payload: invokePayload(String(frame.params?.command ?? ""), params.mode),
            },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: `unexpected method ${frame.method}`,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket server did not get a TCP address");
  }
  return `ws://127.0.0.1:${address.port}`;
}

function runScript(url: string): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/dev/ios-node-e2e.ts",
        "--url",
        url,
        "--token",
        "token",
        "--json",
      ],
      { stdio: "pipe" },
    );
    const stdout = createBoundedChildOutput();
    const stderr = createBoundedChildOutput();
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      resolve({
        status: null,
        signal: "SIGKILL",
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut: true,
      });
    }, 5000);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status, signal, stdout: stdout.text(), stderr: stderr.text(), timedOut: false });
    });
  });
}

describe("ios-node-e2e", () => {
  it("fails empty node invoke payloads instead of counting them as proof", async () => {
    const invokeParams: Array<{ command?: string; idempotencyKey?: string }> = [];
    const url = await listenGateway({ mode: "empty", invokeParams });
    const result = await runScript(url);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ error?: string; id: string; ok: boolean; payload?: unknown }>;
    };

    expect(result).toMatchObject({ signal: null, status: 10, timedOut: false });
    expect(report.results[0]).toMatchObject({
      error: "device.info returned an empty object payload",
      id: "device.info",
      ok: false,
      payload: {
        ok: true,
        payload: {},
      },
    });
    expect(report.results.every((entry) => entry.ok === false)).toBe(true);
    expect(invokeParams.length).toBeGreaterThan(0);
  });

  it("fails malformed primitive device info payloads", async () => {
    const invokeParams: Array<{ command?: string; idempotencyKey?: string }> = [];
    const url = await listenGateway({ mode: "primitive-device-info", invokeParams });
    const result = await runScript(url);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ error?: string; id: string; ok: boolean; payload?: unknown }>;
    };

    expect(result).toMatchObject({ signal: null, status: 10, timedOut: false });
    expect(report.results[0]).toMatchObject({
      error: "device.info returned a string payload",
      id: "device.info",
      ok: false,
    });
  });

  it("fails malformed nested payloadJSON payloads", async () => {
    const invokeParams: Array<{ command?: string; idempotencyKey?: string }> = [];
    const url = await listenGateway({ mode: "invalid-payload-json", invokeParams });
    const result = await runScript(url);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ error?: string; id: string; ok: boolean; payload?: unknown }>;
    };

    expect(result).toMatchObject({ signal: null, status: 10, timedOut: false });
    expect(report.results[1]).toMatchObject({
      error: "device.status returned no payload",
      id: "device.status",
      ok: false,
    });
  });

  it("accepts non-empty node invoke payloads and sends idempotency keys", async () => {
    const invokeParams: Array<{ command?: string; idempotencyKey?: string }> = [];
    const url = await listenGateway({ mode: "valid", invokeParams });
    const result = await runScript(url);
    const report = JSON.parse(result.stdout) as {
      results: Array<{ id: string; ok: boolean }>;
    };

    expect(result).toMatchObject({ signal: null, status: 0, timedOut: false });
    expect(report.results.every((entry) => entry.ok)).toBe(true);
    expect(invokeParams.map((params) => params.command)).toEqual([
      "device.info",
      "device.status",
      "system.notify",
      "contacts.search",
      "calendar.events",
      "reminders.list",
      "motion.pedometer",
      "photos.latest",
    ]);
    expect(invokeParams.every((params) => typeof params.idempotencyKey === "string")).toBe(true);
  });
});
