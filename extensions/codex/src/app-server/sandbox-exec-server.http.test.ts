// Codex tests cover sandbox exec server.http plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  collectNotifications,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  rpc,
  waitForHttpBodyDeltas,
} from "./sandbox-exec-server.test-helpers.js";
const SANDBOX_HTTP_STREAM_LINE_MAX_CHARS = 256 * 1024;

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandboxExecServerRegistry.closeAll();
});

function testExecEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
  };
}

async function openSandboxHttpSocket(sandbox: ReturnType<typeof createSandboxContext>) {
  const client = createClient();
  await ensureCodexSandboxExecServerEnvironment({
    client: client as never,
    sandbox,
  });
  return openSocket(execServerUrlFromClient(client));
}

function splitUtf8ChildScript(params: {
  stream: "stdout" | "stderr";
  value: string;
  stdoutPrefix?: string;
  exitCode?: number;
}): string {
  const target = `process.${params.stream}`;
  const finish =
    params.exitCode === undefined
      ? `${target}.end(rest);`
      : `${target}.write(rest, () => process.exit(${params.exitCode}));`;
  return [
    `const value = Buffer.from(${JSON.stringify(params.value)});`,
    'const marker = Buffer.from("猫");',
    "const splitAt = value.indexOf(marker) + 1;",
    ...(params.stdoutPrefix
      ? [`process.stdout.write(${JSON.stringify(params.stdoutPrefix)});`]
      : []),
    `${target}.write(value.subarray(0, splitAt));`,
    "setTimeout(() => {",
    "  const rest = value.subarray(splitAt);",
    `  ${finish}`,
    "}, 25);",
  ].join("\n");
}

