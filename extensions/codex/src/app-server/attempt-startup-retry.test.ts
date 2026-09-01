import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  embeddedAgentLog,
  type CodexBundleMcpThreadConfig,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { CodexAppServerClient, isCodexAppServerConnectionClosedError } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexComputerUseConfig,
  type CodexPluginConfig,
} from "./config.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClient,
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createCodexTestModel } from "./test-support.js";
import * as processSnapshot from "./transport-process-snapshot.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

vi.mock("./desktop-generation.js", () => ({
  isCodexDesktopGenerationCurrent: () => false,
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();

async function createStartupFailureFixture(
  mode:
    | "transient"
    | "contention"
    | "persistent"
    | "unsupported"
    | "overload"
    | "registration-race"
    | "refusal",
) {
  const root = path.join(os.tmpdir(), `openclaw-codex-startup-retry-${randomUUID()}`);
  tempRoots.add(root);
  const fixturePath = path.join(root, "startup-failure.mjs");
  const spawnCountPath = path.join(root, "spawn-count");
  const requestLogPath = path.join(root, "requests.log");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    fixturePath,
    [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      "const [spawnCountPath, mode, codexHome, requestLogPath] = process.argv.slice(2);",
      'const attempt = Number(fs.existsSync(spawnCountPath) ? fs.readFileSync(spawnCountPath, "utf8") : 0) + 1;',
      'fs.writeFileSync(spawnCountPath, String(attempt), "utf8");',
      "const startedAtPath = `${spawnCountPath}.started-at`;",
      'if (attempt === 1) fs.writeFileSync(startedAtPath, String(Date.now()), "utf8");',
      'const stillContended = mode === "contention" && Date.now() - Number(fs.readFileSync(startedAtPath, "utf8")) < 750;',
      'if (mode === "registration-race" && attempt === 1) {',
      '  process.on("SIGUSR2", () => {',
      '    fs.writeSync(2, "Error: failed to initialize sqlite state runtime: database is locked\\n");',
      "    process.exit(1);",
      "  });",
      "  setInterval(() => {}, 1_000);",
      '  fs.writeFileSync(`${spawnCountPath}.ready`, "ready");',
      '} else if (mode === "persistent" || (mode === "transient" && attempt === 1) || stillContended) {',
      "  console.error(`Error: failed to initialize sqlite state runtime under ${codexHome}: failed to initialize state runtime at ${codexHome}`);",
      // Keep the persistent fixture alive through process registration so this
      // case reaches the retry owner; immediate-exit registration is covered above.
      '  if (mode === "persistent") setTimeout(() => { process.exitCode = 1; }, 1_000);',
      "  else process.exitCode = 1;",
      "} else {",
      '  if (mode === "refusal") fs.writeSync(2, "startup diagnostic: inspection probe\\n");',
      '  fs.writeFileSync(`${spawnCountPath}.ready`, "ready");',
      "  const lines = readline.createInterface({ input: process.stdin });",
      '  lines.on("line", (line) => {',
      "    const message = JSON.parse(line);",
      "    if (message.id === undefined) return;",
      "    fs.appendFileSync(requestLogPath, `${message.method}\\n`);",
      '    if (mode === "overload" && message.method === "thread/resume") {',
      '      process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "Server overloaded; retry later." } })}\\n`);',
      "      return;",
      "    }",
      '    const result = message.method === "initialize"',
      '      ? { userAgent: `openclaw/${mode === "unsupported" ? "0.1.0" : "0.149.0"} (macOS; test)` }',
      `      : ${JSON.stringify(threadStartResult("thread-recovered", "/repo"))};`,
      "    process.stdout.write(`${JSON.stringify({ id: message.id, result })}\\n`);",
      "  });",
      "}",
    ].join("\n"),
    "utf8",
  );
  const pluginConfig = {
    appServer: {
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath, spawnCountPath, mode, codexHome, requestLogPath],
      requestTimeoutMs: 5_000,
    },
  } satisfies CodexPluginConfig;
  return { root, spawnCountPath, requestLogPath, pluginConfig };
}

function startFixtureAttempt(
  fixture: Awaited<ReturnType<typeof createStartupFailureFixture>>,
  attemptClientFactory = getLeasedSharedCodexAppServerClient,
) {
  const agentDir = path.join(fixture.root, "agent");
  const workspaceDir = path.join(fixture.root, "workspace");
  const bundleMcpThreadConfig = {
    configPatch: undefined,
    diagnostics: [],
    evaluated: false,
    fingerprint: undefined,
    staticServerNames: [],
    userStaticServerNames: [],
  } satisfies CodexBundleMcpThreadConfig;
  return startCodexAttemptThread({
    bindingStore: testCodexAppServerBindingStore,
    attemptClientFactory,
    appServer: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig }),
    pluginConfig: fixture.pluginConfig,
    computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig: fixture.pluginConfig }),
    startupAuthProfileId: undefined,
    startupAuthBindingFingerprint: undefined,
    startupAuthAccountCacheKey: undefined,
    startupEnvApiKeyCacheKey: undefined,
    agentDir,
    config: undefined,
    buildAttemptParams: () =>
      ({
        hostCapabilities: createCodexTestHostCapabilities(),
        prompt: "hello",
        sessionId: "session-1",
        sessionKey: "agent:agent-1:session-1",
        agentDir,
        sessionFile: path.join(fixture.root, "session.jsonl"),
        effectiveCwd: workspaceDir,
        workspaceDir,
        runId: "run-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
        model: createCodexTestModel("codex"),
        thinkLevel: "medium",
        disableTools: true,
        timeoutMs: 5_000,
        authStorage: {} as never,
        authProfileStore: { version: 1, profiles: {} },
        modelRegistry: {} as never,
      }) as EmbeddedRunAttemptParams,
    sessionAgentId: "agent-1",
    effectiveWorkspace: workspaceDir,
    effectiveCwd: workspaceDir,
    dynamicTools: [],
    webSearchAllowed: false,
    developerInstructions: undefined,
    finalConfigPatch: undefined,
    bundleMcpThreadConfig,
    nativeToolSurfaceEnabled: true,
    nativeProviderWebSearchSupport: "supported",
    sandboxExecServerEnabled: false,
    sandbox: null,
    contextEngineProjection: undefined,
    startupTimeoutMs: 10_000,
    signal: new AbortController().signal,
    onStartupTimeout: vi.fn(),
    spawnedBy: undefined,
  });
}

