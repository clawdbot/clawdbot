// Codex tests cover sandbox exec-server child and backend lease lifecycle ordering.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => spawnMock(...args),
  };
});

import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { httpRequest } from "./sandbox-exec-server/http.js";
import { startProcess } from "./sandbox-exec-server/processes.js";
import type { ManagedProcess, OpenClawExecServer } from "./sandbox-exec-server/types.js";

type FakeSocket = WebSocket & { send: ReturnType<typeof vi.fn> };

function createFakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42_424,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function createFakeSocket(): FakeSocket {
  return Object.assign(new EventEmitter(), {
    readyState: 1,
    send: vi.fn(),
  }) as unknown as FakeSocket;
}

function createExecServer(sandbox: SandboxContext): OpenClawExecServer {
  return { sandbox } as OpenClawExecServer;
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
  spawnMock.mockReset();
});

describe("Codex sandbox exec-server lifecycle", () => {
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
    const socket = createFakeSocket();
    const processes = new Map<string, ManagedProcess>();

    await startProcess(
      createExecServer(sandbox),
      processes,
      socket,
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
    expect(socket.send).not.toHaveBeenCalled();

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
    expect(socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)).method)).toEqual([
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
        createFakeSocket(),
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
      createFakeSocket(),
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
        createFakeSocket(),
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
