/**
 * Regression test: Codex sandbox exec-server subprocess owners attach no-op
 * `error` listeners to child stdout/stderr so a broken pipe cannot surface as
 * a process-fatal unhandled EventEmitter `error`.
 *
 * Both the process RPC path (`processes.ts`) and the streaming HTTP path
 * (`http.ts`) spawn pipe-backed children. The tests capture the real spawned
 * child and deterministically emit `error` on stdout and stderr. With the
 * listeners in place the emit is swallowed and the bridge stays usable; if
 * either production listener is removed, `emit("error")` throws synchronously
 * (no `error` listener on the stream) and the test fails.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every child the exec-server spawns so tests can drive real stream
// errors on the exact stdout/stderr pipes the production listeners guard.
const { spawnedChildren } = vi.hoisted(() => ({
  spawnedChildren: [] as ChildProcessWithoutNullStreams[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawnedChildren.push(child as ChildProcessWithoutNullStreams);
      return child;
    },
  };
});

import type { CodexAppServerClient } from "./client.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  collectNotifications,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  readUntilClosed,
  rpc,
} from "./sandbox-exec-server.test-helpers.js";

const TMPDIR = process.env.TMPDIR ?? "/tmp";
const TMPDIR_URL = pathToFileURL(TMPDIR).href;
const WS_OPEN = 1;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Asserts the child stream still swallows a real `error` event after the fix. */
function expectStreamErrorSuppressed(
  stream: ChildProcessWithoutNullStreams["stdout"],
  label: string,
): void {
  // A no-op `error` listener must be attached by production code. Without it,
  // emitting `error` on a stream with no `error` listener throws.
  expect(stream.listenerCount("error"), `${label} has no error listener`).toBeGreaterThan(0);
  expect(
    () => stream.emit("error", new Error("EPIPE: simulated broken output pipe")),
    `${label} error event was not suppressed`,
  ).not.toThrow();
}

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

beforeEach(() => {
  spawnedChildren.length = 0;
});

