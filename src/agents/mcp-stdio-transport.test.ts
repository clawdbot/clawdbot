import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    const { OpenClawStdioClientTransport } = await import("./mcp-stdio-transport.js");

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

    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
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
    expect(options).toEqual(
      expect.objectContaining({
        cwd: "/tmp/example",
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(options.env).toEqual(expect.objectContaining({ EXAMPLE: "1" }));
    expect(transport.pid).toBe(4321);
    expect(transport.stderr).toBeInstanceOf(PassThrough);
  });

  it("kills the process tree when graceful stdio close does not exit", async () => {
    vi.useFakeTimers();
    const child = new MockChildProcess();
    spawnMock.mockReturnValue(child);
    const { OpenClawStdioClientTransport } = await import("./mcp-stdio-transport.js");

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
    const { OpenClawStdioClientTransport } = await import("./mcp-stdio-transport.js");

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
    const { OpenClawStdioClientTransport } = await import("./mcp-stdio-transport.js");

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
});
