import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessagePrivateApiStatus } from "./private-api-status.js";

const spawnMock = vi.hoisted(() => vi.fn());
const runIMessageCliJsonCommandMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./cli-output.js", () => ({
  runIMessageCliJsonCommand: runIMessageCliJsonCommandMock,
}));

// A dead imsg helper can emit an async `error` on any of its stdio streams. On
// a raw EventEmitter an unhandled `error` throws synchronously, which in the
// real gateway surfaces as an uncaughtException and crashes the process (#75438
// covered stdin only). The mock child mirrors that stdio shape so we can assert
// each stream's `error` is caught and routed to failAll.
type MockStream = EventEmitter & { errored: Error | null };
type MockChild = EventEmitter & {
  stdout: MockStream;
  stderr: MockStream;
  stdin: MockStream & {
    write: (line: string, cb?: (err?: Error | null) => void) => boolean;
    end: () => void;
  };
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = Object.assign(new EventEmitter(), { errored: null });
  child.stderr = Object.assign(new EventEmitter(), { errored: null });
  const stdin = Object.assign(new EventEmitter(), { errored: null }) as MockChild["stdin"];
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

let IMessageRpcClient: typeof import("./client.js").IMessageRpcClient;
let IMessageRpcRequestError: typeof import("./client.js").IMessageRpcRequestError;
let privateApiStatus: typeof import("./private-api-status.js");

beforeAll(async () => {
  vi.resetModules();
  ({ IMessageRpcClient, IMessageRpcRequestError } = await import("./client.js"));
  // Imported after resetModules so this is the same module instance the client
  // mutates; a separate copy would hold a different cache map.
  privateApiStatus = await import("./private-api-status.js");
});

afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("./cli-output.js");
  vi.resetModules();
});

