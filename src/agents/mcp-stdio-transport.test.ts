import { once } from "node:events";
// MCP framing and disposal preserve the spawn owner's independent cleanup receipt.
import fs from "node:fs/promises";
import { PassThrough, type Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { EmptyResultSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { OwnedStdioCleanupError, type OwnedStdioProcess } from "../process/owned-stdio.js";
import { disposeMcpClient } from "./mcp-client-lifecycle.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

const spawnMock = vi.hoisted(() => vi.fn());
const closeMock = vi.hoisted(() => vi.fn());
vi.mock("../process/owned-stdio.js", async (importOriginal) => {
  const { OwnedStdioCleanupError: CleanupError } =
    await importOriginal<typeof import("../process/owned-stdio.js")>();
  return {
    createOwnedStdioProcess: spawnMock,
    closeOwnedStdioProcess: closeMock,
    OwnedStdioCleanupError: CleanupError,
  };
});

const transports: OpenClawStdioClientTransport[] = [];
function createTransport(params: ConstructorParameters<typeof OpenClawStdioClientTransport>[0]) {
  const transport = new OpenClawStdioClientTransport(params);
  transports.push(transport);
  return transport;
}
const childCleanups: Array<() => void> = [];
function createChild() {
  const root = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const extinction = createDeferred();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let onError:
    | ((error: Error, source: "process" | "stdin" | "stdout" | "stderr") => void)
    | undefined;
  const child = {
    pid: 4321,
    stdin,
    supportsRawOutput: true,
    onStdout: (_decoded: (text: string) => void, raw?: (chunk: Buffer) => void) => {
      if (raw) {
        stdout.on("data", raw);
      }
    },
    onStderr: (_decoded: (text: string) => void, raw?: (chunk: Buffer) => void) => {
      if (raw) {
        stderr.on("data", raw);
      }
    },
    onExit: () => {},
    onError: (listener: NonNullable<typeof onError>) => {
      onError = listener;
    },
    wait: () => root.promise,
    waitForExtinction: () => extinction.promise,
    kill: vi.fn(),
    dispose: vi.fn(),
  };
  const fixture = {
    child,
    root,
    extinction,
    stdin,
    stdout,
    stderr,
    emitError: (error: Error) => onError?.(error, "stderr"),
  };
  childCleanups.push(() => {
    root.resolve({ code: 0, signal: null });
    extinction.resolve();
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  });
  spawnMock.mockImplementation(async ({ stderrDestination }: { stderrDestination?: Writable }) => {
    if (stderrDestination) {
      stderr.pipe(stderrDestination, { end: false });
    }
    return child;
  });
  return fixture;
}

beforeEach(() => {
  closeMock.mockImplementation(async (child: OwnedStdioProcess) => {
    await child.wait();
    await child.waitForExtinction?.();
  });
});
afterEach(async () => {
  for (const cleanup of childCleanups.splice(0)) {
    cleanup();
  }
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnMock.mockReset();
  closeMock.mockReset();
});

describe("OpenClawStdioClientTransport", () => {
  it("preserves the configured command, target environment and stderr stream", async () => {
    createChild();
    const transport = createTransport({
      command: "npx",
      args: ["-y", "example-mcp"],
      env: { EXAMPLE: "1" },
      cwd: "/tmp/example",
      stderr: "pipe",
    });
    await transport.start();
    expect(spawnMock).toHaveBeenCalledWith({
      argv: ["npx", "-y", "example-mcp"],
      cwd: "/tmp/example",
      env: expect.objectContaining({ EXAMPLE: "1" }),
      abortSignal: expect.any(AbortSignal),
      stderrDestination: transport.stderr,
    });
    expect(transport.pid).toBe(4321);
    expect(transport.stderr).toBeInstanceOf(PassThrough);
  });

  it("binds an exact environment without importing MCP default variables", async () => {
    createChild();
    await createTransport({
      command: "node",
      exactEnv: true,
      env: { ONLY: "1", OMIT: undefined },
    }).start();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ exactEnv: true, env: { ONLY: "1" } }),
    );
  });

  it("uses the caller's bounded decoder", async () => {
    const fixture = createChild();
    const transport = createTransport({
      command: "node",
      decoder: new ReadBuffer({ maxBufferSize: 8 }),
    });
    const onerror = vi.fn();
    Object.assign(transport, { onerror });
    await transport.start();
    fixture.stdout.write(Buffer.alloc(9, 0x20));
    expect(onerror).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "ReadBuffer exceeded maximum size of 8 bytes" }),
    );
  });

  it("retires SDK requests immediately while TERM cleanup still owns descendants", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node" });
    const received = vi.fn();
    Object.assign(transport, { onmessage: received });
    const client = new Client({ name: "stdio-ownership-test", version: "1" });
    const connecting = client.connect(transport);
    await vi.waitFor(() => expect(fixture.stdin.readableLength).toBeGreaterThan(0));
    const initialize = JSONRPCRequestSchema.parse(
      JSON.parse(fixture.stdin.read().toString("utf8")),
    );
    fixture.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initialize.id,
        result: {
          protocolVersion: initialize.params?.protocolVersion,
          capabilities: {},
          serverInfo: { name: "fixture", version: "1" },
        },
      }) + "\n",
    );
    await connecting;
    vi.useFakeTimers();
    const pending = client.request({ method: "ping" }, EmptyResultSchema, { timeout: 120_000 });
    const rejected = expect(pending).rejects.toThrow("Connection closed");
    const onexit = vi.fn();
    Object.assign(transport, { onexit });
    const closed = vi.fn();
    const closing = transport.terminate().then(closed);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await expect(transport.send({ jsonrpc: "2.0", id: 9, method: "ping" })).rejects.toThrow(
      "Not connected",
    );
    fixture.stdout.write('{"jsonrpc":"2.0","id":9,"result":{}}\n');
    expect(received).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    fixture.root.resolve({ code: null, signal: "SIGTERM" });
    await Promise.resolve();
    expect(onexit).toHaveBeenCalledExactlyOnceWith({ code: null, signal: "SIGTERM" });
    expect(closed).not.toHaveBeenCalled();
    fixture.extinction.resolve();
    await closing;
    expect(closed).toHaveBeenCalledOnce();
  });

  it("does not infer plugin data directory ownership from server environment", async () => {
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    createChild();
    await createTransport({
      command: "node",
      env: {
        PLUGIN_ROOT: "/plugin",
        PLUGIN_DATA: "/user-owned-file",
      },
    }).start();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it.each(["close", "forceClose"] as const)(
    "%s retires startup while its owned data directory is being prepared",
    async (closeMethod) => {
      const preparation = createDeferred<undefined>();
      vi.spyOn(fs, "mkdir").mockReturnValue(preparation.promise);
      createChild();
      const transport = createTransport({
        command: "node",
        prepareDataDir: "/owned-plugin-data",
      });
      const onclose = vi.fn();
      Object.assign(transport, { onclose });
      const started = transport.start();
      const closing = transport[closeMethod]();
      expect(onclose).not.toHaveBeenCalled();
      preparation.resolve(undefined);

      await expect(started).rejects.toThrow("closed");
      await closing;
      expect(spawnMock).not.toHaveBeenCalled();
      expect(onclose).toHaveBeenCalledOnce();
      await transport.close();
      await transport.forceClose();
      expect(onclose).toHaveBeenCalledOnce();
      await expect(transport.start()).rejects.toThrow("closed");
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("joins one disposal across root exit, repeated close and forced escalation", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node" });
    const onclose = vi.fn();
    Object.assign(transport, { onclose });
    await transport.start();
    const closing = transport.close();
    const settled = vi.fn();
    void closing.then(settled);
    expect(transport.close()).toBe(closing);
    expect(transport.forceClose()).toBe(closing);
    expect(fixture.child.kill).toHaveBeenCalledWith("SIGKILL");
    fixture.root.resolve({ code: 0, signal: null });
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    expect(transport.pid).toBe(4321);
    fixture.extinction.resolve();
    await closing;
    expect(closeMock).toHaveBeenCalledOnce();
    expect(transport.pid).toBeNull();
    await transport.forceClose();
    await transport.close();
    expect(fixture.child.kill).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("keeps failed owner cleanup uncertain through repeated disposal", async () => {
    const fixture = createChild();
    const failure = new Error("cleanup owner lost");
    const cleanupScope = createAgentCleanupScope();
    const transport = createTransport({ command: "node" });
    await transport.start();
    const closing = transport.close();
    fixture.root.resolve({ code: 0, signal: null });
    fixture.extinction.reject(failure);
    await expect(closing).rejects.toBe(failure);
    await cleanupScope.run(async () => {
      await expect(
        disposeMcpClient({
          transport,
          transportType: "stdio",
          client: { close: () => transport.close() },
        }),
      ).resolves.toBe("uncertain");
      await expect(transport.close()).rejects.toBe(failure);
    });
    expect(cleanupScope.outcome).toBe("uncertain");
  });

  it.each([
    { confirmed: true, outcome: "closed" },
    { confirmed: false, outcome: "uncertain" },
  ] as const)(
    "reports $outcome when forced shutdown confirmation is $confirmed",
    async ({ confirmed, outcome }) => {
      vi.useFakeTimers();
      const fixture = createChild();
      fixture.child.kill.mockImplementation(() => {
        if (confirmed) {
          fixture.root.resolve({ code: null, signal: "SIGKILL" });
          fixture.extinction.resolve();
        }
      });
      const transport = createTransport({ command: "node" });
      await transport.start();
      const cleanupScope = createAgentCleanupScope();
      const disposal = cleanupScope.run(() =>
        disposeMcpClient(
          {
            transport,
            transportType: "stdio",
            client: { close: () => transport.close() },
          },
          50,
        ),
      );
      await vi.advanceTimersByTimeAsync(100);
      await expect(disposal).resolves.toBe(outcome);
      expect(cleanupScope.outcome).toBe(outcome);
    },
  );

  it("cancels pending startup and replays its failed cleanup to later disposal", async () => {
    const failure = new OwnedStdioCleanupError("startup owner lost", {
      cause: new Error("MCP startup aborted"),
    });
    spawnMock.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(failure), { once: true });
        }),
    );
    const transport = createTransport({ command: "node" });
    const startup = transport.start().catch((error: unknown) => error);
    await expect(transport.forceClose()).rejects.toBe(failure);
    expect(await startup).toBe(failure);
    expect(transport.pid).toBeNull();

    const cleanupScope = createAgentCleanupScope();
    await cleanupScope.run(async () => {
      await expect(transport.close()).rejects.toBe(failure);
    });
    expect(cleanupScope.outcome).toBe("uncertain");
  });

  it("sends and receives JSON-RPC while preserving fragmented UTF-8 bytes", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node" });
    const onmessage = vi.fn();
    Object.assign(transport, { onmessage });
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(fixture.stdin.read()?.toString()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const message = { jsonrpc: "2.0", id: 1, result: { text: "🦞" } };
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    const split = bytes.indexOf(Buffer.from("🦞")) + 1;
    fixture.stdout.write(bytes.subarray(0, split));
    fixture.stdout.write(bytes.subarray(split));
    expect(onmessage).toHaveBeenCalledWith(message);
  });

  it.each(["callback", "throw"])("rejects failed stdin writes through %s", async (mode) => {
    const fixture = createChild();
    const failure = new Error("write EPIPE");
    vi.spyOn(fixture.stdin, "write").mockImplementation(
      (
        _data,
        encodingOrCallback: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) => {
        if (mode === "throw") {
          throw failure;
        }
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        done?.(failure);
        return false;
      },
    );
    const transport = createTransport({ command: "node" });
    await transport.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toBe(failure);
  });

  it("forwards owner stream errors and retains stderr diagnostics", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node", stderr: "pipe" });
    const onerror = vi.fn();
    Object.assign(transport, { onerror });
    await transport.start();
    const failure = new Error("simulated pipe failure");
    fixture.emitError(failure);
    fixture.stderr.write("server diagnostic");
    expect(onerror).toHaveBeenCalledWith(failure);
    expect(transport.stderr?.read()?.toString()).toBe("server diagnostic");
  });

  it("backpressures unread stderr and delivers every byte when the reader resumes", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node", stderr: "pipe" });
    await transport.start();
    const destination = transport.stderr!;
    const chunk = Buffer.alloc(16 * 1024, 0xad);
    let completed = false;
    const writing = (async () => {
      for (let index = 0; index < 64; index += 1) {
        if (!fixture.stderr.write(chunk)) {
          await once(fixture.stderr, "drain");
        }
      }
      completed = true;
    })();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(completed).toBe(false);
    expect(destination.readableLength + destination.writableLength).toBeLessThanOrEqual(
      4 * destination.writableHighWaterMark,
    );
    const received: Buffer[] = [];
    destination.on("data", (data: Buffer) => received.push(data));
    await writing;
    fixture.root.resolve({ code: 0, signal: null });
    fixture.extinction.resolve();
    await transport.close();
    expect(Buffer.concat(received)).toEqual(Buffer.alloc(chunk.length * 64, 0xad));
  });

  it("keeps default malformed-frame recovery when the caller does not retire", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node" });
    const onerror = vi.fn();
    const onmessage = vi.fn();
    Object.assign(transport, { onerror, onmessage });
    await transport.start();
    fixture.stdout.write('invalid\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(onerror).toHaveBeenCalledOnce();
    expect(onmessage).toHaveBeenCalledExactlyOnceWith({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("reports an oversized stdout frame without an unhandled error crash", async () => {
    const fixture = createChild();
    const transport = createTransport({ command: "node" });
    const onerror = vi.fn();
    Object.assign(transport, { onerror });
    await transport.start();
    expect(() => fixture.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x20))).not.toThrow();
    expect(onerror).toHaveBeenCalledOnce();
    expect(onerror.mock.calls[0]?.[0].message).toMatch(/exceeded maximum size/);
  });
});