describe("sandbox exec-server pipe survival", () => {
  it("process bridge suppresses stdout/stderr errors and keeps serving", async () => {
    const sandbox = createSandboxContext({
      buildExecSpec: async ({ command }) => ({
        argv: ["/bin/sh", "-c", `exec ${command}`],
        env: { PATH: process.env.PATH, TMPDIR },
        stdinMode: "pipe-closed" as const,
      }),
    });
    const client = createClient();
    const env = await ensureCodexSandboxExecServerEnvironment({
      client: client as unknown as CodexAppServerClient,
      sandbox,
    });
    expect(env).toBeDefined();
    const socket = await openSocket(execServerUrlFromClient(client));
    collectNotifications(socket);

    const processId = "pipe-srv-101";
    const SCRIPT = "process.stdout.write('ready\\n');setTimeout(function(){},300000)";
    const start = (await rpc(socket, "process/start", {
      processId,
      argv: [process.execPath, "-e", SCRIPT],
      cwd: TMPDIR_URL,
      tty: false,
      pipeStdin: false,
    })) as { processId: string };
    expect(start.processId).toBe(processId);

    // The spawned child's real pipes are the surface the production listeners
    // guard; emitting `error` here is the exact event the fix must swallow.
    const child = spawnedChildren.at(-1);
    expect(child).toBeDefined();
    expectStreamErrorSuppressed(child!.stdout, "process stdout");
    expectStreamErrorSuppressed(child!.stderr, "process stderr");
    expect(socket.readyState).toBe(WS_OPEN);

    await rpc(socket, "process/terminate", { processId });
    await delay(200);
    const read = await readUntilClosed(socket, processId);
    expect(read.closed).toBe(true);

    // The bridge must still accept and run follow-up work after the pipe error.
    const followId = "pipe-srv-102";
    await rpc(socket, "process/start", {
      processId: followId,
      argv: [process.execPath, "-e", "process.stdout.write('bridge-survived')"],
      cwd: TMPDIR_URL,
      tty: false,
      pipeStdin: false,
    });
    const follow = await readUntilClosed(socket, followId);
    const output = follow.chunks
      ?.map((c) => Buffer.from(c.chunk, "base64").toString("utf8"))
      .join("")
      .trim();
    expect(output).toBe("bridge-survived");
    socket.close();
  });

  it("streaming HTTP bridge suppresses stdout/stderr errors after headers", async () => {
    // The HTTP helper child emits one JSON `headers` line then stays alive, so
    // the streaming request resolves and the child pipes are still open when we
    // drive the error events.
    const HTTP_SCRIPT =
      "process.stdout.write(JSON.stringify({type:'headers',status:200,headers:[]})+'\\n');" +
      "setTimeout(function(){},300000)";
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [process.execPath, "-e", HTTP_SCRIPT],
        env: { PATH: process.env.PATH, TMPDIR },
        stdinMode: "pipe-closed" as const,
      }),
    });
    const client = createClient();
    const env = await ensureCodexSandboxExecServerEnvironment({
      client: client as unknown as CodexAppServerClient,
      sandbox,
    });
    expect(env).toBeDefined();
    const socket = await openSocket(execServerUrlFromClient(client));
    collectNotifications(socket);

    const response = (await rpc(socket, "http/request", {
      requestId: "http-pipe-1",
      method: "GET",
      url: "https://example.com/",
      streamResponse: true,
    })) as { status: number };
    expect(response.status).toBe(200);

    const child = spawnedChildren.at(-1);
    expect(child).toBeDefined();
    expectStreamErrorSuppressed(child!.stdout, "http stdout");
    expectStreamErrorSuppressed(child!.stderr, "http stderr");
    expect(socket.readyState).toBe(WS_OPEN);

    socket.close();
  });

  it("streaming HTTP request terminates after a pre-header stdout error and finalizes on close", async () => {
    // Child stays alive forever without emitting headers so the only way the
    // request settles is through the stream-error path. It ignores SIGTERM so
    // the test can prove termination is requested without finalizing before close.
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM',function(){});setTimeout(function(){},300000)",
        ],
        env: { PATH: process.env.PATH, TMPDIR },
        stdinMode: "pipe-closed" as const,
      }),
      finalizeExec,
    });
    const client = createClient();
    const env = await ensureCodexSandboxExecServerEnvironment({
      client: client as unknown as CodexAppServerClient,
      sandbox,
    });
    expect(env).toBeDefined();
    const socket = await openSocket(execServerUrlFromClient(client));
    collectNotifications(socket);

    const requestPromise = rpc(socket, "http/request", {
      requestId: "http-pipe-err-1",
      method: "GET",
      url: "https://example.com/",
      streamResponse: true,
    });

    // Wait for the spawned child so the readStreamingSandboxHttpResponse
    // listeners are attached.
    await delay(100);
    const child = spawnedChildren.at(-1);
    expect(child).toBeDefined();
    const kill = vi.spyOn(child!, "kill");

    // Emit a stdout error before headers; the fix must settle the request
    // through its guarded failure path instead of hanging, then terminate the helper.
    child!.stdout.emit("error", new Error("EPIPE: simulated broken output pipe"));

    await expect(requestPromise).rejects.toThrow("sandbox http/request output stream error");
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    // finalizeExec must NOT have been called yet: the child ignored SIGTERM and
    // close remains the only backend finalization owner.
    expect(finalizeExec).not.toHaveBeenCalled();

    // The WebSocket bridge must survive the settled failure.
    expect(socket.readyState).toBe(WS_OPEN);

    // Force the child closed; finalizeExec must be called exactly once
    // now that the child has actually exited.
    child!.kill("SIGKILL");
    await vi.waitFor(() => {
      expect(finalizeExec).toHaveBeenCalledTimes(1);
    });
    expect(finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    socket.close();
  });

  it("streaming HTTP request defers malformed-output finalization until child close", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM',function(){});process.stdout.write('not-json\\n');setTimeout(function(){},300000)",
        ],
        env: { PATH: process.env.PATH, TMPDIR },
        stdinMode: "pipe-closed" as const,
      }),
      finalizeExec,
    });
    const client = createClient();
    const env = await ensureCodexSandboxExecServerEnvironment({
      client: client as unknown as CodexAppServerClient,
      sandbox,
    });
    expect(env).toBeDefined();
    const socket = await openSocket(execServerUrlFromClient(client));
    collectNotifications(socket);

    const requestPromise = rpc(socket, "http/request", {
      requestId: "http-pipe-malformed-1",
      method: "GET",
      url: "https://example.com/",
      streamResponse: true,
    });

    await expect(requestPromise).rejects.toThrow();
    const child = spawnedChildren.at(-1);
    expect(child).toBeDefined();

    // Malformed stdout settles the request and asks the helper to terminate,
    // but close remains the only backend finalization owner.
    expect(finalizeExec).not.toHaveBeenCalled();

    child!.kill("SIGKILL");
    await vi.waitFor(() => {
      expect(finalizeExec).toHaveBeenCalledTimes(1);
    });
    expect(finalizeExec).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));

    socket.close();
  });
});
