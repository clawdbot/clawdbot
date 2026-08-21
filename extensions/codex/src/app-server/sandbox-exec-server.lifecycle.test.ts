// Codex tests cover sandbox exec-server child and backend lease lifecycle ordering.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => spawnMock(...args),
  };
});
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
  };
});

import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { httpRequest } from "./sandbox-exec-server/http.js";
import { startProcess, terminateProcess } from "./sandbox-exec-server/processes.js";
import { CodexSandboxExecSession } from "./sandbox-exec-server/session.js";
import type {
  CodexSandboxExecSessionNotifications,
  ManagedProcess,
  OpenClawExecServer,
} from "./sandbox-exec-server/types.js";

type FakeNotifications = CodexSandboxExecSessionNotifications & {
  send: ReturnType<typeof vi.fn<CodexSandboxExecSessionNotifications["send"]>>;
  close: () => void;
};

function createFakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42_424,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function createFakeNotifications(): FakeNotifications {
  const controller = new AbortController();
  return {
    send: vi.fn<CodexSandboxExecSessionNotifications["send"]>(),
    isOpen: () => !controller.signal.aborted,
    signal: controller.signal,
    close: () => controller.abort(),
  };
}

function createExecServer(sandbox: SandboxContext): OpenClawExecServer {
  return {
    sandbox,
    backend: sandbox.backend,
    fsBridge: sandbox.fsBridge,
    children: new Set(),
    cleanupTasks: new Set(),
  } as OpenClawExecServer;
}

function processStartParams(processId: string) {
  return {
    processId,
    argv: ["sh", "-lc", "true"],
    cwd: "file:///workspace",
    env: {},
    tty: false,
    pipeStdin: false,
    arg0: null,
  };
}

function streamingHttpParams(requestId: string) {
  return {
    requestId,
    method: "GET",
    url: "https://example.test/sse",
    streamResponse: true,
  };
}

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  killProcessTreeMock.mockReset();
});