describe("Codex app-server startup retry", () => {
  beforeEach(async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-state-"));
    tempRoots.add(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    clearSharedCodexAppServerClient();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  it.skipIf(process.platform === "win32").each([
    ["shared", getLeasedSharedCodexAppServerClient],
    ["isolated", createIsolatedCodexAppServerClient],
  ] as const)(
    "retries %s startup when inspection finishes before the exit event",
    async (_mode, factory) => {
      const fixture = await createStartupFailureFixture("registration-race");
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const spawn = childProcess.spawn;
      const readCommand = processSnapshot.readCodexAppServerProcessCommand;
      let firstChild: childProcess.ChildProcess | undefined;
      let exitDelivered = false;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const child = spawn(...args);
        if (
          !firstChild &&
          Array.isArray(args[1]) &&
          args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
        ) {
          firstChild = child;
          child.once("exit", () => {
            exitDelivered = true;
          });
        }
        return child;
      });
      const commandSpy = vi
        .spyOn(processSnapshot, "readCodexAppServerProcessCommand")
        .mockImplementation(async (observed, deadline) => {
          if (observed.pid !== firstChild?.pid) {
            return readCommand(observed, deadline);
          }
          await expect
            .poll(() => fs.readFile(`${fixture.spawnCountPath}.ready`, "utf8").catch(() => ""))
            .toBe("ready");
          expect(await readCommand(observed, deadline)).toBeDefined();
          firstChild.kill("SIGUSR2");
          // Keep Node's event loop occupied until the OS has exited the real child.
          // Inspection then refuses registration before JS can deliver exit or stderr.
          const exitedBy = Date.now() + 5_000;
          let exited = false;
          while (Date.now() < exitedBy) {
            const inspected = childProcess.spawnSync(
              "ps",
              ["-o", "stat=", "-p", String(observed.pid)],
              {
                encoding: "utf8",
              },
            );
            if (inspected.status === 1 || inspected.stdout.trim().startsWith("Z")) {
              exited = true;
              break;
            }
          }
          expect(exited).toBe(true);
          expect(exitDelivered).toBe(false);
          expect(firstChild.exitCode).toBeNull();
          throw new processSnapshot.ProcessInspectionError("unavailable");
        });
      try {
        const result = await startFixtureAttempt(fixture, factory);
        try {
          expect(result.thread.threadId).toBe("thread-recovered");
          expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("2");
          expect(firstChild?.exitCode).toBe(1);
          expect(firstChild?.signalCode).toBeNull();
          expect(warn).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              error: expect.stringContaining(
                "failed to initialize sqlite state runtime: database is locked",
              ),
            }),
          );
        } finally {
          result.turnRoute.release();
          result.releaseSharedClientLease();
          await result.client.closeAndWait();
        }
      } finally {
        warn.mockRestore();
        spawnSpy.mockRestore();
        commandSpy.mockRestore();
        if (firstChild && firstChild.exitCode === null && firstChild.signalCode === null) {
          const exited = once(firstChild, "exit");
          firstChild.kill("SIGKILL");
          await exited;
        }
      }
    },
  );

  afterEach(async () => {
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("retries a real app-server that fails sqlite initialization before registration completes", async (ctx) => {
    const fixture = await createStartupFailureFixture("transient");
    let firstChildExit: Promise<unknown> | undefined;
    const spawn = childProcess.spawn;
    const snapshot = processSnapshot.readCodexAppServerProcessSnapshot;
    const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      if (
        Array.isArray(args[1]) &&
        args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
      ) {
        firstChildExit ??= once(child, "exit");
      }
      return child;
    });
    const snapshotSpy = vi
      .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
      .mockImplementation(async (...args) => {
        // A slow inspector must not replace the child's retryable startup error.
        await firstChildExit;
        return await snapshot(...args);
      });
    ctx.onTestFinished(() => {
      spawnSpy.mockRestore();
      snapshotSpy.mockRestore();
    });
    const result = await startFixtureAttempt(fixture);

    expect(firstChildExit).toBeDefined();
    expect(result.thread.threadId).toBe("thread-recovered");
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("2");
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it("waits out transient sqlite contention before retrying app-server startup", async () => {
    const fixture = await createStartupFailureFixture("contention");
    const result = await startFixtureAttempt(fixture);

    expect(result.thread.threadId).toBe("thread-recovered");
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("2");
    result.turnRoute.release();
    result.releaseSharedClientLease();
  });

  it.skipIf(process.platform === "win32").each([
    ["shared", getLeasedSharedCodexAppServerClient],
    ["isolated", createIsolatedCodexAppServerClient],
  ] as const)(
    "keeps live-child registration failures non-retryable for %s startup",
    async (_mode, factory) => {
      for (const failure of ["snapshot", "command", "commit"] as const) {
        const fixture = await createStartupFailureFixture("refusal");
        const { createPluginStateSyncKeyedStore } =
          await import("openclaw/plugin-sdk/plugin-state-store-runtime");
        const store = createPluginStateSyncKeyedStore("codex", {
          namespace: "app-server-processes",
          maxEntries: 512,
          overflowPolicy: "reject-new",
        });
        const spawn = childProcess.spawn;
        const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
        const readCommand = processSnapshot.readCodexAppServerProcessCommand;
        let child: childProcess.ChildProcess | undefined;
        const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
          const spawned = spawn(...args);
          if (
            Array.isArray(args[1]) &&
            args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
          ) {
            child = spawned;
          }
          return spawned;
        });
        const snapshotSpy = vi
          .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
          .mockImplementation(async (...args) => {
            if (!child) {
              return readSnapshot(...args);
            }
            await expect
              .poll(() => fs.readFile(`${fixture.spawnCountPath}.ready`, "utf8").catch(() => ""))
              .toBe("ready");
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();
            return failure === "snapshot" ? readSnapshot(Date.now() - 1) : readSnapshot(...args);
          });
        const commandSpy = vi
          .spyOn(processSnapshot, "readCodexAppServerProcessCommand")
          .mockImplementation(async (...args) => {
            const command = await readCommand(...args);
            if (failure === "commit") {
              // Fill the real reject-new store after orphan inspection, so the
              // synchronous registration commit, not a mock, refuses the live child.
              for (let index = 0; index < 512; index++) {
                store.register(`capacity-${index}`, {});
              }
            }
            return failure === "command" ? readCommand(args[0], Date.now() - 1) : command;
          });
        try {
          const error = await startFixtureAttempt(fixture, factory).catch(
            (caught: unknown) => caught,
          );
          expect(error).toBeInstanceOf(Error);
          expect(isCodexAppServerConnectionClosedError(error)).toBe(false);
          expect((error as Error).message).toContain(
            failure === "commit" ? "512-row limit" : "Process inspection exceeded its deadline",
          );
          expect((error as Error).message).toContain("startup diagnostic: inspection probe");
          expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
          await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
          expect(child?.exitCode).toBe(0);
          expect(child?.signalCode).toBeNull();
          expect(child?.stdout?.destroyed).toBe(true);
          expect(child?.stderr?.destroyed).toBe(true);
        } finally {
          spawnSpy.mockRestore();
          snapshotSpy.mockRestore();
          commandSpy.mockRestore();
          store.clear();
          if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        }
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["natural exit", "live child"])(
    "preserves assertCurrent refusal over a %s during registration",
    async (mode) => {
      const fixture = await createStartupFailureFixture(
        mode === "natural exit" ? "transient" : "refusal",
      );
      const refusal = new Error("startup owner revoked");
      let current = true;
      const spawn = childProcess.spawn;
      let child: childProcess.ChildProcess | undefined;
      let closed: Promise<unknown> | undefined;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const spawned = spawn(...args);
        if (
          Array.isArray(args[1]) &&
          args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
        ) {
          child = spawned;
          closed = once(spawned, "close");
        }
        return spawned;
      });
      const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      const snapshotSpy = vi
        .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
        .mockImplementation(async (...args) => {
          if (mode === "natural exit") {
            await closed;
          } else {
            await expect
              .poll(() => fs.readFile(`${fixture.spawnCountPath}.ready`, "utf8").catch(() => ""))
              .toBe("ready");
          }
          const rows = await readSnapshot(...args);
          current = false;
          return rows;
        });
      try {
        await expect(
          CodexAppServerClient.start(
            resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig }).start,
            () => {
              if (!current) {
                throw refusal;
              }
            },
          ),
        ).rejects.toBe(refusal);
        expect(child?.exitCode).toBe(mode === "natural exit" ? 1 : 0);
        expect(child?.signalCode).toBeNull();
        await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        spawnSpy.mockRestore();
        snapshotSpy.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["shared", getLeasedSharedCodexAppServerClient],
    ["isolated", createIsolatedCodexAppServerClient],
  ] as const)("preserves cancellation during %s registration", async (_mode, factory) => {
    const fixture = await createStartupFailureFixture("refusal");
    const controller = new AbortController();
    const spawn = childProcess.spawn;
    const readCommand = processSnapshot.readCodexAppServerProcessCommand;
    let child: childProcess.ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const spawned = spawn(...args);
      if (
        Array.isArray(args[1]) &&
        args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
      ) {
        child = spawned;
        closed = once(spawned, "close");
      }
      return spawned;
    });
    const commandSpy = vi
      .spyOn(processSnapshot, "readCodexAppServerProcessCommand")
      .mockImplementation(async (...args) => {
        await expect
          .poll(() => fs.readFile(`${fixture.spawnCountPath}.ready`, "utf8").catch(() => ""))
          .toBe("ready");
        const command = await readCommand(...args);
        controller.abort();
        return command;
      });
    try {
      await expect(
        factory({
          startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig })
            .start,
          agentDir: path.join(fixture.root, "agent"),
          authProfileStore: { version: 1, profiles: {} },
          abandonSignal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "CODEX_APP_SERVER_STARTUP_CANCELLED", reason: "aborted" });
      await closed;
      expect(child?.exitCode).toBe(0);
      expect(child?.signalCode).toBeNull();
      expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
      await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      spawnSpy.mockRestore();
      commandSpy.mockRestore();
    }
  });

  it("bounds retries when sqlite state initialization keeps failing", async () => {
    const fixture = await createStartupFailureFixture("persistent");

    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      "failed to initialize sqlite state runtime",
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("3");
  });

  it("rejects an unsupported app-server version without retrying", async () => {
    const fixture = await createStartupFailureFixture("unsupported");

    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      /app-server .* or newer is required/i,
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
  });

  it("preserves spawn failure without classifying it as a retryable exit", async () => {
    const fixture = await createStartupFailureFixture("refusal");
    const command = path.join(fixture.root, "missing-executable");
    fixture.pluginConfig.appServer.command = command;
    const spawnSpy = vi.spyOn(childProcess, "spawn");
    try {
      await expect(startFixtureAttempt(fixture)).rejects.toMatchObject({ code: "ENOENT" });
      expect(spawnSpy.mock.calls.filter(([program]) => program === command)).toHaveLength(1);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("preserves the shared client and binding after resume overload exhausts", async () => {
    const fixture = await createStartupFailureFixture("overload");
    const sibling = await startFixtureAttempt(fixture);
    sibling.turnRoute.release();
    const identity = {
      kind: "session" as const,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    };
    try {
      const binding = await testCodexAppServerBindingStore.read(identity);
      expect(binding?.threadId).toBe("thread-recovered");
      const requestsBeforeResume = await fs.readFile(fixture.requestLogPath, "utf8");

      await expect(startFixtureAttempt(fixture)).rejects.toMatchObject({
        name: "CodexAppServerRpcError",
        code: -32_001,
        method: "thread/resume",
      });
      const requests = await fs.readFile(fixture.requestLogPath, "utf8");
      expect(new Set(requests.slice(requestsBeforeResume.length).trim().split("\n"))).toEqual(
        new Set(["thread/resume"]),
      );
      await expect(testCodexAppServerBindingStore.read(identity)).resolves.toEqual(binding);

      await expect(
        sibling.client.request("thread/read", {
          threadId: "thread-recovered",
          includeTurns: false,
        }),
      ).resolves.toMatchObject({ thread: { id: "thread-recovered" } });
      sibling.releaseSharedClientLease();
      expect(sibling.client.getCloseError()).toBeUndefined();

      const reacquired = await getLeasedSharedCodexAppServerClient({
        startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig })
          .start,
        agentDir: path.join(fixture.root, "agent"),
      });
      try {
        expect(reacquired).toBe(sibling.client);
        expect(reacquired.getCloseError()).toBeUndefined();
        expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
      } finally {
        releaseLeasedSharedCodexAppServerClient(reacquired);
      }
    } finally {
      sibling.releaseSharedClientLease();
      await sibling.client.closeAndWait();
    }
  });
});
