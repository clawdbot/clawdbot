// Codex tests cover sandbox exec server plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  ensureCodexSandboxExecServerEnvironment,
  releaseCodexSandboxExecServerEnvironment,
} from "./sandbox-exec-server.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES = 100 * 1024 * 1024;
import {
  collectNotifications,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  readUntilClosed,
  rpc,
  waitForSocketClose,
} from "./sandbox-exec-server.test-helpers.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await sandboxExecServerRegistry.closeAll();
});

function testExecEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
  };
}

function echoFirstInputLineScript(prefix: string): string {
  return [
    "let data = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "data += chunk;",
    "if (data.includes('\\n')) {",
    `process.stdout.write(${JSON.stringify(prefix)} + data);`,
    "process.exit(0);",
    "}",
    "});",
  ].join(" ");
}

async function readStartedPid(
  socket: Awaited<ReturnType<typeof openSocket>>,
  processId: string,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = (await rpc(socket, "process/read", {
      processId,
      afterSeq: 0,
      waitMs: 100,
    })) as { chunks?: Array<{ chunk: string }> };
    const output = (read.chunks ?? [])
      .map((chunk) => Buffer.from(chunk.chunk, "base64").toString("utf8"))
      .join("");
    const pid = /PID=(\d+)/u.exec(output)?.[1];
    if (pid) {
      return Number(pid);
    }
  }
  throw new Error(`process ${processId} did not report its PID`);
}