describe("Codex sandbox exec-server lifecycle", () => {
  it("owns JSON-RPC delivery, ordered process notifications, and idempotent session cleanup", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-child"],
        env: {},
        finalizeToken: "session-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const send = vi.fn();
    const session = new CodexSandboxExecSession(createExecServer(sandbox), {
      send,
      isOpen: () => true,
    });

    await session.handleRequest({ id: 1, method: "initialize" });
    await session.handleRequest({ id: 2, method: "environment/status" });
    await session.handleRequest({ id: 3, method: "unsupported/method" });
    await session.handleRequest({
      id: 4,
      method: "process/start",
      params: processStartParams("direct-session"),
    });
    (child.stdout as PassThrough).write(Buffer.from("session-output"));
    child.emit("close", 0, null);
    await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());

    expect(send.mock.calls.map(([message]) => message)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { sessionId: expect.any(String) } },
      { jsonrpc: "2.0", id: 2, result: { status: "ready" } },
      {
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32601,
          message: "Unsupported OpenClaw sandbox exec-server method: unsupported/method",
        },
      },
      { jsonrpc: "2.0", id: 4, result: { processId: "direct-session" } },
      {
        jsonrpc: "2.0",
        method: "process/output",
        params: {
          processId: "direct-session",
          seq: 1,
          stream: "stdout",
          chunk: Buffer.from("session-output").toString("base64"),
        },
      },
      {
        jsonrpc: "2.0",
        method: "process/exited",
        params: { processId: "direct-session", seq: 2, exitCode: 0 },
      },
      {
        jsonrpc: "2.0",
        method: "process/closed",
        params: { processId: "direct-session", seq: 3 },
      },
    ]);
    const cleanup = session.close();
    expect(session.close()).toBe(cleanup);
    await cleanup;
    expect(finalizeExec).toHaveBeenCalledOnce();
  });

  it("reaps and finalizes a TERM-resistant child before acknowledging termination", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    let finishFinalize: (() => void) | undefined;
    const finalizeExec = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishFinalize = resolve;
        }),
    );
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-child"],
        env: {},
        finalizeToken: "terminate-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(sandbox),
      processes,
      createFakeNotifications().send,
      processStartParams("process-resistant"),
    );
    killProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });

    let settled = false;
    const termination = Promise.resolve(
      terminateProcess(processes, { processId: "process-resistant" }),
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);
    expect(killProcessTreeMock).toHaveBeenCalledWith(child.pid, {
      detached: process.platform !== "win32",
      graceMs: 1_000,
    });

    await vi.runOnlyPendingTimersAsync();
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    finishFinalize?.();
    await expect(termination).resolves.toEqual({ running: true });
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "completed",
      exitCode: 1,
      timedOut: false,
      token: "terminate-token",
    });
  });

  it("preserves cooperative TERM exit without force killing", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    killProcessTreeMock.mockImplementation(() => child.emit("close", 143, "SIGTERM"));
    const finalizeExec = vi.fn(async () => undefined);
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-child"],
            env: {},
            finalizeToken: "cooperative-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      processes,
      createFakeNotifications().send,
      processStartParams("process-cooperative"),
    );

    await expect(
      terminateProcess(processes, { processId: "process-cooperative" }),
    ).resolves.toEqual({ running: true });

    expect(killProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "completed",
      exitCode: 143,
      timedOut: false,
      token: "cooperative-token",
    });
  });

  it("shares termination and finalization across concurrent cleanup", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    killProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });
    const finalizeExec = vi.fn(async () => undefined);
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-child"],
            env: {},
            finalizeToken: "race-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      processes,
      createFakeNotifications().send,
      processStartParams("process-race"),
    );

    const first = terminateProcess(processes, { processId: "process-race" });
    const second = terminateProcess(processes, { processId: "process-race" });
    await vi.runOnlyPendingTimersAsync();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { running: true },
      { running: true },
    ]);
    expect(killProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledOnce();
  });

  it("reports a surviving tree instead of acknowledging termination", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    killProcessTreeMock.mockImplementation(() => undefined);
    const finalizeExec = vi.fn(async () => undefined);
    const processes = new Map<string, ManagedProcess>();
    await startProcess(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-child"],
            env: {},
            finalizeToken: "survivor-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      processes,
      createFakeNotifications().send,
      processStartParams("process-survivor"),
    );

    const termination = terminateProcess(processes, { processId: "process-survivor" });
    const rejection = expect(termination).rejects.toThrow(
      `Sandbox child process tree ${child.pid} survived SIGKILL; tear down the sandbox environment and inspect the surviving process tree before retrying.`,
    );
    await vi.advanceTimersByTimeAsync(4_500);

    await rejection;
    expect(finalizeExec).not.toHaveBeenCalled();
  });

  it("reaps a TERM-resistant streaming HTTP child on socket close", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    killProcessTreeMock.mockImplementation(() => {
      setTimeout(() => child.emit("close", null, "SIGKILL"), 1_000);
    });
    const finalizeExec = vi.fn(async () => undefined);
    const notifications = createFakeNotifications();
    const request = httpRequest(
      createExecServer(
        createSandboxContext({
          buildExecSpec: async () => ({
            argv: ["sandbox-http-child"],
            env: {},
            finalizeToken: "http-terminate-token",
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        }),
      ),
      notifications,
      streamingHttpParams("http-resistant"),
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ type: "headers", status: 200, headers: [] })}\n`,
    );
    await expect(request).resolves.toEqual({ status: 200, headers: [], bodyBase64: "" });

    notifications.close();
    await vi.runOnlyPendingTimersAsync();

    expect(killProcessTreeMock).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: 1,
      timedOut: false,
      token: "http-terminate-token",
    });
  });

  it("retains the process backend lease after child error until close", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-child"],
        env: {},
        finalizeToken: "process-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const notifications = createFakeNotifications();
    const processes = new Map<string, ManagedProcess>();

    await startProcess(
      createExecServer(sandbox),
      processes,
      notifications.send,
      processStartParams("process-error"),
    );
    child.emit("error", new Error("child transport failed"));

    expect(child.pid).toBe(42_424);
    expect(processes.get("process-error")).toMatchObject({
      closed: false,
      exited: false,
      failure: "child transport failed",
    });
    expect(finalizeExec).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();

    child.emit("close", 23, null);
    await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());

    expect(processes.get("process-error")).toMatchObject({
      closed: true,
      exited: true,
      exitCode: 23,
    });
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: 23,
      timedOut: false,
      token: "process-token",
    });
    expect(notifications.send.mock.calls.map(([method]) => method)).toEqual([
      "process/exited",
      "process/closed",
    ]);
  });

  it.each([
    { label: "an empty exec spec", argv: [] as string[], spawnError: null },
    { label: "a synchronous spawn failure", argv: ["sandbox-child"], spawnError: "spawn failed" },
  ])("finalizes process tokens after $label", async ({ argv, spawnError }) => {
    if (spawnError) {
      spawnMock.mockImplementationOnce(() => {
        throw new Error(spawnError);
      });
    }
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv,
        env: {},
        finalizeToken: "process-start-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });

    await expect(
      startProcess(
        createExecServer(sandbox),
        new Map(),
        createFakeNotifications().send,
        processStartParams("process-start-failure"),
      ),
    ).rejects.toThrow(spawnError ?? "did not provide a command");
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: "process-start-token",
    });
  });

  it("retains the streaming HTTP backend lease after child error until close", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: ["sandbox-http-child"],
        env: {},
        finalizeToken: "http-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const request = httpRequest(
      createExecServer(sandbox),
      createFakeNotifications(),
      streamingHttpParams("http-error"),
    );
    let settled = false;
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

    child.emit("error", new Error("HTTP child transport failed"));
    await Promise.resolve();

    expect(child.pid).toBe(42_424);
    expect(settled).toBe(false);
    expect(finalizeExec).not.toHaveBeenCalled();

    const rejection = expect(request).rejects.toThrow("HTTP child transport failed");
    child.emit("close", 29, null);
    await rejection;
    await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: 29,
      timedOut: false,
      token: "http-token",
    });
  });

  it.each([
    { label: "an empty exec spec", argv: [] as string[], spawnError: null },
    {
      label: "a synchronous spawn failure",
      argv: ["sandbox-http-child"],
      spawnError: "HTTP spawn failed",
    },
  ])("finalizes streaming HTTP tokens after $label", async ({ argv, spawnError }) => {
    if (spawnError) {
      spawnMock.mockImplementationOnce(() => {
        throw new Error(spawnError);
      });
    }
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv,
        env: {},
        finalizeToken: "http-start-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });

    await expect(
      httpRequest(
        createExecServer(sandbox),
        createFakeNotifications(),
        streamingHttpParams("http-start-failure"),
      ),
    ).rejects.toThrow(spawnError ?? "did not provide a command");
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "failed",
      exitCode: null,
      timedOut: false,
      token: "http-start-token",
    });
  });
});
