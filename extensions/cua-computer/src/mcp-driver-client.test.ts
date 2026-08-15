import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClickButton, EscalationReason } from "./driver-client.js";
import { createCuaMcpDriver } from "./mcp-driver-client.js";

type RpcRequest = {
  id?: number;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
};

type FakeEndpoint = {
  binaryPath: string;
  socketPath: string;
  requests: RpcRequest[];
  respond: (request: RpcRequest, result: unknown) => void;
  writeRaw: (request: RpcRequest, value: string) => void;
  close: () => Promise<void>;
};

async function createFakeEndpoint(
  handle: (request: RpcRequest, endpoint: FakeEndpoint) => void,
): Promise<FakeEndpoint> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cua-mcp-test-"));
  const socketPath = path.join(directory, "daemon.sock");
  const binaryPath = path.join(directory, "cua-driver");
  await fs.writeFile(
    binaryPath,
    `#!/usr/bin/env node
const net = require("node:net");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "mcp" || args[1] !== "--embedded" || args[2] !== "--socket") process.exit(64);
if (process.env.CUA_DRIVER_EMBEDDED !== undefined || process.env.CUA_DRIVER_PERMISSION_MODE !== undefined || process.env.CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS !== undefined || process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED !== "false" || process.env.CUA_DRIVER_RS_UPDATE_CHECK !== "false") process.exit(65);
const socket = net.createConnection(args[3]);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("error", (error) => { process.stderr.write(error.message); process.exit(66); });
socket.on("close", () => process.exit(0));
`,
    { mode: 0o700 },
  );

  const requests: RpcRequest[] = [];
  const connections = new Set<net.Socket>();
  const writers = new Map<number, net.Socket>();
  const endpoint = {} as FakeEndpoint;
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          break;
        }
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length === 0) {
          continue;
        }
        const request = JSON.parse(line.toString("utf8")) as RpcRequest;
        requests.push(request);
        if (typeof request.id === "number") {
          writers.set(request.id, socket);
        }
        handle(request, endpoint);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve();
    });
  });

  Object.assign(endpoint, {
    binaryPath,
    socketPath,
    requests,
    respond: (request: RpcRequest, result: unknown) => {
      const writer = request.id === undefined ? undefined : writers.get(request.id);
      writer?.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    },
    writeRaw: (request: RpcRequest, value: string) => {
      const writer = request.id === undefined ? undefined : writers.get(request.id);
      writer?.write(value);
    },
    close: async () => {
      for (const connection of connections) {
        connection.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await fs.rm(directory, { recursive: true, force: true });
    },
  });
  return endpoint;
}

