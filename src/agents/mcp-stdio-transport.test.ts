import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));

vi.mock("../process/kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

class MockChildProcess extends EventEmitter {
  exitCode: number | null = null;
  pid = 4321;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
}

describe("OpenClawStdioClientTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  it("starts stdio MCP servers in a disposable process group on POSIX", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const transport = new OpenClawStdioClientTransport({
      command: "npx",
      args: ["-y", "example-mcp"],
      env: { EXAMPLE: "1" },
      cwd: "/tmp/example",
      stderr: "pipe",
    });
    const started = transport.start();
    child.emit("spawn");
    await started;

    const [command, args, options] = spawnMock.mock.calls.at(0) as [string, string[], SpawnOptions];
    if (process.platform === "linux") {
      expect(command).toBe("/bin/sh");
      expect(args).toEqual([
        "-c",
        'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"',
        "npx",
        "-y",
        "example-mcp",
      ]);
    } else {
      expect(command).toBe("npx");
      expect(args).toEqual(["-y", "example-mcp"]);
    }
    expect(options.cwd).toBe("/tmp/example");
    expect(options.detached).toBe(process.platform !== "win32");
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.env?.EXAMPLE).toBe("1");
    expect(transport.pid).toBe(4321);
    expect(transport.stderr).toBeInstanceOf(PassThrough);
  });

  it("kills the process tree when graceful stdio close does not exit", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const transport = new OpenClawStdioClientTransport({ command: "npx" });
    const started = transport.start();
    child.emit("spawn");
    await started;

    const closing = transport.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(killProcessTreeMock).toHaveBeenCalledWith(4321);

    child.exitCode = 0;
    child.emit("close", 0);
    await closing;
  });

  it("does not kill the process tree when graceful stdio close exits", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const transport = new OpenClawStdioClientTransport({ command: "npx" });
    const started = transport.start();
    child.emit("spawn");
    await started;

    const closing = transport.close();
    child.exitCode = 0;
    child.emit("close", 0);
    await closing;

    expect(killProcessTreeMock).not.toHaveBeenCalled();
  });

  it("sends and receives JSON-RPC messages over stdio", async () => {
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);

    const transport = new OpenClawStdioClientTransport({ command: "npx" });
    const onmessage = vi.fn();
    Object.assign(transport, { onmessage });
    const started = transport.start();
    child.emit("spawn");
    await started;

    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(child.stdin.read()?.toString()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');

    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(onmessage).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });

  it("rejects send() with EPIPE when child stdin is closed (#75438)", async () => {
    const child = new MockChildProcess();
    const brokenStdin = new PassThrough();
    brokenStdin.write = (_chunk: unknown, cbOrEncoding?: unknown, cb?: unknown) => {
      const callback =
        typeof cbOrEncoding === "function" ? cbOrEncoding : typeof cb === "function" ? cb : null;
      const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      if (callback) {
        (callback as (err: Error) => void)(err);
      }
      return false;
    };
    child.stdin = brokenStdin;
    spawnMock.mockReturnValue(child);

    const transport = new OpenClawStdioClientTransport({ command: "npx" });
    const started = transport.start();
    child.emit("spawn");
    await started;

    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow(
      "EPIPE",
    );
  });

  it("rejects send() when stdin.write throws synchronously (#75438)", async () => {
    const child = new MockChildProcess();
    const brokenStdin = new PassThrough();
    brokenStdin.write = () => {
      throw Object.assign(new Error("write after end"), { code: "ERR_STREAM_DESTROYED" });
    };
    child.stdin = brokenStdin;
    spawnMock.mockReturnValue(child);

    const transport = new OpenClawStdioClientTransport({ command: "npx" });
    const started = transport.start();
    child.emit("spawn");
    await started;

    await expect(transport.send({ jsonrpc: "2.0", id: 3, method: "ping" })).rejects.toThrow(
      "write after end",
    );
  });
});