describe("OpenClaw Codex sandbox exec-server", () => {
  it("rejects an incomplete sandbox environment before publishing an exec-server", async () => {
    const sandbox = createSandboxContext({});
    sandbox.fsBridge = undefined;
    const client = createClient();

    await expect(
      ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox }),
    ).rejects.toThrow("Sandbox filesystem bridge is unavailable.");
    expect(client.request).not.toHaveBeenCalled();
    expect(sandboxExecServerRegistry.servers.has(sandbox.runtimeId)).toBe(false);
  });

  it.each([
    { containerWorkdir: "/workspace", cwd: "file:///workspace" },
    {
      containerWorkdir: "/workspace/space #project",
      cwd: "file:///workspace/space%20%23project",
    },
  ])(
    "reports target shell, encoded workdir, and readiness for $containerWorkdir",
    async ({ containerWorkdir, cwd }) => {
      const sandbox = createSandboxContext({});
      sandbox.containerWorkdir = containerWorkdir;
      const client = createClient();

      await ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
      });
      const socket = await openSocket(execServerUrlFromClient(client));
      await rpc(socket, "initialize", { clientName: "test" });
      socket.send(JSON.stringify({ method: "initialized" }));

      await expect(rpc(socket, "environment/info", {})).resolves.toEqual({
        shell: { name: "sh", path: "/bin/sh" },
        cwd,
        capabilities: { networkProxyLaunch: false },
      });
      await expect(rpc(socket, "environment/status", {})).resolves.toEqual({
        status: "ready",
      });

      socket.close();
    },
  );

  it("does not advertise a local exec-server URL to remote app-servers", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: {
          transport: "websocket",
          command: "codex",
          commandSource: "config",
          args: [],
          url: "wss://codex.example.test/app-server",
          headers: {},
        },
      }),
    ).rejects.toThrow("cannot be registered with a remote Codex app-server");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("does not treat 127-prefixed DNS names as local app-server hosts", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();

    await expect(
      ensureCodexSandboxExecServerEnvironment({
        client: client as never,
        sandbox,
        appServerStartOptions: {
          transport: "websocket",
          command: "codex",
          commandSource: "config",
          args: [],
          url: "wss://127.example.test/app-server",
          headers: {},
        },
      }),
    ).rejects.toThrow("cannot be registered with a remote Codex app-server");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("registers a sandbox-backed Codex environment and routes process execution through it", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", "process.stdout.write('sandbox-process-ok\\n')"],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      getServerVersion: vi.fn(() => CODEX_APP_SERVER_VERSION),
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      }),
    };

    const environment = await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const addRequest = requests[0];
    expect(addRequest?.method).toBe("environment/add");
    expect(environment).toEqual({
      environmentId: expect.stringMatching(/^openclaw-sandbox-/),
      cwd: "/workspace",
    });
    const execServerUrl =
      typeof addRequest?.params === "object" &&
      addRequest.params &&
      "execServerUrl" in addRequest.params
        ? String(addRequest.params.execServerUrl)
        : "";
    expect(execServerUrl).toMatch(/^ws:\/\/127\.0\.0\.1:/);

    const socket = await openSocket(execServerUrl);
    const notifications = collectNotifications(socket);
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
    const start = (await rpc(socket, "process/start", {
      processId: "proc-1",
      argv: ["/bin/sh", "-lc", "printf ok"],
      cwd: "file:///workspace",
      env: {
        POLICY_SET: "env-wins",
        TEST_FLAG: "1",
        CODEX_API_KEY: "must-not-cross",
        OPENAI_API_KEY: "must-not-cross",
      },
      envPolicy: {
        inherit: "none",
        ignoreDefaultExcludes: true,
        exclude: [],
        set: {
          POLICY_SET: "policy",
          POLICY_ONLY: "1",
          CODEX_ACCESS_TOKEN: "must-not-cross",
        },
        includeOnly: [],
      },
      tty: false,
      pipeStdin: false,
      arg0: null,
    })) as { processId?: string; nextSeq?: number };
    expect(start).toEqual({ processId: "proc-1" });
    const read = await readUntilClosed(socket, "proc-1");

    expect(read.exited).toBe(true);
    expect(read.exitCode).toBe(0);
    expect(read.closed).toBe(true);
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "sandbox-process-ok\n",
    );
    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "'/bin/sh' '-lc' 'printf ok'",
        env: expect.objectContaining({
          CODEX_SANDBOX_EXEC_ID: expect.any(String),
          POLICY_ONLY: "1",
          POLICY_SET: "env-wins",
          TEST_FLAG: "1",
        }),
        usePty: false,
        workdir: "/workspace",
      }),
    );
    expect(notifications.map((notification) => notification.method)).toEqual(
      expect.arrayContaining(["process/output", "process/exited", "process/closed"]),
    );
    socket.close();
  });

  it("decodes a Codex file URI cwd before sandbox execution", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-uri-cwd",
      argv: ["/usr/bin/pwd"],
      cwd: "file:///projects/example%20repo",
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
    });

    expect(buildExecSpec).toHaveBeenCalledWith(
      expect.objectContaining({ workdir: "/projects/example repo" }),
    );
    socket.close();
  });

  it.each([
    ["a native absolute path", "/workspace"],
    ["a relative path", "workspace"],
    ["a non-file scheme", "https://example.test/workspace"],
    ["a remote file authority", "file://remote.example.test/workspace"],
    ["a query", "file:///workspace?revision=1"],
    ["a fragment", "file:///workspace#section"],
    ["a Windows drive path", "file:///C:/workspace"],
    ["an encoded Windows drive path", "file:///%43:/workspace"],
    ["an encoded null byte", "file:///workspace%00"],
  ])("rejects a process cwd with %s", async (_label, cwd) => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "process/start", {
        processId: "proc-invalid-cwd",
        argv: ["/usr/bin/pwd"],
        cwd,
        env: {},
        tty: false,
        pipeStdin: false,
        arg0: null,
      }),
    ).rejects.toThrow(/process cwd/u);
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it("closes oversized sandbox exec-server frames before JSON-RPC parsing", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();

    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    const closed = waitForSocketClose(socket);

    socket.send(Buffer.alloc(CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES + 1));

    await expect(closed).resolves.toEqual({ code: 1009 });
  });

  it("rejects unsupported arg0 overrides instead of dropping them", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: testExecEnv(),
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "process/start", {
        processId: "proc-arg0",
        argv: ["/bin/sh", "-lc", "true"],
        cwd: "file:///workspace",
        env: {},
        tty: false,
        pipeStdin: false,
        arg0: "codex-linux-sandbox",
      }),
    ).rejects.toThrow("does not support arg0 overrides");
    expect(buildExecSpec).not.toHaveBeenCalled();
    socket.close();
  });

  it("accepts stdin writes for pipe-backed processes", async () => {
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [process.execPath, "-e", echoFirstInputLineScript("echo:")],
        env: testExecEnv(),
        stdinMode: "pipe-open",
      }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-stdin",
      argv: ["/bin/sh", "-lc", "cat"],
      cwd: "file:///workspace",
      env: {},
      tty: false,
      pipeStdin: true,
      arg0: null,
    });
    await expect(
      rpc(socket, "process/write", {
        processId: "proc-stdin",
        chunk: Buffer.from("hello\n").toString("base64"),
      }),
    ).resolves.toEqual({ status: "accepted" });
    const read = await readUntilClosed(socket, "proc-stdin");
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "echo:hello\n",
    );
    socket.close();
  });

  it("keeps tty process starts pipe-backed for sandbox backends", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", echoFirstInputLineScript("tty:")],
      env: testExecEnv(),
      stdinMode: "pipe-open" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-tty",
      argv: ["/bin/sh", "-lc", "cat"],
      cwd: "file:///workspace",
      env: {},
      tty: true,
      pipeStdin: false,
      arg0: null,
    });
    await expect(
      rpc(socket, "process/write", {
        processId: "proc-tty",
        chunk: Buffer.from("hello\n").toString("base64"),
      }),
    ).resolves.toEqual({ status: "accepted" });
    const read = await readUntilClosed(socket, "proc-tty");

    expect(buildExecSpec).toHaveBeenCalledWith(expect.objectContaining({ usePty: false }));
    expect(read.chunks?.[0]?.stream).toBe("pty");
    expect(Buffer.from(read.chunks?.[0]?.chunk ?? "", "base64").toString("utf8")).toBe(
      "tty:hello\n",
    );
    socket.close();
  });

  it("does not let Codex env policy inherit host secret variables", async () => {
    vi.stubEnv("HOME", "/gateway-home");
    vi.stubEnv("USER", "gateway-user");
    vi.stubEnv("TMPDIR", "/gateway-tmp");
    vi.stubEnv("OPENCLAW_TEST_SECRET_TOKEN", "host-secret");
    vi.stubEnv("OPENCLAW_TEST_DATABASE_PASSWORD", "host-password");
    vi.stubEnv("OPENCLAW_TEST_PRIVATE_KEY", "host-private-key");
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "-e", ""],
      env: {},
      stdinMode: "pipe-closed" as const,
    }));
    const sandbox = createSandboxContext({ buildExecSpec });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-secret-env",
      argv: ["/bin/sh", "-lc", "true"],
      cwd: "file:///workspace",
      env: {},
      envPolicy: {
        inherit: "all",
        ignoreDefaultExcludes: true,
        exclude: [],
        set: {},
        includeOnly: [],
      },
      tty: false,
      pipeStdin: false,
      arg0: null,
    });

    const [{ env: execEnv }] = buildExecSpec.mock.calls[0] as unknown as [
      { env: Record<string, string> },
    ];
    expect(execEnv).toEqual({ CODEX_SANDBOX_EXEC_ID: expect.any(String) });
    socket.close();
  });

  it("keeps process/read cursors at the last returned byte-limited chunk", async () => {
    const sandbox = createSandboxContext({
      buildExecSpec: async () => ({
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write('aaaa'); process.stderr.write('bbbb');",
        ],
        env: testExecEnv(),
        stdinMode: "pipe-closed",
      }),
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await rpc(socket, "process/start", {
      processId: "proc-cursor",
      argv: [process.execPath, "-e", "ignored"],
      cwd: "file:///workspace",
      env: {},
      tty: false,
      pipeStdin: false,
      arg0: null,
    });
    const complete = await readUntilClosed(socket, "proc-cursor");
    expect(complete.chunks?.length ?? 0).toBeGreaterThanOrEqual(2);

    const firstRead = (await rpc(socket, "process/read", {
      processId: "proc-cursor",
      afterSeq: 0,
      maxBytes: 4,
    })) as { chunks?: Array<{ seq: number }>; nextSeq?: number };
    expect(firstRead.chunks).toHaveLength(1);
    expect(firstRead.nextSeq).toBe((firstRead.chunks?.[0]?.seq ?? 0) + 1);
    expect(firstRead.nextSeq ?? 0).toBeLessThan(complete.nextSeq ?? 0);

    const secondRead = (await rpc(socket, "process/read", {
      processId: "proc-cursor",
      afterSeq: (firstRead.nextSeq ?? 1) - 1,
      maxBytes: 4,
    })) as { chunks?: Array<{ seq: number }> };
    expect(secondRead.chunks?.length ?? 0).toBeGreaterThanOrEqual(1);
    socket.close();
  });

  it("returns protocol statuses for unsupported process writes and unknown termination", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    await expect(
      rpc(socket, "process/write", {
        processId: "missing",
        chunk: Buffer.from("hello").toString("base64"),
      }),
    ).resolves.toEqual({ status: "unknownProcess" });
    await expect(
      rpc(socket, "process/terminate", {
        processId: "missing",
      }),
    ).resolves.toEqual({ running: false });
    socket.close();
  });

  it("distinguishes unsupported exec methods from missing filesystem resources", async () => {
    const sandbox = createSandboxContext({ stat: async () => null });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));

    for (const method of ["fs/walk", "process/signal", "unsupported/method"]) {
      await expect(rpc(socket, method, {})).rejects.toMatchObject({
        code: -32601,
        message: `Unsupported OpenClaw sandbox exec-server method: ${method}`,
      });
    }
    await expect(
      rpc(socket, "fs/getMetadata", { path: "file:///workspace/missing" }),
    ).rejects.toMatchObject({
      code: -32004,
      message: "file not found",
    });
    await expect(rpc(socket, "environment/status", {})).resolves.toEqual({
      status: "ready",
    });

    socket.close();
  });

  it("rejects WebSocket clients that do not know the exec-server capability path", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const unauthorizedUrl = execServerUrlFromClient(client).replace(
      /\/openclaw-[^/?#]+/u,
      "/wrong",
    );
    const socket = await openSocket(unauthorizedUrl);

    await expect(waitForSocketClose(socket)).resolves.toEqual({ code: 1008 });
  });

  it("handles oversized frames from unauthorized WebSocket clients", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const unauthorizedUrl = execServerUrlFromClient(client).replace(
      /\/openclaw-[^/?#]+/u,
      "/wrong",
    );
    const socket = await openSocket(unauthorizedUrl);
    const closed = waitForSocketClose(socket);

    socket.send(Buffer.alloc(CODEX_SANDBOX_EXEC_SERVER_MAX_INBOUND_MESSAGE_BYTES + 1));

    const closeResult = await closed;
    expect([1008, 1009]).toContain(closeResult.code);
  });

  it("closes the exec-server when its sandbox environment is released", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const execServerUrl = execServerUrlFromClient(client);
    await releaseCodexSandboxExecServerEnvironment(sandbox);

    await expect(openSocket(execServerUrl)).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "reaps TERM-resistant process groups on socket loss and turn environment release",
    async () => {
      for (const cleanup of ["socket", "environment"] as const) {
        const finalizeExec = vi.fn(async () => undefined);
        const sandbox = createSandboxContext({
          buildExecSpec: async () => ({
            argv: [
              "/bin/sh",
              "-c",
              'echo "PID=$$"; trap -- "" TERM; while :; do echo heartbeat; sleep 0.1; done',
            ],
            env: testExecEnv(),
            finalizeToken: `${cleanup}-lease`,
            stdinMode: "pipe-closed",
          }),
          finalizeExec,
        });
        sandbox.runtimeId = `openclaw-test-runtime-${cleanup}`;
        const client = createClient();
        await ensureCodexSandboxExecServerEnvironment({
          client: client as never,
          sandbox,
        });
        const socket = await openSocket(execServerUrlFromClient(client));
        let pid: number | undefined;
        try {
          await rpc(socket, "initialize", { clientName: "test" });
          socket.send(JSON.stringify({ method: "initialized" }));
          await rpc(socket, "process/start", {
            processId: `process-${cleanup}`,
            argv: ["ignored"],
            cwd: "file:///workspace",
            env: {},
            tty: false,
            pipeStdin: false,
            arg0: null,
          });
          pid = await readStartedPid(socket, `process-${cleanup}`);

          if (cleanup === "socket") {
            const closed = waitForSocketClose(socket);
            socket.terminate();
            await closed;
            await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce(), {
              timeout: 3_000,
            });
          } else {
            await releaseCodexSandboxExecServerEnvironment(sandbox);
          }

          expect(() => process.kill(pid!, 0)).toThrow();
          expect(finalizeExec).toHaveBeenCalledOnce();
          expect(finalizeExec).toHaveBeenCalledWith({
            status: "completed",
            exitCode: 1,
            timedOut: false,
            token: `${cleanup}-lease`,
          });
        } finally {
          if (pid) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // The owner already reaped the process group.
            }
          }
          await releaseCodexSandboxExecServerEnvironment(sandbox);
        }
      }
    },
  );

  it("keeps a shared exec-server open when another turn reacquires during release", async () => {
    const sandbox = createSandboxContext({});
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    const firstExecServerUrl = execServerUrlFromClient(client);

    const release = releaseCodexSandboxExecServerEnvironment(sandbox);
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox,
    });
    await release;
    const secondExecServerUrl = execServerUrlFromClient(client, 1);

    expect(secondExecServerUrl).toBe(firstExecServerUrl);
    const socket = await openSocket(secondExecServerUrl);
    await expect(rpc(socket, "initialize", { clientName: "test" })).resolves.toEqual({
      sessionId: expect.any(String),
    });
    socket.close();
  });
});