describe("OpenClaw Codex sandbox exec-server HTTP", () => {
  it("routes HTTP requests through the sandbox backend", async () => {
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.from(
        JSON.stringify({
          status: 201,
          headers: [{ name: "content-type", value: "text/plain" }],
          bodyBase64: Buffer.from("sandbox-http").toString("base64"),
        }),
      ),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({ runShellCommand });
    const socket = await openSandboxHttpSocket(sandbox);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-1",
        method: "POST",
        url: "https://example.test/mcp",
        headers: [{ name: "authorization", value: "Bearer test" }],
        bodyBase64: Buffer.from("body").toString("base64"),
      }),
    ).resolves.toEqual({
      status: 201,
      headers: [{ name: "content-type", value: "text/plain" }],
      bodyBase64: Buffer.from("sandbox-http").toString("base64"),
    });
    expect(runShellCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        allowFailure: true,
        stdin: expect.stringContaining("https://example.test/mcp"),
      }),
    );
    socket.close();
  });

  it("blocks private HTTP targets before starting the sandbox backend", async () => {
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({ runShellCommand });
    const socket = await openSandboxHttpSocket(sandbox);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-private",
        method: "GET",
        url: "http://127.0.0.1:6379/",
      }),
    ).rejects.toThrow("Blocked hostname or private/internal IP");
    expect(runShellCommand).not.toHaveBeenCalled();
    socket.close();
  });

  it("blocks metadata HTTP targets before starting the streaming sandbox backend", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const socket = await openSandboxHttpSocket(sandbox);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-metadata",
        method: "GET",
        url: "http://metadata.google.internal/",
        streamResponse: true,
      }),
    ).rejects.toThrow("Blocked hostname or private/internal IP");
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it("streams HTTP response body deltas from the sandbox backend", async () => {
    const headerLine = JSON.stringify({
      type: "headers",
      status: 202,
      headers: [{ name: "content-type", value: "text/event-stream" }],
    });
    const bodyLine = JSON.stringify({
      type: "bodyDelta",
      seq: 1,
      deltaBase64: Buffer.from("event: ok\n\n").toString("base64"),
      done: false,
    });
    const doneLine = JSON.stringify({
      type: "bodyDelta",
      seq: 2,
      deltaBase64: "",
      done: true,
    });
    const buildExecSpec = vi.fn(async () => ({
      argv: [
        process.execPath,
        "-e",
        [headerLine, bodyLine, doneLine]
          .map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`)
          .join(""),
      ],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const runShellCommand = vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    }));
    const sandbox = createSandboxContext({ buildExecSpec, runShellCommand });
    const socket = await openSandboxHttpSocket(sandbox);
    const notifications = collectNotifications(socket);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-stream",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).resolves.toEqual({
      status: 202,
      headers: [{ name: "content-type", value: "text/event-stream" }],
      bodyBase64: "",
    });
    const deltas = await waitForHttpBodyDeltas(notifications, 2);

    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringContaining("python3"),
        usePty: false,
        workdir: "/workspace",
      }),
    );
    expect(runShellCommand).not.toHaveBeenCalled();
    expect(deltas).toEqual([
      expect.objectContaining({
        requestId: "http-stream",
        seq: 1,
        deltaBase64: Buffer.from("event: ok\n\n").toString("base64"),
        done: false,
      }),
      expect.objectContaining({
        requestId: "http-stream",
        seq: 2,
        deltaBase64: "",
        done: true,
      }),
    ]);
    socket.close();
  });

  it("preserves split UTF-8 in streaming HTTP response headers", async () => {
    const headerLine = `${JSON.stringify({
      type: "headers",
      status: 200,
      headers: [{ name: "X-Test", value: "猫-value" }],
    })}\n`;
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          splitUtf8ChildScript({ stream: "stdout", value: headerLine }),
        ],
        env: testExecEnv(),
        stdinMode: "pipe-closed",
      }),
    });
    const socket = await openSandboxHttpSocket(sandbox);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-split-stdout",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).resolves.toEqual({
      status: 200,
      headers: [{ name: "X-Test", value: "猫-value" }],
      bodyBase64: "",
    });
    socket.close();
  });

  it("preserves split UTF-8 in streaming HTTP failure diagnostics", async () => {
    const headerLine = `${JSON.stringify({
      type: "headers",
      status: 200,
      headers: [],
    })}\n`;
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          splitUtf8ChildScript({
            stream: "stderr",
            value: "sandbox failed: 猫 not found\n",
            stdoutPrefix: headerLine,
            exitCode: 17,
          }),
        ],
        env: testExecEnv(),
        stdinMode: "pipe-closed",
      }),
    });
    const socket = await openSandboxHttpSocket(sandbox);
    const notifications = collectNotifications(socket);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-split-stderr",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).resolves.toEqual({ status: 200, headers: [], bodyBase64: "" });

    await expect(waitForHttpBodyDeltas(notifications, 1)).resolves.toEqual([
      {
        requestId: "http-split-stderr",
        seq: 1,
        deltaBase64: "",
        done: true,
        error: "sandbox failed: 猫 not found",
      },
    ]);
    socket.close();
  });

  it("terminates streaming HTTP subprocesses when the exec-server socket closes", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          [
            "process.on('SIGTERM', () => process.exit(143));",
            `console.log(${JSON.stringify(
              JSON.stringify({
                type: "headers",
                status: 200,
                headers: [],
              }),
            )});`,
            "setInterval(() => {}, 1000);",
          ].join(""),
        ],
        env: testExecEnv(),
        finalizeToken: "stream-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const socket = await openSandboxHttpSocket(sandbox);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-stream-close",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).resolves.toEqual({
      status: 200,
      headers: [],
      bodyBase64: "",
    });
    socket.terminate();

    await vi.waitFor(
      () =>
        expect(finalizeExec).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "failed",
            token: "stream-token",
          }),
        ),
      { timeout: 5_000 },
    );
  });

  it("rejects streaming HTTP helpers that never terminate a stdout line", async () => {
    const finalizeExec = vi.fn(async () => undefined);
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          [
            `process.stdout.write("x".repeat(${SANDBOX_HTTP_STREAM_LINE_MAX_CHARS + 1}));`,
            "setInterval(() => {}, 1000);",
          ].join(""),
        ],
        env: testExecEnv(),
        finalizeToken: "stream-line-token",
        stdinMode: "pipe-closed",
      }),
      finalizeExec,
    });
    const socket = await openSandboxHttpSocket(sandbox);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "http/request", {
        requestId: "http-stream-long-line",
        method: "GET",
        url: "https://example.test/sse",
        streamResponse: true,
      }),
    ).rejects.toThrow("unterminated stdout line");

    await vi.waitFor(
      () =>
        expect(finalizeExec).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "failed",
            token: "stream-line-token",
          }),
        ),
      { timeout: 5_000 },
    );
    socket.close();
  });
});
