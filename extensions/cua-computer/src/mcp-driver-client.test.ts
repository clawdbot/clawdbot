import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
  writeRaw: (request: RpcRequest, value: string | Buffer) => void;
  writeRawStream: (request: RpcRequest, chunks: Iterable<Buffer>) => Promise<void>;
  close: () => Promise<void>;
};

async function createFakeEndpoint(
  handle: (request: RpcRequest, endpoint: FakeEndpoint) => void,
): Promise<FakeEndpoint> {
  // macOS sockaddr_un cannot hold the test runner's nested temporary path.
  const directory = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "oc-cua-mcp-"));
  // Registered before the bind so a failed listen still removes the root.
  onTestFinished(async () => await fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, "daemon.sock");
  // Keep the executable immutable: Linux rejects exec while an inode has a writer.
  const binaryPath = fileURLToPath(new URL("../test/fixtures/mcp-proxy.cjs", import.meta.url));

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
    writeRaw: (request: RpcRequest, value: string | Buffer) => {
      const writer = request.id === undefined ? undefined : writers.get(request.id);
      writer?.write(value);
    },
    writeRawStream: async (request: RpcRequest, chunks: Iterable<Buffer>) => {
      const writer = request.id === undefined ? undefined : writers.get(request.id);
      if (!writer) {
        throw new Error("fixture request has no connected writer");
      }
      await pipeline(Readable.from(chunks), writer, { end: false });
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
    },
  });
  // Register first so later driver hooks dispose before socket cleanup, even when a test fails.
  onTestFinished(endpoint.close);
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
          serverInfo: { name: "fake-cua-driver", version: "0.20.0" },
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
        case "get_cursor_position":
          fake.respond(request, toolResult({ x: 11, y: 12, source: "core_graphics" }));
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
    const driver = createCuaMcpDriver({
      ...endpoint,
      env: {
        ...process.env,
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_PERMISSION_MODE: "unrestricted",
        CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: "1",
      },
    });
    onTestFinished(() => driver.dispose());

    const desktop = await driver.getDesktopState();
    expect(driver.isAvailable()).toBe(true);
    expect(JSON.parse(desktop.structuredJson!)).toMatchObject({
      platform: "macos",
      screenshot_width: 200,
    });
    expect(desktop.images).toHaveLength(1);
    const cursor = await driver.getCursorPosition();
    expect(JSON.parse(cursor.structuredJson!)).toMatchObject({ x: 11, y: 12 });
    const click = await driver.click({ x: 20, y: 30, button: ClickButton.Left, count: 1 });
    expect(click.action).toEqual({
      effect: 0,
      route: 0,
      delivery: { mode: 0, deliveredCount: 1 },
      evidence: [{ kind: 0 }],
    });
    await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({
      isError: false,
    });
    await driver.escalateScope(EscalationReason.Other);
    await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({
      isError: false,
    });

    expect(endpoint.requests[0]).toMatchObject({
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openclaw-cua-computer", version: "1" },
      },
    });
    const startCalls = endpoint.requests.filter(
      (request) => request.method === "tools/call" && request.params?.name === "start_session",
    );
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.params?.arguments).not.toHaveProperty("capture_scope");
    const session = startCalls[0]?.params?.arguments?.session;
    expect(session).toEqual(expect.stringMatching(/^openclaw-/));
    expect(
      endpoint.requests.find(
        (request) =>
          request.method === "tools/call" && request.params?.name === "get_session_state",
      )?.params?.arguments?.session,
    ).toBe(session);
    expect(
      endpoint.requests
        .filter(
          (request) => request.method === "tools/call" && request.params?.name === "list_windows",
        )
        .map((request) => request.params?.arguments?.session),
    ).toEqual([session, session]);
    expect(
      endpoint.requests.find(
        (request) =>
          request.method === "tools/call" && request.params?.name === "get_cursor_position",
      )?.params?.arguments,
    ).toEqual({ session });

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
    ).toMatchObject({
      x: 20,
      y: 30,
      button: "left",
      count: 1,
      target: { kind: "desktop", display_id: "primary" },
    });
  });

  it("preserves UTF-8 and routes multiple out-of-order responses", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cua-driver", version: "0.20.0" },
        });
      } else if (request.method === "tools/call" && request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.method === "tools/call" && request.params?.name === "list_windows") {
        held.push(request);
        if (held.length !== 2) {
          return;
        }
        const firstRequest = held.find((call) => call.params?.arguments?.marker === "first");
        const secondRequest = held.find((call) => call.params?.arguments?.marker === "second");
        if (!firstRequest || !secondRequest) {
          throw new Error("fixture did not receive both tagged requests");
        }
        const framed = Buffer.from(
          `${JSON.stringify({ jsonrpc: "2.0", id: secondRequest.id, result: toolResult({ marker: "second", text: "β雪" }) })}\n\n${JSON.stringify({ jsonrpc: "2.0", id: firstRequest.id, result: toolResult({ marker: "first" }) })}\n`,
        );
        const split = framed.indexOf(Buffer.from("雪")) + 1;
        expect(split).toBeGreaterThan(0);
        // Receiving both requests owns the response; cold proxy startup is not a polling deadline.
        fake.writeRaw(secondRequest, framed.subarray(0, split));
        setImmediate(() => fake.writeRaw(secondRequest, framed.subarray(split)));
      } else if (request.method === "tools/call" && request.params?.name === "end_session") {
        fake.respond(request, toolResult({ session: "openclaw-test", active: false }));
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    const settlement: string[] = [];
    const firstCall = driver.callTool("list_windows", { marker: "first" }).then((result) => {
      settlement.push("first");
      return result;
    });
    const secondCall = driver.callTool("list_windows", { marker: "second" }).then((result) => {
      settlement.push("second");
      return result;
    });
    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(JSON.parse(first.structuredJson!)).toEqual({ marker: "first" });
    expect(JSON.parse(second.structuredJson!)).toEqual({ marker: "second", text: "β雪" });
    expect(settlement).toEqual(["second", "first"]);
    await driver.dispose();
  });

  it.each([
    ["not-json\n", "invalid JSON"],
    [" \n", "invalid JSON"],
    [JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} }) + "\n", "invalid JSON-RPC version"],
    [JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }) + "\n", "invalid response id"],
    [
      JSON.stringify({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER + 1, result: {} }) + "\n",
      "invalid response id",
    ],
    [
      JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2024-11-05" } }) + "\n",
      "incompatible protocol version",
    ],
  ])("fails closed for %s", async (response, message) => {
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.writeRaw(request, response);
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    await expect(driver.getDesktopState()).rejects.toThrow(message);
    expect(driver.isAvailable()).toBe(false);
    await driver.dispose();
  });

  it("retains completed responses before a later fatal frame and ignores unknown numeric IDs", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.params?.name === "list_windows") {
        held.push(request);
        if (held.length === 2) {
          const first = held[0];
          const second = held[1];
          if (!first || !second) {
            throw new Error("expected both requests");
          }
          fake.writeRaw(
            first,
            JSON.stringify({ jsonrpc: "2.0", id: -5, result: {} }) +
              "\n\n" +
              JSON.stringify({
                jsonrpc: "2.0",
                id: first.id,
                result: toolResult({ marker: "completed" }),
              }) +
              "\nnot-json\n" +
              JSON.stringify({
                jsonrpc: "2.0",
                id: second.id,
                result: toolResult({ marker: "too-late" }),
              }) +
              "\n",
          );
        }
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    const results = await Promise.allSettled([
      driver.callTool("list_windows", {}),
      driver.callTool("list_windows", {}),
    ]);
    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: { structuredJson: JSON.stringify({ marker: "completed" }) },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("invalid JSON") }),
    });
    expect(driver.isAvailable()).toBe(false);
    await driver.dispose();
    const probe = net.createConnection(endpoint.socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("connect", resolve);
        probe.once("error", reject);
      });
    } finally {
      probe.destroy();
    }
  });

  it("keeps JSON-RPC request errors local and preserves their CUA error text", async () => {
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.params?.arguments?.fail) {
        fake.writeRaw(
          request,
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32000, message: "fixture refusal" },
          }) + "\n",
        );
      } else if (request.method === "tools/call") {
        fake.respond(request, toolResult({ windows: [] }));
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    await expect(driver.callTool("list_windows", { fail: true })).rejects.toThrow(
      "COMPUTER_DRIVER_ERROR: CUA MCP request failed: MCP error -32000: fixture refusal",
    );
    expect(driver.isAvailable()).toBe(true);
    await expect(driver.callTool("list_windows", {})).resolves.toMatchObject({ isError: false });
  });

  it("preserves the CUA stopping error for pending calls during disposal", async () => {
    let held = false;
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.params?.arguments?.hold) {
        held = true;
      } else if (request.method === "tools/call") {
        fake.respond(request, toolResult({ windows: [] }));
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    await driver.callTool("list_windows", {});
    const pending = driver
      .callTool("list_windows", { hold: true })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(held).toBe(true));
    await driver.dispose();
    expect(await pending).toMatchObject({
      message: "COMPUTER_DRIVER_UNAVAILABLE: CUA MCP proxy is stopping",
    });
  });

  it("accepts a CUA screenshot larger than the default MCP buffer", async () => {
    const image = "A".repeat(11 * 1024 * 1024);
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.params?.name === "get_desktop_state") {
        fake.respond(request, { content: [{ type: "image", data: image, mimeType: "image/png" }] });
      } else if (request.params?.name === "end_session") {
        fake.respond(request, toolResult({ active: false }));
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    const result = await driver.getDesktopState();
    const actual = result.images[0]?.dataBase64;
    if (typeof actual !== "string") {
      throw new Error("expected CUA image data");
    }
    expect(createHash("sha256").update(actual).digest("hex")).toBe(
      createHash("sha256").update(image).digest("hex"),
    );
  });

  it("rejects an unfinished CUA frame beyond 256 MiB as a line-size overflow", async () => {
    function* overflowChunks(): Iterable<Buffer> {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      for (let index = 0; index < 4096; index += 1) {
        yield chunk;
      }
      yield Buffer.from([0x20]);
    }
    let streaming: Promise<void> | undefined;
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.params?.name === "get_desktop_state") {
        streaming = fake.writeRawStream(request, overflowChunks());
        // Observe producer errors until the test checks them after the expected proxy retirement.
        void streaming.catch(() => {});
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    await expect(driver.getDesktopState()).rejects.toThrow(
      "COMPUTER_DRIVER_ERROR: CUA MCP response exceeded the line-size limit",
    );
    expect(driver.isAvailable()).toBe(false);
    if (!streaming) {
      throw new Error("expected overflow stream to start");
    }
    await streaming.catch((error: unknown) => {
      expect(error).toMatchObject({
        code: expect.stringMatching(/^(?:EPIPE|ECONNRESET|ERR_STREAM_PREMATURE_CLOSE)$/),
      });
    });
    await driver.dispose();
  });

  it("retires a pending initialize at the shared startup deadline", async () => {
    const endpoint = await createFakeEndpoint(() => {});
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    try {
      const call = driver.getDesktopState();
      const rejected = expect(call).rejects.toThrow(
        "COMPUTER_DRIVER_UNAVAILABLE: CUA MCP initialize timed out after 10000ms",
      );
      await vi.waitFor(() =>
        expect(endpoint.requests.some((request) => request.method === "initialize")).toBe(true),
      );
      deadline.abort(new Error("fixture startup deadline"));
      await rejected;
      expect(driver.isAvailable()).toBe(false);
      expect(
        endpoint.requests.some((request) => request.method === "notifications/initialized"),
      ).toBe(false);
    } finally {
      timeout.mockRestore();
      await driver.dispose();
    }
  });

  it("makes a request timeout fatal without sending SDK cancellation notifications", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, { protocolVersion: "2025-06-18" });
      } else if (request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.params?.arguments?.hold) {
        held.push(request);
      } else if (request.method === "tools/call") {
        fake.respond(request, toolResult({ windows: [] }));
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    await driver.callTool("list_windows", {});
    vi.useFakeTimers();
    try {
      const settled = Promise.allSettled([
        driver.callTool("list_windows", { hold: true }),
        driver.callTool("list_windows", { hold: true }),
      ]);
      await vi.waitFor(() => expect(held).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await settled).toEqual(
        Array.from({ length: 2 }, () => ({
          status: "rejected",
          reason: expect.objectContaining({
            message: "COMPUTER_DRIVER_UNAVAILABLE: CUA MCP tools/call timed out after 120000ms",
          }),
        })),
      );
      expect(driver.isAvailable()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await driver.dispose();
    expect(endpoint.requests.some((request) => request.method === "notifications/cancelled")).toBe(
      false,
    );
  });

  it("bounds pending calls and tears down the proxy on cancellation", async () => {
    const held: RpcRequest[] = [];
    const endpoint = await createFakeEndpoint((request, fake) => {
      if (request.method === "initialize") {
        fake.respond(request, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cua-driver", version: "0.20.0" },
        });
      } else if (request.method === "tools/call" && request.params?.name === "start_session") {
        fake.respond(request, sessionState("window"));
      } else if (request.method === "tools/call" && request.params?.name === "list_windows") {
        held.push(request);
      } else if (request.method === "tools/call" && request.params?.name === "end_session") {
        fake.respond(request, toolResult({ session: "openclaw-test", active: false }));
      }
    });
    const driver = createCuaMcpDriver(endpoint);
    onTestFinished(() => driver.dispose());
    const calls = Array.from({ length: 65 }, () => driver.callTool("list_windows", {}));
    await expect(calls[64]).rejects.toThrow("too many pending requests");
    expect(driver.isAvailable()).toBe(true);
    await vi.waitFor(() => expect(held).toHaveLength(64));
    expect(held[0]?.params?.arguments).toMatchObject({
      session: expect.stringMatching(/^openclaw-/),
    });
    for (const request of held) {
      endpoint.respond(request, toolResult({ windows: [] }));
    }
    await Promise.all(calls.slice(0, 64));

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("pre-admission cancellation"));
    await expect(driver.callTool("list_windows", {}, alreadyAborted.signal)).rejects.toThrow(
      "request was cancelled",
    );
    expect(driver.isAvailable()).toBe(true);
    expect(held).toHaveLength(64);
    const controller = new AbortController();
    const cancelled = driver.callTool("list_windows", {}, controller.signal);
    const sibling = driver.callTool("list_windows", {});
    const settled = Promise.allSettled([cancelled, sibling]);
    await vi.waitFor(() => expect(held).toHaveLength(66));
    controller.abort(new Error("test cancellation"));
    expect(await settled).toEqual(
      Array.from({ length: 2 }, () => ({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("request was cancelled"),
        }),
      })),
    );
    expect(endpoint.requests.some((request) => request.method === "notifications/cancelled")).toBe(
      false,
    );
    expect(driver.isAvailable()).toBe(false);
    await driver.dispose();
  });
});