function toolResult(structuredContent: Record<string, unknown>, image = false) {
  return {
    content: [
      { type: "text", text: "ok" },
      ...(image
        ? [{ type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") }]
        : []),
    ],
    isError: false,
    structuredContent,
  };
}

function sessionState(scope: "window" | "desktop") {
  return toolResult({
    session: "openclaw-test",
    capture_scope: scope,
    effective_scope: scope,
    desktop_unlocked: scope === "desktop",
    escalation_reason: null,
    escalation_detail: null,
  });
}

describe.runIf(process.platform !== "win32")("CUA MCP proxy transport", () => {
  it("initializes the bundled proxy and translates tool results through CuaDriverSession", async () => {
    let closed = false;
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cua-driver", version: "0.19.3" },
        });
        return;
      }
      if (request.method !== "tools/call") {
        return;
      }
      switch (request.params?.name) {
        case "start_session":
          fake.respond(request, sessionState("desktop"));
          break;
        case "get_desktop_state":
          fake.respond(
            request,
            toolResult(
              {
                platform: "macos",
                display: "primary",
                screenshot_width: 200,
                screenshot_height: 100,
                screen_width: 100,
                screen_height: 50,
                scale_factor: 2,
              },
              true,
            ),
          );
          break;
        case "click":
          fake.respond(
            request,
            toolResult({
              effect: "confirmed",
              route: "accessibility",
              delivery: { mode: "background", delivered_count: 1 },
              evidence: [{ kind: "value_readback" }],
            }),
          );
          break;
        case "browser_navigate":
          fake.respond(
            request,
            toolResult({
              status: "ok",
              target_id: "target-1",
              tab_id: "tab-1",
              url: "https://example.com/",
              refs_invalidated: true,
            }),
          );
          break;
        case "list_windows":
          fake.respond(request, toolResult({ windows: [] }));
          break;
        case "get_session_state":
          fake.respond(request, sessionState("desktop"));
          break;
        case "end_session":
          fake.respond(request, toolResult({ session: "openclaw-test", active: false }));
          break;
        default:
          break;
      }
    });
    try {
      const driver = createCuaMcpDriver({
        ...endpoint,
        env: {
          ...process.env,
          CUA_DRIVER_EMBEDDED: "1",
          CUA_DRIVER_PERMISSION_MODE: "unrestricted",
          CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
        },
      });
      await vi.waitFor(() => expect(driver.isAvailable()).toBe(true));

      const desktop = await driver.getDesktopState();
      expect(JSON.parse(desktop.structuredJson!)).toMatchObject({
        platform: "macos",
        screenshot_width: 200,
      });
      expect(desktop.images).toHaveLength(1);
      const click = await driver.click({ x: 20, y: 30, button: ClickButton.Left, count: 1 });
      expect(click.action).toEqual({
        effect: 0,
        route: 0,
        delivery: { mode: 0, deliveredCount: 1 },
        evidence: [{ kind: 0 }],
      });
      await driver.callTool("browser_navigate", {
        target_id: "target-1",
        tab_id: "tab-1",
        url: "https://example.com/",
      });
      await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({
        isError: false,
      });
      await driver.escalateScope(EscalationReason.Other);
      await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({
        isError: false,
      });

      const startCalls = endpoint.requests.filter(
        (request) => request.method === "tools/call" && request.params?.name === "start_session",
      );
      expect(startCalls).toHaveLength(2);
      const captureScopes = startCalls.flatMap((request) => {
        const scope = request.params?.arguments?.capture_scope;
        return typeof scope === "string" ? [scope] : [];
      });
      expect(captureScopes.toSorted((left, right) => left.localeCompare(right))).toEqual([
        "desktop",
        "window",
      ]);
      expect(new Set(startCalls.map((request) => request.params?.arguments?.session)).size).toBe(2);
      const desktopSession = startCalls.find(
        (request) => request.params?.arguments?.capture_scope === "desktop",
      )?.params?.arguments?.session;
      const windowSession = startCalls.find(
        (request) => request.params?.arguments?.capture_scope === "window",
      )?.params?.arguments?.session;
      expect(
        endpoint.requests.find(
          (request) =>
            request.method === "tools/call" && request.params?.name === "get_session_state",
        )?.params?.arguments?.session,
      ).toBe(desktopSession);
      expect(
        endpoint.requests
          .filter(
            (request) => request.method === "tools/call" && request.params?.name === "list_windows",
          )
          .map((request) => request.params?.arguments?.session),
      ).toEqual([windowSession, windowSession]);

      await driver.dispose();
      await vi.waitFor(() => {
        closed = endpoint.requests.some(
          (request) => request.method === "tools/call" && request.params?.name === "end_session",
        );
        expect(closed).toBe(true);
      });
      expect(endpoint.requests.map((request) => request.method)).toContain(
        "notifications/initialized",
      );
      expect(
        endpoint.requests.find(
          (request) => request.method === "tools/call" && request.params?.name === "click",
        )?.params?.arguments,
      ).toMatchObject({ x: 20, y: 30, button: "left", count: 1, scope: "desktop" });
    } finally {
      await endpoint.close();
    }
  });

  it("fails closed on invalid proxy JSON", async () => {
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize" && request.id !== undefined) {
        fake.writeRaw(request, "not-json\n");
      }
    });
    try {
      const driver = createCuaMcpDriver(endpoint);
      await expect(driver.getDesktopState()).rejects.toThrow("COMPUTER_DRIVER_ERROR");
      expect(driver.isAvailable()).toBe(false);
      await driver.dispose();
    } finally {
      await endpoint.close();
    }
  });

  it("ends a started window session when desktop startup fails", async () => {
    let desktopStart: RpcRequest | undefined;
    const endedSessions: unknown[] = [];
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cua-driver", version: "0.19.3" },
        });
      } else if (request.method === "tools/call" && request.params?.name === "start_session") {
        if (request.params.arguments?.capture_scope === "desktop") {
          desktopStart = request;
        } else {
          fake.respond(request, sessionState("window"));
        }
      } else if (request.method === "tools/call" && request.params?.name === "list_windows") {
        fake.respond(request, toolResult({ windows: [] }));
      } else if (request.method === "tools/call" && request.params?.name === "end_session") {
        endedSessions.push(request.params.arguments?.session);
        fake.respond(request, toolResult({ session: request.params.arguments?.session }));
      }
    });
    try {
      const driver = createCuaMcpDriver(endpoint);
      await vi.waitFor(() => expect(driver.isAvailable()).toBe(true));
      await driver.callTool("list_windows", {});
      const desktopCall = driver.getDesktopState().catch((error: unknown) => error);
      await vi.waitFor(() => expect(desktopStart).toBeDefined());
      const disposeCall = driver.dispose().catch((error: unknown) => error);
      endpoint.respond(desktopStart!, { ...toolResult({}), isError: true });

      await expect(desktopCall).resolves.toBeInstanceOf(Error);
      await expect(disposeCall).resolves.toBeInstanceOf(Error);
      expect(endedSessions).toHaveLength(1);
      expect(endedSessions[0]).toEqual(expect.stringMatching(/^openclaw-window-/));
    } finally {
      await endpoint.close();
    }
  });

  it("bounds pending calls and tears down the proxy on cancellation", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cua-driver", version: "0.19.3" },
        });
      } else if (request.method === "tools/call" && request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.method === "tools/call" && request.params?.name === "list_windows") {
        held.push(request);
      } else if (request.method === "tools/call" && request.params?.name === "end_session") {
        fake.respond(request, toolResult({ session: "openclaw-test", active: false }));
      }
    });
    try {
      const driver = createCuaMcpDriver(endpoint);
      await vi.waitFor(() => expect(driver.isAvailable()).toBe(true));
      const calls = Array.from({ length: 65 }, () => driver.callTool("list_windows", {}));
      await expect(calls[64]).rejects.toThrow("too many pending requests");
      await vi.waitFor(() => expect(held).toHaveLength(64));
      expect(held[0]?.params?.arguments).toMatchObject({
        session: expect.stringMatching(/^openclaw-/),
      });
      for (const request of held) {
        endpoint.respond(request, toolResult({ windows: [] }));
      }
      await Promise.all(calls.slice(0, 64));

      const controller = new AbortController();
      const cancelled = driver.callTool("list_windows", {}, controller.signal);
      await vi.waitFor(() => expect(held).toHaveLength(65));
      controller.abort(new Error("test cancellation"));
      await expect(cancelled).rejects.toThrow("request was cancelled");
      expect(driver.isAvailable()).toBe(false);
      await driver.dispose();
    } finally {
      await endpoint.close();
    }
  });
});
