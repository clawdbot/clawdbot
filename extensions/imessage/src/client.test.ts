// iMessage tests cover the RPC client child-process stream error handling.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// A dead imsg helper can emit an async `error` on any of its stdio streams. On
// a raw EventEmitter an unhandled `error` throws synchronously, which in the
// real gateway surfaces as an uncaughtException and crashes the process (#75438
// covered stdin only). The mock child mirrors that stdio shape so we can assert
// each stream's `error` is caught and routed to failAll.
type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & {
    write: (line: string, cb?: (err?: Error | null) => void) => boolean;
    end: () => void;
  };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const stdin = new EventEmitter() as MockChild["stdin"];
  // Resolve every write cleanly so the pending request only settles via the
  // stream error path under test.
  stdin.write = (_line, cb) => {
    cb?.(null);
    return true;
  };
  stdin.end = () => {};
  child.stdin = stdin;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe("IMessageRpcClient child stream error handling", () => {
  let child: MockChild;

  beforeEach(() => {
    // start() refuses to spawn under a test env; clear the markers so the real
    // spawn/listener wiring runs against the mock child.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    child = createMockChild();
    spawnMock.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(["stdout", "stderr", "stdin"] as const)(
    "catches a %s stream error and rejects in-flight requests instead of crashing",
    async (streamName) => {
      const { IMessageRpcClient } = await import("./client.js");
      const client = new IMessageRpcClient({ cliPath: "imsg" });
      await client.start();

      const pending = client.request("ping", {}, { timeoutMs: 0 });
      // Keep the rejection from surfacing as an unhandled rejection before we
      // assert on it.
      pending.catch(() => {});

      const streamError = new Error(`${streamName} broke`);
      expect(() => child[streamName].emit("error", streamError)).not.toThrow();

      await expect(pending).rejects.toThrow(`${streamName} broke`);
      await expect(client.waitForClose()).resolves.toBeUndefined();
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      await client.stop();
    },
  );

  it("settles the client after a real child stdout stream failure", async () => {
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realChild = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnMock.mockReturnValueOnce(realChild);
    const { IMessageRpcClient } = await import("./client.js");
    const client = new IMessageRpcClient({ cliPath: "imsg" });
    await client.start();

    try {
      const pending = client.request("ping", {}, { timeoutMs: 0 });
      pending.catch(() => {});
      realChild.stdout.destroy(new Error("real stdout failure"));

      await expect(pending).rejects.toThrow("real stdout failure");
      await expect(client.waitForClose()).resolves.toBeUndefined();
      expect(realChild.killed).toBe(true);
    } finally {
      if (!realChild.killed) {
        realChild.kill("SIGTERM");
      }
      await client.stop();
    }
  });

  it("promotes a complete Full Disk Access diagnostic", async () => {
    const { IMessageRpcClient } = await import("./client.js");
    const runtimeError = vi.fn();
    const client = new IMessageRpcClient({
      cliPath: "imsg",
      runtime: { error: runtimeError, exit: vi.fn(), log: vi.fn() },
    });
    await client.start();

    const pending = client.request("ping", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stderr.emit("data", Buffer.from("notice Full Disk Access denied for chat.db\n"));
    child.emit("close", 1, null);

    await expect(pending).rejects.toThrow(
      "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
    );
    expect(runtimeError).toHaveBeenCalledOnce();
    expect(runtimeError.mock.calls[0]?.[0]).not.toContain("�");
  });

  it("preserves a split UTF-8 Full Disk Access diagnostic from a real child", async () => {
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const script = `
      const prefix = Buffer.from("notice 猫 Full Disk Acc", "utf8");
      setTimeout(() => {
        process.stderr.write(prefix.subarray(0, 8));
        setTimeout(() => {
          process.stderr.write(prefix.subarray(8));
          setTimeout(() => {
            process.stderr.write("ess denied for chat.db");
            setTimeout(() => process.exit(1), 10);
          }, 10);
        }, 10);
      }, 50);
    `;
    const realChild = childProcess.spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnMock.mockReturnValueOnce(realChild);
    const { IMessageRpcClient } = await import("./client.js");
    const runtimeError = vi.fn();
    const client = new IMessageRpcClient({
      cliPath: "imsg",
      runtime: { error: runtimeError, exit: vi.fn(), log: vi.fn() },
    });
    await client.start();

    try {
      const pending = client.request("ping", {}, { timeoutMs: 0 });
      pending.catch(() => {});

      await expect(pending).rejects.toThrow(
        "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.",
      );
      expect(runtimeError).toHaveBeenCalledWith(
        "imsg rpc: notice 猫 Full Disk Access denied for chat.db",
      );
    } finally {
      if (!realChild.killed) {
        realChild.kill("SIGTERM");
      }
      await client.stop();
    }
  });

  it("keeps unrelated unterminated stderr on the generic close error path", async () => {
    const { IMessageRpcClient } = await import("./client.js");
    const runtimeError = vi.fn();
    const client = new IMessageRpcClient({
      cliPath: "imsg",
      runtime: { error: runtimeError, exit: vi.fn(), log: vi.fn() },
    });
    await client.start();

    const pending = client.request("ping", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stderr.emit("data", Buffer.from("unrelated warning"));
    child.emit("close", 1, null);

    await expect(pending).rejects.toThrow("imsg rpc exited (code 1)");
    expect(runtimeError).toHaveBeenCalledWith("imsg rpc: unrelated warning");
  });
});
