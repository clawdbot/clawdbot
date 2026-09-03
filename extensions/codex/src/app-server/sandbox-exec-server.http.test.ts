// Codex tests cover sandbox exec server.http plugin behavior.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
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
import { useAutoCleanupTempDirTracker } from "./test-support.js";
const SANDBOX_HTTP_STREAM_LINE_MAX_CHARS = 256 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

async function createLiveRedirectSandbox(
  targetHost: "source.test" | "target.test" | "127.0.0.1" | "private.test",
  redirectStatus = 302,
) {
  const requests: IncomingMessage[] = [];
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requestBodies.push(body);
      if (request.url === "/redirect") {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("missing live redirect test server address");
        }
        response.writeHead(redirectStatus, {
          location: `http://${targetHost}:${address.port}/final`,
        });
        response.end("redirect body");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("final body");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const fixtureDir = tempDirs.make("codex-http-redirect-");
  await writeFile(
    join(fixtureDir, "sitecustomize.py"),
    [
      "import socket",
      "original_getaddrinfo = socket.getaddrinfo",
      "original_connect = socket.socket.connect",
      "def getaddrinfo(host, *args, **kwargs):",
      '    if host in ("source.test", "target.test"):',
      '        host = "93.184.216.34"',
      '    elif host == "private.test":',
      '        host = "127.0.0.1"',
      "    return original_getaddrinfo(host, *args, **kwargs)",
      "def connect(self, address):",
      '    if isinstance(address, tuple) and address[0] == "93.184.216.34":',
      '        address = ("127.0.0.1", *address[1:])',
      "    return original_connect(self, address)",
      "socket.getaddrinfo = getaddrinfo",
      "socket.socket.connect = connect",
    ].join("\n"),
  );

  const env = { ...testExecEnv(), PYTHONPATH: fixtureDir };
  const sandbox = createSandboxContext({
    runShellCommand: async ({ script, stdin }) => {
      const child = spawn("/bin/sh", ["-c", script], { env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end(stdin);
      const [code] = (await once(child, "close")) as [number];
      return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    },
    buildExecSpec: async ({ command }) => ({
      argv: ["/bin/sh", "-c", command],
      env,
      stdinMode: "pipe-closed",
    }),
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing live redirect test server address");
  }
  return {
    sandbox,
    url: `http://source.test:${address.port}/redirect`,
    requests,
    requestBodies,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
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

  it.each([
    { redirectStatus: 302, streamResponse: false },
    { redirectStatus: 302, streamResponse: true },
    { redirectStatus: 308, streamResponse: false },
    { redirectStatus: 308, streamResponse: true },
  ])(
    "returns $redirectStatus without exposing credentials when redirectPolicy=stop (stream=$streamResponse)",
    async ({ redirectStatus, streamResponse }) => {
      const fixture = await createLiveRedirectSandbox("target.test", redirectStatus);
      const socket = await openSandboxHttpSocket(fixture.sandbox);
      try {
        const notifications = collectNotifications(socket);
        await rpc(socket, "initialize", { clientName: "test" });
        socket.send(JSON.stringify({ method: "initialized" }));

        await expect(
          rpc(socket, "http/request", {
            requestId: `http-stop-${streamResponse}`,
            method: "GET",
            url: fixture.url,
            headers: [{ name: "authorization", value: "Bearer regression-secret" }],
            redirectPolicy: "stop",
            streamResponse,
          }),
        ).resolves.toEqual({
          status: redirectStatus,
          headers: expect.arrayContaining([
            expect.objectContaining({ name: "location", value: expect.stringContaining("/final") }),
          ]),
          bodyBase64: streamResponse ? "" : Buffer.from("redirect body").toString("base64"),
        });
        if (streamResponse) {
          await expect(waitForHttpBodyDeltas(notifications, 2)).resolves.toEqual([
            expect.objectContaining({
              deltaBase64: Buffer.from("redirect body").toString("base64"),
              done: false,
            }),
            expect.objectContaining({ deltaBase64: "", done: true }),
          ]);
        }
        expect(fixture.requests).toHaveLength(1);
      } finally {
        socket.close();
        await fixture.close();
      }
    },
  );

  it.each([
    {
      targetHost: "source.test",
      preserveCredentials: true,
      redirectStatus: 302,
      streamResponse: false,
    },
    {
      targetHost: "target.test",
      preserveCredentials: false,
      redirectStatus: 302,
      streamResponse: false,
    },
    {
      targetHost: "source.test",
      preserveCredentials: true,
      redirectStatus: 308,
      streamResponse: true,
    },
    {
      targetHost: "target.test",
      preserveCredentials: false,
      redirectStatus: 308,
      streamResponse: true,
    },
  ] as const)(
    "preserves redirect credentials only within the original origin ($targetHost $redirectStatus stream=$streamResponse)",
    async ({ targetHost, preserveCredentials, redirectStatus, streamResponse }) => {
      const fixture = await createLiveRedirectSandbox(targetHost, redirectStatus);
      const socket = await openSandboxHttpSocket(fixture.sandbox);
      try {
        const notifications = collectNotifications(socket);
        await rpc(socket, "initialize", { clientName: "test" });
        socket.send(JSON.stringify({ method: "initialized" }));

        await expect(
          rpc(socket, "http/request", {
            requestId: `http-follow-${targetHost}`,
            method: "GET",
            url: fixture.url,
            headers: [
              { name: "authorization", value: "Bearer regression-secret" },
              { name: "cookie", value: "session=regression-secret" },
              { name: "proxy-authorization", value: "Basic regression-secret" },
              { name: "www-authenticate", value: "Bearer challenge-secret" },
              { name: "cookie2", value: "session=another-regression-secret" },
              { name: "x-request-id", value: "safe-request" },
            ],
            redirectPolicy: "follow",
            streamResponse,
          }),
        ).resolves.toEqual({
          status: 200,
          headers: expect.arrayContaining([
            expect.objectContaining({ name: "content-type", value: "text/plain" }),
          ]),
          bodyBase64: streamResponse ? "" : Buffer.from("final body").toString("base64"),
        });
        if (streamResponse) {
          await expect(waitForHttpBodyDeltas(notifications, 2)).resolves.toEqual([
            expect.objectContaining({
              deltaBase64: Buffer.from("final body").toString("base64"),
              done: false,
            }),
            expect.objectContaining({ deltaBase64: "", done: true }),
          ]);
        }
        expect(fixture.requests).toHaveLength(2);
        const redirectedHeaders = fixture.requests[1]?.headers;
        expect(redirectedHeaders?.["x-request-id"]).toBe("safe-request");
        for (const header of [
          "authorization",
          "cookie",
          "proxy-authorization",
          "www-authenticate",
          "cookie2",
        ]) {
          if (preserveCredentials) {
            expect(redirectedHeaders?.[header]).toBeTruthy();
          } else {
            expect(redirectedHeaders?.[header]).toBeUndefined();
          }
        }
      } finally {
        socket.close();
        await fixture.close();
      }
    },
  );

  it.each([
    { redirectStatus: 301, originalMethod: "POST", redirectedMethod: "GET" },
    { redirectStatus: 302, originalMethod: "POST", redirectedMethod: "GET" },
    { redirectStatus: 302, originalMethod: "PUT", redirectedMethod: "PUT" },
    { redirectStatus: 303, originalMethod: "PUT", redirectedMethod: "GET" },
    { redirectStatus: 307, originalMethod: "POST", redirectedMethod: "POST" },
    { redirectStatus: 308, originalMethod: "POST", redirectedMethod: "POST" },
  ])(
    "preserves upstream HTTP redirect method semantics ($redirectStatus $originalMethod)",
    async ({ redirectStatus, originalMethod, redirectedMethod }) => {
      const fixture = await createLiveRedirectSandbox("source.test", redirectStatus);
      const socket = await openSandboxHttpSocket(fixture.sandbox);
      try {
        await rpc(socket, "initialize", { clientName: "test" });
        socket.send(JSON.stringify({ method: "initialized" }));

        await expect(
          rpc(socket, "http/request", {
            requestId: `http-method-${redirectStatus}-${originalMethod}`,
            method: originalMethod,
            url: fixture.url,
            headers: [{ name: "content-type", value: "application/json" }],
            bodyBase64: Buffer.from('{"message":"keep"}').toString("base64"),
            redirectPolicy: "follow",
          }),
        ).resolves.toEqual(
          expect.objectContaining({
            status: 200,
            bodyBase64: Buffer.from("final body").toString("base64"),
          }),
        );
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests[1]?.method).toBe(redirectedMethod);
        expect(fixture.requests[1]?.headers["content-type"]).toBe(
          redirectedMethod === "GET" ? undefined : "application/json",
        );
        expect(fixture.requestBodies[1]).toBe(
          redirectedMethod === "GET" ? "" : '{"message":"keep"}',
        );
      } finally {
        socket.close();
        await fixture.close();
      }
    },
  );

  it.each([
    { redirectStatus: 302, targetHost: "127.0.0.1", streamResponse: false },
    { redirectStatus: 302, targetHost: "private.test", streamResponse: true },
    { redirectStatus: 308, targetHost: "127.0.0.1", streamResponse: false },
    { redirectStatus: 308, targetHost: "private.test", streamResponse: true },
  ] as const)(
    "blocks redirect destinations before connecting ($redirectStatus $targetHost stream=$streamResponse)",
    async ({ redirectStatus, targetHost, streamResponse }) => {
      const fixture = await createLiveRedirectSandbox(targetHost, redirectStatus);
      const socket = await openSandboxHttpSocket(fixture.sandbox);
      try {
        await rpc(socket, "initialize", { clientName: "test" });
        socket.send(JSON.stringify({ method: "initialized" }));

        await expect(
          rpc(socket, "http/request", {
            requestId: "http-blocked-redirect",
            method: "GET",
            url: fixture.url,
            redirectPolicy: "follow",
            streamResponse,
          }),
        ).rejects.toThrow(/Blocked.*private\/internal\/special-use/);
        expect(fixture.requests).toHaveLength(1);
      } finally {
        socket.close();
        await fixture.close();
      }
    },
  );

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
