import { PassThrough, type Writable } from "node:stream";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OwnedStdioProcess } from "../process/owned-stdio.js";
import { createMcpStdioClient, type McpStdioClient } from "./mcp-stdio-client.js";

const spawnMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
vi.mock("../process/owned-stdio.js", async (importOriginal) => {
  const { OwnedStdioCleanupError } =
    await importOriginal<typeof import("../process/owned-stdio.js")>();
  return {
    createOwnedStdioProcess: spawnMock,
    closeOwnedStdioProcess: closeMock,
    OwnedStdioCleanupError,
  };
});

const clients: McpStdioClient[] = [];
const childCleanups: Array<() => void> = [];

function createFixture(protocolVersion = "2025-06-18") {
  const root = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const extinction = createDeferred();
  const requested = createDeferred();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const messages: JSONRPCMessage[] = [];
  const buffer = new ReadBuffer();
  stdin.on("data", (chunk: Buffer) => {
    buffer.append(chunk);
    let message: JSONRPCMessage | null;
    while ((message = buffer.readMessage()) !== null) {
      messages.push(message);
      if ("method" in message && message.method === "initialize" && "id" in message) {
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion } })}\n`,
        );
      } else if ("method" in message && message.method === "tools/call") {
        requested.resolve();
      }
    }
  });
  const child = {
    pid: 4321,
    stdin,
    supportsRawOutput: true,
    onStdout: (_decoded: (text: string) => void, raw?: (chunk: Buffer) => void) => {
      if (raw) {
        stdout.on("data", raw);
      }
    },
    onStderr: () => {},
    onExit: () => {},
    onError: () => {},
    wait: () => root.promise,
    waitForExtinction: () => extinction.promise,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      root.resolve({ code: null, signal: signal ?? null });
      extinction.resolve();
    }),
    dispose: vi.fn(),
  } satisfies OwnedStdioProcess;
  spawnMock.mockImplementation(async ({ stderrDestination }: { stderrDestination?: Writable }) => {
    if (stderrDestination) {
      stderr.pipe(stderrDestination, { end: false });
    }
    return child;
  });
  closeMock.mockImplementation(async (process: OwnedStdioProcess) => {
    await process.wait();
    await process.waitForExtinction?.();
  });
  childCleanups.push(() => {
    root.resolve({ code: 0, signal: null });
    extinction.resolve();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });
  const client = createMcpStdioClient({
    command: "fixture-mcp-proxy",
    env: {},
    clientInfo: { name: "stdio-client-test", version: "1" },
    protocolVersion: "2025-06-18",
    startupTimeoutMs: 10_000,
    maxPendingRequests: 4,
    maxFrameBytes: 1024,
    errors: {
      unavailable: (message, cause) => new Error(`unavailable: ${message}`, { cause }),
      protocol: (message, cause) => new Error(`protocol: ${message}`, { cause }),
    },
  });
  clients.push(client);
  return { client, child, stdin, messages, requested: requested.promise };
}

afterEach(async () => {
  for (const cleanup of childCleanups.splice(0)) {
    cleanup();
  }
  await Promise.allSettled(clients.splice(0).map((client) => client.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
  closeMock.mockReset();
});

describe("createMcpStdioClient", () => {
  it("classifies an incompatible initialize version as a fatal protocol error", async () => {
    const { client, child, messages } = createFixture("2024-11-05");
    await expect(client.request("tools/call", {}, { timeoutMs: 1000 })).rejects.toThrow(
      "protocol: proxy returned an incompatible protocol version",
    );
    expect(client.isAvailable()).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(
      messages.some(
        (message) => "method" in message && message.method === "notifications/initialized",
      ),
    ).toBe(false);
  });

  it("retires an SDK request timeout without writing a cancellation notification", async () => {
    const { client, child, messages, requested } = createFixture();
    await vi.waitFor(() => expect(client.isAvailable()).toBe(true));
    vi.useFakeTimers();
    const pending = client.request("tools/call", {}, { timeoutMs: 100 });
    const rejected = expect(pending).rejects.toThrow(
      "unavailable: tools/call timed out after 100ms",
    );
    await requested;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(client.isAvailable()).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(
      messages.some(
        (message) => "method" in message && message.method === "notifications/cancelled",
      ),
    ).toBe(false);
  });

  it("classifies a failed stdin write as fatal unavailability", async () => {
    const { client, child, stdin } = createFixture();
    await vi.waitFor(() => expect(client.isAvailable()).toBe(true));
    const failure = new Error("write EPIPE");
    vi.spyOn(stdin, "write").mockImplementation(
      (
        _data,
        encodingOrCallback: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        done?.(failure);
        return false;
      },
    );
    await expect(client.request("tools/call", {}, { timeoutMs: 1000 })).rejects.toMatchObject({
      message: "unavailable: proxy write failed",
      cause: failure,
    });
    expect(client.isAvailable()).toBe(false);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });
});
