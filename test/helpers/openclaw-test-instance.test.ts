// OpenClaw test instance tests cover spawned test instance lifecycle.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTestInstance, testing } from "./openclaw-test-instance.js";
import { isProcessAlive } from "./process-wait.js";

const MIGRATION_CONVERGENCE_REFUSAL =
  "OpenClaw plugin migration inputs changed during startup convergence;";
const RESTART_MARKER =
  "[openclaw-test-instance] restarting gateway after migration convergence refusal";
const fakeInstances: Awaited<ReturnType<typeof createOpenClawTestInstance>>[] = [];
const fakeRoots: string[] = [];

type FakeGatewayAttempt = {
  argv: string[];
  config: unknown;
  cwd: string;
  env: Record<string, string | undefined>;
  pid: number;
  port: number;
};

afterEach(async () => {
  await Promise.allSettled(fakeInstances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(fakeRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

async function createFakeGateway(sequence: string, startTimeoutMs = 1_000, stopTimeoutMs = 1_500) {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "openclaw-test-instance-gateway-"));
  fakeRoots.push(cwd);
  const distDir = path.join(cwd, "dist");
  const tracePath = path.join(cwd, "attempts.jsonl");
  await fs.mkdir(distDir);
  await Promise.all([
    fs.writeFile(path.join(distDir, ".buildstamp"), ""),
    fs.writeFile(path.join(distDir, ".runtime-postbuildstamp"), ""),
    fs.writeFile(
      path.join(distDir, "index.mjs"),
      `
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const tracePath = process.env.OPENCLAW_FAKE_GATEWAY_TRACE;
const countPath = tracePath + ".count";
let attempt = 1;
try { attempt = Number(readFileSync(countPath, "utf8")) + 1; } catch {}
writeFileSync(countPath, String(attempt));
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const env = Object.fromEntries(["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_STATE_DIR"].map((key) => [key, process.env[key]]));
appendFileSync(tracePath, JSON.stringify({ argv, config: JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), cwd: process.cwd(), env, pid: process.pid, port }) + "\\n");
const action = (process.env.OPENCLAW_FAKE_GATEWAY_SEQUENCE || "ready").split(",")[attempt - 1] || "ready";
const [kind, delay] = action.split(":");
if (delay) await new Promise((resolve) => setTimeout(resolve, Number(delay)));
process.stdout.write("fake gateway attempt " + attempt + "\\n");
const refusal = ${JSON.stringify(MIGRATION_CONVERGENCE_REFUSAL)};
if (kind === "refuse") { process.stderr.write(refusal + " fixture\\n"); process.exit(1); }
if (kind === "late-refuse") { spawn(process.execPath, ["-e", 'setTimeout(() => process.stderr.write(process.argv[1]), 50)', refusal + " delayed fixture\\n"], { stdio: ["ignore", "ignore", "inherit"] }); process.exit(1); }
if (kind === "resist-after-exit") {
  const resistant = spawn(process.execPath, ["-e", 'const fs = require("node:fs");fs.writeFileSync(process.argv[1], String(process.pid));process.on("SIGTERM", () => fs.appendFileSync(process.argv[2], "SIGTERM"));process.send("ready");setInterval(() => {}, 1_000);', tracePath + ".resistant-pid", tracePath + ".signals"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await new Promise((resolve) => resistant.once("message", resolve));
  process.stderr.write("unrelated startup failure\\n"); process.exit(1);
}
if (kind === "terminal-drain") {
  const draining = spawn(process.execPath, ["-e", 'const fs = require("node:fs");const release = process.argv[1];const deadline = Date.now() + 5_000;const timer = setInterval(() => { if (fs.existsSync(release) || Date.now() >= deadline) clearInterval(timer); }, 10);', tracePath + ".draining-release"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  draining.unref();
  writeFileSync(tracePath + ".draining-pid", String(draining.pid));
  process.stderr.write("terminal startup failure\\n"); process.exit(7);
}
if (kind === "near") { process.stderr.write(refusal.slice(0, -1) + " fixture\\n"); process.exit(1); }
if (kind === "stdout") { process.stdout.write(refusal + " fixture\\n"); process.exit(1); }
if (kind === "status2") { process.stderr.write(refusal + " fixture\\n"); process.exit(2); }
if (kind === "signal") { process.stderr.write(refusal + " fixture\\n"); process.kill(process.pid, "SIGTERM"); }
if (kind === "unrelated") { process.stderr.write("unrelated startup failure\\n"); process.exit(1); }
if (kind === "hang") { process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1_000); } else {
  const server = createServer((req, res) => { res.writeHead(req.url === "/readyz" ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify({ ready: req.url === "/readyz" })); });
  process.on("SIGTERM", () => server.close(() => process.exit(0))); server.listen(port, "127.0.0.1");
}
`,
    ),
  ]);
  const instance = await createOpenClawTestInstance({
    name: `fake-gateway-${path.basename(cwd)}`,
    cwd,
    env: {
      OPENCLAW_FAKE_GATEWAY_SEQUENCE: sequence,
      OPENCLAW_FAKE_GATEWAY_TRACE: tracePath,
    },
    startTimeoutMs,
    stopTimeoutMs,
  });
  fakeInstances.push(instance);
  return {
    instance,
    tracePath,
    readAttempts: async (): Promise<FakeGatewayAttempt[]> =>
      (await fs.readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeGatewayAttempt),
  };
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${targetPath}`);
}

function createGatewayProcessState(
  overrides: Partial<{ exitCode: number | null; signalCode: NodeJS.Signals | null }> = {},
) {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    ...overrides,
  });
}

describe("openclaw test instance", () => {
  it("classifies only exact stderr convergence refusals with status 1", () => {
    const classify = testing.isGatewayMigrationConvergenceRefusal;
    expect(classify(1, null, `notice\n${MIGRATION_CONVERGENCE_REFUSAL} retry\n`)).toBe(true);
    for (const candidate of [
      [2, null, MIGRATION_CONVERGENCE_REFUSAL],
      [1, "SIGTERM", MIGRATION_CONVERGENCE_REFUSAL],
      [1, null, MIGRATION_CONVERGENCE_REFUSAL.slice(0, -1)],
      [1, null, `prefix ${MIGRATION_CONVERGENCE_REFUSAL}`],
    ]) {
      expect(classify(...(candidate as [number, NodeJS.Signals | null, string]))).toBe(false);
    }
  });

  it.each(["refuse", "late-refuse"])(
    "restarts one %s refusal with identical launch state and owns the ready child",
    async (refusalAction) => {
      const { instance, readAttempts } = await createFakeGateway(`${refusalAction},ready`);
      await instance.startGateway();
      const attempts = await readAttempts();
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.pid).not.toBe(attempts[1]?.pid);
      expect({ ...attempts[0], pid: 0 }).toEqual({ ...attempts[1], pid: 0 });
      expect(instance.logs()).toContain(MIGRATION_CONVERGENCE_REFUSAL);
      expect(instance.logs()).toContain(RESTART_MARKER);
      const readyPid = instance.child?.pid;
      expect(readyPid).toBeTypeOf("number");
      await instance.stopGateway();
      expect(instance.child).toBeUndefined();
      expect(isProcessAlive(readyPid as number)).toBe(false);
    },
  );

  it.each(["near", "stdout", "status2", "signal", "unrelated"])(
    "keeps %s convergence lookalikes terminal",
    async (action) => {
      const { instance, readAttempts } = await createFakeGateway(`${action},ready`);
      await expect(instance.startGateway()).rejects.toThrow("gateway exited before readiness");
      expect(await readAttempts()).toHaveLength(1);
      expect(instance.logs()).not.toContain(RESTART_MARKER);
      expect(instance.child).toBeUndefined();
    },
  );

  it("preserves both refusals and never spawns a third gateway", async () => {
    const { instance, readAttempts } = await createFakeGateway("refuse,refuse,ready");
    await expect(instance.startGateway()).rejects.toThrow("gateway exited before readiness");
    expect(await readAttempts()).toHaveLength(2);
    expect(instance.logs().split(MIGRATION_CONVERGENCE_REFUSAL)).toHaveLength(3);
    expect(instance.logs().split(RESTART_MARKER)).toHaveLength(2);
  });

  it("bounds both attempts by one startup deadline", async () => {
    const { instance, readAttempts } = await createFakeGateway("refuse:200,hang", 500);
    const startedAt = Date.now();
    await expect(instance.startGateway()).rejects.toThrow("timeout waiting for gateway readiness");
    expect(await readAttempts()).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThan(650);
  });

  it.runIf(process.platform !== "win32")(
    "SIGKILLs a TERM-resistant gateway group before releasing state",
    async () => {
      const { instance, tracePath } = await createFakeGateway("resist-after-exit", 500, 40);
      const stateRoot = instance.state.root;
      const startedAt = Date.now();
      await expect(instance.startGateway()).rejects.toThrow("gateway exited before readiness");
      const resistantPid = Number(await fs.readFile(`${tracePath}.resistant-pid`, "utf8"));
      expect(await fs.readFile(`${tracePath}.signals`, "utf8")).toBe("SIGTERM");
      expect(instance.child).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(500);
      await expect.poll(() => isProcessAlive(resistantPid), { timeout: 500 }).toBe(false);
      await expect(fs.stat(stateRoot)).resolves.toBeDefined();
      await instance.cleanup();
      await expectPathMissing(stateRoot);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reaps terminal children with inherited stdio before starting a new gateway",
    async () => {
      const { instance, readAttempts, tracePath } = await createFakeGateway(
        "terminal-drain,ready",
        300,
        100,
      );

      const startupError = await instance.startGateway().catch((error: unknown) => error);
      expect(startupError).toBeInstanceOf(Error);
      expect((startupError as Error).message).toContain(
        "gateway exited before readiness (code=7 signal=null)",
      );
      expect((startupError as Error).message).toContain("terminal startup failure");
      expect(instance.child?.exitCode).toBe(7);
      expect(instance.child?.stderr.closed).toBe(false);
      const firstAttempt = (await readAttempts())[0];
      const drainingPid = Number(await fs.readFile(`${tracePath}.draining-pid`, "utf8"));
      expect(isProcessAlive(drainingPid)).toBe(true);

      await fs.writeFile(`${tracePath}.draining-release`, "");
      await instance.startGateway();

      const attempts = await readAttempts();
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.pid).not.toBe(firstAttempt?.pid);
      expect(instance.child?.pid).toBe(attempts[1]?.pid);
      await instance.stopGateway();
      expect(instance.child).toBeUndefined();
      expect(isProcessAlive(attempts[1]?.pid as number)).toBe(false);
      await expect.poll(() => isProcessAlive(drainingPid), { timeout: 500 }).toBe(false);
    },
  );

  it("force-kills Windows gateway descendants before retry cleanup settles", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = {
      exitCode: 1,
      kill: vi.fn(() => true),
      pid: 12345,
      signalCode: null,
      stderr,
      stdout,
    } as unknown as Parameters<typeof testing.stopGatewayProcess>[0];
    const runTaskkill = vi.fn(() => {
      stdout.destroy();
      stderr.destroy();
      return { status: 0 };
    });

    await expect(
      testing.stopGatewayProcess(child, Date.now() + 500, 250, {
        forceWindowsTree: true,
        platform: "win32",
        runTaskkill,
      }),
    ).resolves.toBe(true);

    expect(runTaskkill).toHaveBeenCalledOnce();
    expect(runTaskkill).toHaveBeenCalledWith(
      path.win32.join("C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", "12345", "/T", "/F"],
      {
        killSignal: "SIGKILL",
        stdio: "ignore",
        timeout: 10_000,
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(stdout.closed).toBe(true);
    expect(stderr.closed).toBe(true);
  });

  it("keeps only bounded child output tails in helper logs", () => {
    const stdout = testing.createBoundedStringLog();
    const stderr = testing.createBoundedStringLog();

    testing.appendLogChunk(stdout, `old stdout ${"x".repeat(64)}\n`, 32);
    testing.appendLogChunk(stdout, "recent stdout\n", 32);
    testing.appendLogChunk(stderr, `old stderr ${"y".repeat(64)}\n`, 32);
    testing.appendLogChunk(stderr, "recent stderr\n", 32);

    const logs = testing.formatLogs(stdout, stderr);
    expect(logs).toContain("[output truncated to last");
    expect(logs).toContain("recent stdout");
    expect(logs).toContain("recent stderr");
    expect(logs).not.toContain("old stdout");
    expect(logs).not.toContain("old stderr");
  });

  it("treats signaled gateway children as exited", () => {
    expect(testing.hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(testing.hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(testing.hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("fails startup waits immediately after signaled gateway exits", async () => {
    await expect(
      testing.waitForGatewayReady(
        createGatewayProcessState({ signalCode: "SIGTERM" }),
        [],
        [],
        1,
        10_000,
      ),
    ).rejects.toThrow("gateway exited before readiness");
  });

  it("waits until the gateway readiness probe reports ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"ready":false,"failing":["startup-sidecars"]}', { status: 503 }),
      )
      .mockResolvedValueOnce(new Response('{"ready":true,"failing":[]}', { status: 200 }));

    await expect(
      testing.waitForGatewayReady(createGatewayProcessState(), [], [], 12345, 1_000, fetchImpl),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:12345/readyz");
  });

  it("keeps stalled readiness probes inside the startup deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const startedAt = Date.now();

    await expect(
      testing.waitForGatewayReady(createGatewayProcessState(), [], [], 12345, 25, fetchImpl),
    ).rejects.toThrow("timeout waiting for gateway readiness");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("aborts a stalled readiness probe when the gateway exits", async () => {
    const processState = createGatewayProcessState();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const startedAt = Date.now();
    setTimeout(() => {
      processState.signalCode = "SIGTERM";
      processState.emit("exit", null, "SIGTERM");
    }, 25);

    await expect(
      testing.waitForGatewayReady(processState, [], [], 12345, 5_000, fetchImpl),
    ).rejects.toThrow("gateway exited before readiness");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("signals test instance process groups on POSIX", () => {
    const child = {
      pid: 1234,
      kill: vi.fn(() => true),
    };
    const killProcess = vi.fn(() => true);

    testing.signalOpenClawTestProcess(child, "SIGKILL", killProcess);

    if (process.platform === "win32") {
      expect(killProcess).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } else {
      expect(killProcess).toHaveBeenCalledWith(-1234, "SIGKILL");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("creates isolated config and spawn env without mutating process env", async () => {
    const previousHome = process.env.HOME;
    const inst = await createOpenClawTestInstance({
      name: "instance-unit",
      gatewayToken: "gateway-token",
      hookToken: "hook-token",
      config: {
        gateway: {
          bind: "loopback",
        },
      },
      env: {
        OPENCLAW_SKIP_CRON: "0",
      },
    });

    try {
      expect(process.env.HOME).toBe(previousHome);
      expect(inst.homeDir).toBe(path.join(inst.state.root, "home"));
      expect(inst.stateDir).toBe(path.join(inst.homeDir, ".openclaw"));
      expect(inst.configPath).toBe(path.join(inst.stateDir, "openclaw.json"));
      expect(inst.env.HOME).toBe(inst.homeDir);
      expect(inst.env.OPENCLAW_STATE_DIR).toBe(inst.stateDir);
      expect(inst.env.OPENCLAW_CONFIG_PATH).toBe(inst.configPath);
      expect(inst.env.OPENCLAW_SKIP_CRON).toBe("0");

      const config = JSON.parse(await fs.readFile(inst.configPath, "utf8"));
      expect(config).toStrictEqual({
        gateway: {
          bind: "loopback",
          port: inst.port,
          auth: {
            mode: "token",
            token: "gateway-token",
          },
          controlUi: {
            enabled: false,
          },
        },
        hooks: {
          enabled: true,
          token: "hook-token",
          path: "/hooks",
        },
      });
    } finally {
      await inst.cleanup();
    }

    await expectPathMissing(inst.state.root);
  });
});