describe("IMessageRpcClient child stream error handling", () => {
  let child: MockChild;
  const tempDirs: string[] = [];

  beforeEach(() => {
    // start() refuses to spawn under a test env; clear the markers so the real
    // spawn/listener wiring runs against the mock child.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    child = createMockChild();
    spawnMock.mockReset().mockReturnValue(child);
    runIMessageCliJsonCommandMock.mockReset().mockResolvedValue({ status: "launched" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it.each(
    (["stdout", "stderr", "stdin"] as const).flatMap((streamName) =>
      (["error event then close", "errored close only"] as const).map((notification) => ({
        streamName,
        notification,
      })),
    ),
  )(
    "catches a $streamName stream error via $notification and rejects in-flight requests instead of crashing",
    async ({ streamName, notification }) => {
      const client = new IMessageRpcClient({ cliPath: "imsg" });
      await client.start();

      const pending = client.request("ping", {}, { timeoutMs: 0 });
      // Keep the rejection from surfacing as an unhandled rejection before we
      // assert on it.
      pending.catch(() => {});

      const streamError = new Error(`${streamName} broke`);
      child[streamName].errored = streamError;
      try {
        expect(() => {
          if (notification === "error event then close") {
            child[streamName].emit("error", streamError);
          }
          child[streamName].emit("close");
        }).not.toThrow();
        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        await expect(pending).rejects.toThrow(`${streamName} broke`);
        await expect(client.waitForClose()).rejects.toThrow(`${streamName} broke`);
      } finally {
        child.emit("close", null, "SIGTERM");
        await client.stop();
      }
    },
  );

  it("propagates a synchronous stdin write failure as a terminal transport error", async () => {
    const writeError = new Error("write after end");
    child.stdin.write = () => {
      throw writeError;
    };
    const client = new IMessageRpcClient({ cliPath: "imsg" });
    await client.start();

    await expect(client.request("ping", {}, { timeoutMs: 0 })).rejects.toBe(writeError);
    await expect(client.waitForClose()).rejects.toBe(writeError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null, "SIGTERM");
    await client.stop();
  });

  it("preserves structured JSON-RPC error data for send callers", async () => {
    const client = new IMessageRpcClient({ cliPath: "imsg" });
    await client.start();
    const data = {
      retry_safe: true,
      disposition: "not_started",
      transport: "bridge_v2",
      operation: "send-message",
    };

    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "Delivery failed before dispatch",
            data,
          },
        })}\n`,
      ),
    );

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IMessageRpcRequestError);
    expect(error).toMatchObject({
      name: "IMessageRpcRequestError",
      code: -32603,
      data,
      message:
        'Delivery failed before dispatch: code=-32603 {\n  "retry_safe": true,\n  "disposition": "not_started",\n  "transport": "bridge_v2",\n  "operation": "send-message"\n}',
    });

    child.emit("close", 0, null);
    await client.stop();
  });

  it("finishes graceful shutdown without scheduling escalation after synchronous close", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const client = new IMessageRpcClient({ cliPath: "imsg" });
    await client.start();
    const endMock = vi.fn(() => {
      child.emit("close", 0, null);
    });
    child.stdin.end = endMock;

    await client.stop();

    expect(endMock).toHaveBeenCalledOnce();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("escalates EOF to SIGTERM and SIGKILL, then waits for close", async () => {
    vi.useFakeTimers();
    const client = new IMessageRpcClient({ cliPath: "imsg" });
    await client.start();
    child.stdin.end = vi.fn();
    child.kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      }
      return true;
    });

    const stopping = client.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(500);
    await stopping;

    expect(child.kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
    vi.useRealTimers();
  });

  it("settles the client after a real child stdout stream failure", async () => {
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realChild = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    spawnMock.mockReturnValueOnce(realChild);
    const client = new IMessageRpcClient({ cliPath: "imsg" });
    await client.start();

    try {
      const pending = client.request("ping", {}, { timeoutMs: 0 });
      pending.catch(() => {});
      realChild.stdout.destroy(new Error("real stdout failure"));

      await expect(pending).rejects.toThrow("real stdout failure");
      await expect(client.waitForClose()).rejects.toThrow("real stdout failure");
      expect(realChild.killed).toBe(true);
    } finally {
      if (!realChild.killed) {
        realChild.kill("SIGTERM");
      }
      await client.stop();
    }
  });

  it("promotes a complete Full Disk Access diagnostic", async () => {
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
    const runtimeError = vi.fn();
    const client = new IMessageRpcClient({
      cliPath: "imsg",
      runtime: { error: runtimeError, exit: vi.fn(), log: vi.fn() },
    });
    await client.start();

    const pending = client.request("ping", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stderr.emit("data", Buffer.from("unrelated warning"));
    child.stderr.emit("close");
    child.emit("close", 1, null);

    await expect(pending).rejects.toThrow("imsg rpc exited (code 1)");
    await expect(client.waitForClose()).rejects.toThrow("imsg rpc exited (code 1)");
    expect(runtimeError).toHaveBeenCalledWith("imsg rpc: unrelated warning");
  });

  it("expands cliPath locally while preserving remote dbPath and JSON data", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-rpc-boundary-"));
    tempDirs.push(root);
    const wrapperDir = path.join(root, ".openclaw");
    const wrapperPath = path.join(wrapperDir, "imsg remote");
    const reportPath = path.join(root, "rpc-report.jsonl");
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(
      wrapperPath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const reportPath = ${JSON.stringify(reportPath)};`,
        'let buffered = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => {',
        "  buffered += chunk;",
        '  let newline = buffered.indexOf("\\n");',
        "  while (newline !== -1) {",
        "    const line = buffered.slice(0, newline);",
        "    buffered = buffered.slice(newline + 1);",
        "    const request = JSON.parse(line);",
        '    fs.appendFileSync(reportPath, JSON.stringify({ args: process.argv.slice(2), request }) + "\\n");',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: request.params }) + "\\n");',
        '    newline = buffered.indexOf("\\n");',
        "  }",
        "});",
      ].join("\n"),
      { mode: 0o700 },
    );
    vi.stubEnv("HOME", root);
    const childProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementationOnce((command, args, options) =>
      childProcess.spawn(command, args, options),
    );
    const client = new IMessageRpcClient({
      cliPath: "~/.openclaw/imsg remote",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "messages-mac",
    });
    await client.start();
    const params = {
      text: `spaces ; $(touch ${path.join(root, "should-not-exist")}) ' " & |`,
      to: "person name@example.test",
    };

    await expect(client.request("send", params)).resolves.toEqual(params);
    await client.stop();

    const records = (await fs.readFile(reportPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; request: Record<string, unknown> });
    expect(records).toHaveLength(1);
    expect(records[0]?.args).toEqual(["rpc", "--json", "--db", "~/Library/Messages/chat.db"]);
    expect(records[0]?.request).toMatchObject({ method: "send", params });
    await expect(fs.access(path.join(root, "should-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps local dbPath home expansion", async () => {
    vi.stubEnv("HOME", "/Users/gateway");
    const client = new IMessageRpcClient({
      cliPath: "~/.openclaw/imsg-local",
      dbPath: "~/Library/Messages/chat.db",
    });

    await client.start();

    expect(spawnMock).toHaveBeenCalledWith(
      "/Users/gateway/.openclaw/imsg-local",
      ["rpc", "--json", "--db", "/Users/gateway/Library/Messages/chat.db"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.emit("close", 0, null);
    await client.stop();
  });
});

describe("IMessageRpcClient bridge-stall cache invalidation", () => {
  let child: MockChild;

  // Not `as const`: rpcMethods would widen to `readonly []`, which is not
  // assignable to the mutable string[] on IMessagePrivateApiStatus.
  const seeded: IMessagePrivateApiStatus = {
    available: true,
    v2Ready: true,
    selectors: {},
    rpcMethods: [],
  };

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");
    child = createMockChild();
    spawnMock.mockReset().mockReturnValue(child);
    runIMessageCliJsonCommandMock.mockReset().mockResolvedValue({ status: "launched" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // A successful probe is cached with expiresAt=0 and therefore never expires.
  // Before this path existed, a bridge that wedged after that probe was never
  // re-evaluated: Messages.app stayed alive with the dylib mapped, so nothing
  // else could notice, and every later send was dispatched into a dead bridge
  // and failed with an opaque -32603 instead of the actionable
  // "run imsg launch" guidance. Dropping the entry here makes the next action
  // re-probe. This test fails without the invalidation in request().
  it("discards the cached verdict when imsg reports its own wait timeout", async () => {
    const cliPath = "/tmp/imsg-stall-invalidation";
    privateApiStatus.setCachedIMessagePrivateApiStatus(cliPath, { ...seeded });
    expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)?.available).toBe(true);

    const client = new IMessageRpcClient({ cliPath });
    await client.start();
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "Timed out waiting for response to 'send-message'",
          },
        })}\n`,
      ),
    );

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IMessageRpcRequestError);
    expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)).toBeUndefined();
    expect(runIMessageCliJsonCommandMock).toHaveBeenCalledWith({
      cliPath,
      args: ["launch"],
      timeoutMs: 30_000,
    });

    child.emit("close", 0, null);
    await client.stop();
  });

  it("logs recovery failure while preserving the original structured error", async () => {
    const recoveryError = new Error("launch stderr stream failed");
    const runtimeError = vi.fn();
    runIMessageCliJsonCommandMock.mockRejectedValueOnce(recoveryError);
    const client = new IMessageRpcClient({
      cliPath: "/tmp/imsg-stall-recovery-failure",
      runtime: { error: runtimeError, exit: vi.fn(), log: vi.fn() },
    });
    await client.start();
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "Timed out waiting for response to 'send-message'",
            data: { disposition: "may_have_completed", retry_safe: false },
          },
        })}\n`,
      ),
    );

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IMessageRpcRequestError);
    if (!(error instanceof IMessageRpcRequestError)) {
      throw new Error("expected an IMessageRpcRequestError");
    }
    expect(error).toMatchObject({
      code: -32603,
      data: { disposition: "may_have_completed", retry_safe: false },
    });
    expect(error.message).toContain("Timed out waiting for response to 'send-message'");
    expect(runtimeError).toHaveBeenCalledWith(
      "imessage: automatic bridge recovery failed: launch stderr stream failed",
    );

    child.emit("close", 0, null);
    await client.stop();
  });

  // actions.ts caches the probe under the raw `account.config.cliPath` and
  // hands that same unexpanded string to this client, which then expands it for
  // spawning. Invalidating under the expanded path would miss the entry for any
  // `~`-relative cliPath and silently do nothing, which is the exact failure
  // mode this change exists to remove.
  it("invalidates under the configured cli path, not the expanded one", async () => {
    const cliPath = "~/imsg-stall-tilde/imsg";
    privateApiStatus.setCachedIMessagePrivateApiStatus(cliPath, { ...seeded });

    const client = new IMessageRpcClient({ cliPath });
    await client.start();
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "Timed out waiting for response to 'send-message'",
          },
        })}\n`,
      ),
    );

    await pending.catch((cause: unknown) => cause);
    expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)).toBeUndefined();

    child.emit("close", 0, null);
    await client.stop();
  });

  // Normal outbound sends never read the private-API cache (send.ts builds a
  // client and dispatches directly), so eviction alone would leave them
  // repeating an opaque -32603. The decorated message is what reaches the
  // operator on the very first failed send.
  it("appends actionable guidance to a stalled send", async () => {
    const client = new IMessageRpcClient({ cliPath: "/tmp/imsg-stall-guidance" });
    await client.start();
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "Timed out waiting for response to 'send-message'",
            data: { disposition: "not_started", retry_safe: true },
          },
        })}\n`,
      ),
    );

    const error = (await pending.catch((cause: unknown) => cause)) as Error;
    expect(error.message).toContain("Timed out waiting for response to 'send-message'");
    expect(error.message).toContain("imsg launch");
    expect(error.message).toContain("channels status --probe");
    // send.ts reconciles delayed sends off these, so decorating must not drop
    // the class, code, or data.
    expect(error).toBeInstanceOf(IMessageRpcRequestError);
    expect(error).toMatchObject({
      code: -32603,
      data: { disposition: "not_started", retry_safe: true },
    });

    child.emit("close", 0, null);
    await client.stop();
  });

  // A client-side timeout means our wrapper gave up, not that the bridge is
  // dead, so it is left completely alone: no eviction, no `imsg launch`
  // guidance, and the exact wording send.ts matches with
  // /imsg rpc timeout \(send\)/i preserved.
  it("leaves a client-side timeout undecorated", async () => {
    vi.useFakeTimers();
    const client = new IMessageRpcClient({ cliPath: "/tmp/imsg-stall-clienttimeout" });
    await client.start();
    const pending = client.request("send", {}, { timeoutMs: 10 });
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(20);

    const error = (await pending.catch((cause: unknown) => cause)) as Error;
    vi.useRealTimers();
    expect(/imsg rpc timeout \(send\)/i.test(error.message)).toBe(true);
    expect(error.message).not.toContain("imsg launch");

    child.emit("close", 0, null);
    await client.stop();
  });

  // The cache is what keeps the bridge off the hot path, so an ordinary
  // rejection must not cost every later send a re-probe.
  it("keeps the cached verdict when the request is merely rejected", async () => {
    const cliPath = "/tmp/imsg-stall-preserved";
    privateApiStatus.setCachedIMessagePrivateApiStatus(cliPath, { ...seeded });

    const client = new IMessageRpcClient({ cliPath });
    await client.start();
    const pending = client.request("send", {}, { timeoutMs: 0 });
    pending.catch(() => {});
    child.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32602,
            message: 'Unknown target "nobody" for iMessage',
          },
        })}\n`,
      ),
    );

    await pending.catch((cause: unknown) => cause);
    expect(privateApiStatus.getCachedIMessagePrivateApiStatus(cliPath)?.available).toBe(true);

    child.emit("close", 0, null);
    await client.stop();
    privateApiStatus.invalidateCachedIMessagePrivateApiStatus(cliPath);
  });
});
