// OpenClaw test instance tests cover spawned test instance lifecycle.
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTestInstance, testing } from "./openclaw-test-instance.js";
import { isProcessAlive } from "./process-wait.js";
import { createDeferred, withTestTimeout } from "./promise.js";

const MIGRATION_CONVERGENCE_REFUSAL =
  "OpenClaw plugin migration inputs changed during startup convergence;";
const RESTART_MARKER =
  "[openclaw-test-instance] restarting gateway after migration convergence refusal";
const fakeInstances: Awaited<ReturnType<typeof createOpenClawTestInstance>>[] = [];
const fakeRoots: string[] = [];
const fakeOperations: Promise<unknown>[] = [];
const fakeControls: FakeGatewayControl[] = [];

type FakeGatewayControl = {
  url: string;
  reached: Promise<void>;
  launches: number[];
  observers: { beforeRelease: () => void; onLaunch: () => void };
  unblock: () => void;
  release: () => Promise<void>;
  close: () => Promise<void>;
};

type FakeGatewayAttempt = {
  argv: string[];
  config: unknown;
  cwd: string;
  env: Record<string, string | undefined>;
  pid: number;
  port: number;
};

afterEach(async () => {
  const controls = fakeControls.splice(0);
  for (const control of controls) {
    control.unblock();
  }
  await Promise.allSettled(fakeOperations.splice(0));
  const results = await Promise.allSettled(
    fakeInstances.splice(0).map(async (instance) => {
      // Baseline failures can spawn after cleanup has already marked itself done.
      try {
        await instance.stopGateway();
        await instance.cleanup();
      } catch (error) {
        fakeInstances.push(instance);
        throw error;
      }
    }),
  );
  const controlResults = await Promise.allSettled(
    controls.map(async (control) => {
      try {
        await control.close();
      } catch (error) {
        fakeControls.push(control);
        throw error;
      }
    }),
  );
  const failures = [...results, ...controlResults].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "fake Gateway cleanup failed; owners and roots retained");
  }
  await Promise.all(fakeRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

function trackOperation<T>(operation: Promise<T>): Promise<T> {
  fakeOperations.push(operation.catch(() => undefined));
  return operation;
}

async function createGatewayControl(): Promise<FakeGatewayControl> {
  const reached = createDeferred<void>();
  const released = createDeferred<void>();
  const launches: number[] = [];
  const observers = { beforeRelease: () => {}, onLaunch: () => {} };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/wait") {
      reached.resolve();
      void released.promise.then(() => response.end("released"));
      return;
    }
    if (url.pathname === "/release") {
      observers.beforeRelease();
      released.resolve();
    } else if (url.pathname === "/launch") {
      launches.push(Number(url.searchParams.get("pid")));
      observers.onLaunch();
    }
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("control server has no port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const control = {
    url,
    reached: reached.promise,
    launches,
    observers,
    unblock: () => released.resolve(),
    release: async () => {
      const response = await fetch(`${url}/release`);
      await response.text();
    },
    close: async () => {
      released.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  fakeControls.push(control);
  return control;
}

async function createFakeGateway(
  sequence: string,
  startTimeoutMs = 1_000,
  stopTimeoutMs = 1_500,
  control?: { url: string; holdPreparation?: boolean },
) {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "openclaw-test-instance-gateway-"));
  fakeRoots.push(cwd);
  const distDir = path.join(cwd, "dist");
  const tracePath = path.join(cwd, "attempts.jsonl");
  // Diagnostic runs keep these receipts outside Vitest's disposable temp tree.
  const processReceipt = `
const registry = ${JSON.stringify(process.env.OPENCLAW_HELPER_PROOF_PID_REGISTRY ?? null)};
function recordFixtureProcess(pid) {
  if (!registry) return;
  let identity;
  try {
    identity = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 1_000 }).trim();
  } catch (error) {
    if (error.status === 1) return;
    throw error;
  }
  appendFileSync(registry, JSON.stringify({ pid, cwd: process.cwd(), identity }) + "\\n");
}
recordFixtureProcess(process.pid);
`;
  await fs.mkdir(distDir);
  await Promise.all([
    ...(control?.holdPreparation
      ? []
      : [
          fs.writeFile(path.join(distDir, ".buildstamp"), ""),
          fs.writeFile(path.join(distDir, ".runtime-postbuildstamp"), ""),
        ]),
    fs.writeFile(
      path.join(distDir, "index.mjs"),
      `
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
${processReceipt}
const tracePath = process.env.OPENCLAW_FAKE_GATEWAY_TRACE;
const controlUrl = process.env.OPENCLAW_FAKE_GATEWAY_CONTROL;
if (controlUrl) await (await fetch(controlUrl + "/launch?pid=" + process.pid)).text();
const countPath = tracePath + ".count";
let attempt = 1;
try { attempt = Number(readFileSync(countPath, "utf8")) + 1; } catch {}
writeFileSync(countPath, String(attempt));
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1]);
const env = Object.fromEntries(["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_STATE_DIR"].map((key) => [key, process.env[key]]));
appendFileSync(tracePath, JSON.stringify({ argv, config: JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")), cwd: process.cwd(), env, pid: process.pid, port }) + "\\n");
const kind = (process.env.OPENCLAW_FAKE_GATEWAY_SEQUENCE || "ready").split(",")[attempt - 1] || "ready";
process.stdout.write("fake gateway attempt " + attempt + "\\n");
const refusal = ${JSON.stringify(MIGRATION_CONVERGENCE_REFUSAL)};
if (kind === "refuse") { process.stderr.write(refusal + " fixture\\n"); process.exit(1); }
if (kind === "late-refuse") {
  const delayed = spawn(process.execPath, ["-e", 'require("node:http").get(process.argv[1] + "/wait", (response) => { response.resume(); response.on("end", () => process.stderr.write(process.argv[2], () => process.exit(0))); });', controlUrl, refusal + " delayed fixture\\n"], { stdio: ["ignore", "ignore", "inherit"] });
  recordFixtureProcess(delayed.pid);
  process.exit(1);
}
if (kind === "resist-after-exit") {
  const resistant = spawn(process.execPath, ["-e", 'const fs = require("node:fs");fs.writeFileSync(process.argv[1], String(process.pid));process.on("SIGTERM", () => fs.appendFileSync(process.argv[2], "SIGTERM"));process.send("ready");setInterval(() => {}, 1_000);', tracePath + ".resistant-pid", tracePath + ".signals"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await new Promise((resolve) => resistant.once("message", resolve));
  recordFixtureProcess(resistant.pid);
  process.stderr.write("unrelated startup failure\\n"); process.exit(1);
}
if (kind === "terminal-drain" || kind === "refusal-drain") {
  const draining = spawn(process.execPath, ["-e", 'const fs = require("node:fs");const release = process.argv[1];const deadline = Date.now() + 5_000;const timer = setInterval(() => { if (fs.existsSync(release) || Date.now() >= deadline) clearInterval(timer); }, 10);', tracePath + ".draining-release"], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
  draining.unref();
  recordFixtureProcess(draining.pid);
  writeFileSync(tracePath + ".draining-pid", String(draining.pid));
  process.stderr.write(kind === "refusal-drain" ? refusal + " held fixture\\n" : "terminal startup failure\\n"); process.exit(kind === "refusal-drain" ? 1 : 7);
}
if (kind === "near") { process.stderr.write(refusal.slice(0, -1) + " fixture\\n"); process.exit(1); }
if (kind === "stdout") { process.stdout.write(refusal + " fixture\\n"); process.exit(1); }
if (kind === "status2") { process.stderr.write(refusal + " fixture\\n"); process.exit(2); }
if (kind === "signal") { process.stderr.write(refusal + " fixture\\n"); process.kill(process.pid, "SIGTERM"); }
if (kind === "unrelated") { process.stderr.write("unrelated startup failure\\n"); process.exit(1); }
const server = createServer(async (req, res) => {
  if (req.url === "/readyz" && kind === "held-ready") await (await fetch(controlUrl + "/wait")).text();
  res.writeHead(req.url === "/readyz" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ready: req.url === "/readyz" && kind !== "never-ready" }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0))); server.listen(port, "127.0.0.1");
`,
    ),
  ]);
  if (control?.holdPreparation) {
    await fs.mkdir(path.join(cwd, "scripts"));
    // This is a fixture bootstrap, not the repository's build entrypoint.
    await fs.writeFile(
      path.join(cwd, "scripts", "run-node.mjs"),
      `import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
${processReceipt}
await (await fetch(${JSON.stringify(`${control.url}/wait`)})).text();
writeFileSync("dist/.buildstamp", "");
writeFileSync("dist/.runtime-postbuildstamp", "");
`,
    );
  }
  const instance = await createOpenClawTestInstance({
    name: `fake-gateway-${path.basename(cwd)}`,
    cwd,
    env: {
      OPENCLAW_FAKE_GATEWAY_SEQUENCE: sequence,
      OPENCLAW_FAKE_GATEWAY_TRACE: tracePath,
      OPENCLAW_FAKE_GATEWAY_CONTROL: control?.url,
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
  it("joins concurrent starts until the real readiness response arrives", async () => {
    const control = await createGatewayControl();
    const { instance } = await createFakeGateway("held-ready", 1_000, 1_500, control);
    const firstStart = trackOperation(instance.startGateway());
    await Promise.race([control.reached, firstStart]);

    let secondSettled = false;
    let settledBeforeReady: boolean | undefined;
    const secondStart = trackOperation(
      instance.startGateway().finally(() => {
        secondSettled = true;
      }),
    );
    // Observe at a real HTTP boundary before the child's held /readyz can reply.
    control.observers.beforeRelease = () => {
      settledBeforeReady = secondSettled;
    };
    await control.release();
    await Promise.all([firstStart, secondStart]);

    expect(settledBeforeReady).toBe(false);
    expect(control.launches).toHaveLength(1);
    expect(instance.child?.pid).toBe(control.launches[0]);
    const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
    expect(await response.json()).toEqual({ ready: true });
  });

  it("orders a new start after an intervening stop instead of joining the earlier start", async () => {
    const control = await createGatewayControl();
    const { instance } = await createFakeGateway("held-ready,ready", 1_000, 1_500, control);
    const firstStart = trackOperation(instance.startGateway());
    await Promise.race([control.reached, firstStart]);
    const stopped = trackOperation(instance.stopGateway());
    const secondStart = trackOperation(instance.startGateway());

    await control.release();
    await Promise.allSettled([firstStart]);
    await stopped;
    await secondStart;

    expect(control.launches).toHaveLength(2);
    expect(control.launches[1]).not.toBe(control.launches[0]);
    expect(isProcessAlive(control.launches[0]!)).toBe(false);
    expect(instance.child?.pid).toBe(control.launches[1]);
    const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
    expect(await response.json()).toEqual({ ready: true });
  });

  it("starts a ready replacement after a real readiness deadline expires", async () => {
    const control = await createGatewayControl();
    const { instance } = await createFakeGateway("never-ready,ready", 1_000, 1_500, control);
    await expect(trackOperation(instance.startGateway())).rejects.toThrow(
      "timeout waiting for gateway readiness",
    );
    const firstPid = control.launches[0];
    expect(firstPid).toBeTypeOf("number");

    await trackOperation(instance.startGateway());
    const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
    expect(await response.json()).toEqual({ ready: true });
    expect(control.launches).toHaveLength(2);
    expect(control.launches[1]).not.toBe(firstPid);
    expect(instance.child?.pid).toBe(control.launches[1]);
    expect(isProcessAlive(firstPid as number)).toBe(false);
  });

  it.each(["stopGateway", "cleanup"] as const)(
    "does not launch after %s settles during entrypoint preparation",
    async (method) => {
      const control = await createGatewayControl();
      const { instance } = await createFakeGateway("ready", 1_000, 1_500, {
        url: control.url,
        holdPreparation: true,
      });
      const firstStart = trackOperation(instance.startGateway());
      await Promise.race([control.reached, firstStart]);
      let teardownSettled = false;
      let launchedAfterTeardown = false;
      control.observers.onLaunch = () => {
        launchedAfterTeardown ||= teardownSettled;
      };
      const teardown = trackOperation(
        instance[method]().finally(() => {
          teardownSettled = true;
        }),
      );

      // A valid owner may join startup or cancel this instance. Release preparation
      // before joining teardown so either policy can complete without a deadlock.
      await control.release();
      const [, stopped] = await Promise.allSettled([firstStart, teardown]);
      expect(stopped.status).toBe("fulfilled");
      expect(launchedAfterTeardown).toBe(false);
      expect(instance.child).toBeUndefined();
      await instance.cleanup();
      await expectPathMissing(instance.state.root);
      for (const pid of control.launches) {
        expect(isProcessAlive(pid)).toBe(false);
      }
    },
  );

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
      const control = refusalAction === "late-refuse" ? await createGatewayControl() : undefined;
      const { instance, readAttempts } = await createFakeGateway(
        `${refusalAction},ready`,
        1_000,
        1_500,
        control,
      );
      const exited = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
      if (control) {
        control.observers.onLaunch = () => {
          if (control.launches.length !== 1) return;
          const leader = instance.child;
          if (!leader) {
            exited.reject(new Error("fixture launched without a process owner"));
            return;
          }
          leader.once("exit", (code, signal) => exited.resolve({ code, signal }));
        };
      }
      const startup = trackOperation(instance.startGateway());
      try {
        if (control) {
          expect(await Promise.race([exited.promise, startup])).toEqual({ code: 1, signal: null });
          await Promise.race([control.reached, startup]);
          expect(instance.child?.stderr.closed).toBe(false);
          expect(instance.logs()).not.toContain(MIGRATION_CONVERGENCE_REFUSAL);
          // /launch installs the exit observer before the leader proceeds. Only
          // release its waiting stderr writer after that native exit, never a timer.
          await control.release();
        }
        await startup;
      } finally {
        control?.unblock();
        await Promise.allSettled([startup]);
      }
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

  it.runIf(process.platform !== "win32")(
    "preserves an eligible refusal when its startup deadline expires during stdio drain",
    async () => {
      const startupBudgetMs = 500;
      const control = await createGatewayControl();
      const { instance, tracePath, readAttempts } = await createFakeGateway(
        "refusal-drain,ready",
        startupBudgetMs,
        1_500,
        control,
      );
      const exited = createDeferred<{
        code: number | null;
        signal: NodeJS.Signals | null;
        at: number;
      }>();
      control.observers.onLaunch = () => {
        const leader = instance.child;
        if (!leader) {
          exited.reject(new Error("fixture launched without a process owner"));
          return;
        }
        leader.once("exit", (code, signal) => exited.resolve({ code, signal, at: Date.now() }));
      };
      let startupSettled = false;
      const startup = trackOperation(
        instance.startGateway().finally(() => {
          startupSettled = true;
        }),
      );
      try {
        const firstExit = await Promise.race([exited.promise, startup]);
        expect(firstExit).toMatchObject({ code: 1, signal: null });
        if (!firstExit) throw new Error("startup settled before the fixture leader exited");
        // The startup clock precedes leader exit. Holding stdio for a full budget
        // after that event expires retry admission without measuring cold launch time.
        const admissionExpiredAt = firstExit.at + startupBudgetMs;
        while (Date.now() < admissionExpiredAt) {
          await delay(admissionExpiredAt - Date.now());
        }
        const drainingPid = Number(await fs.readFile(`${tracePath}.draining-pid`, "utf8"));
        expect(instance.child?.stderr.closed).toBe(false);
        expect(isProcessAlive(drainingPid)).toBe(true);
        expect(startupSettled).toBe(false);

        await fs.writeFile(`${tracePath}.draining-release`, "");
        await expect(startup).rejects.toThrow(
          "gateway exited before readiness (code=1 signal=null)",
        );
        expect(instance.logs()).toContain(MIGRATION_CONVERGENCE_REFUSAL);
        expect(instance.logs()).not.toContain(RESTART_MARKER);
        expect(await readAttempts()).toHaveLength(1);
        expect(instance.child).toBeUndefined();
        await expect.poll(() => isProcessAlive(drainingPid), { timeout: 500 }).toBe(false);
      } finally {
        await fs.writeFile(`${tracePath}.draining-release`, "");
        await Promise.allSettled([startup]);
      }
    },
  );

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
      const stopTimeoutMs = 100;
      const { instance, readAttempts, tracePath } = await createFakeGateway(
        "terminal-drain,ready",
        300,
        stopTimeoutMs,
      );

      const startup = trackOperation(instance.startGateway());
      try {
        const startupError = await startup.catch((error: unknown) => error);
        expect(startupError).toBeInstanceOf(Error);
        expect((startupError as Error).message).toContain(
          "gateway exited before readiness (code=7 signal=null)",
        );
        expect((startupError as Error).message).toContain("terminal startup failure");
        const firstChild = instance.child;
        expect(firstChild?.exitCode).toBe(7);
        expect(firstChild?.stderr.closed).toBe(false);
        if (!firstChild) throw new Error("terminal fixture lost its process owner");
        const firstAttempt = (await readAttempts())[0];
        const drainingPid = Number(await fs.readFile(`${tracePath}.draining-pid`, "utf8"));
        expect(isProcessAlive(drainingPid)).toBe(true);

        // Keep the inherited pipe held through a complete failed restart: eventual
        // replacement after release alone cannot prove that stale ownership blocked it.
        await expect(trackOperation(instance.startGateway())).rejects.toThrow(
          new Error(`gateway process did not close before stop deadline\n${instance.logs()}`),
        );
        expect(instance.child).toBe(firstChild);
        expect(firstChild.stderr.closed).toBe(false);
        expect(isProcessAlive(drainingPid)).toBe(true);
        expect(await readAttempts()).toHaveLength(1);

        // Register before release, but charge only post-release drain to the stop budget.
        const closed = trackOperation(once(firstChild, "close"));
        await fs.writeFile(`${tracePath}.draining-release`, "");
        await withTestTimeout(
          closed,
          stopTimeoutMs * 2,
          "terminal fixture did not close after release",
        );
        expect(firstChild.stdout.closed).toBe(true);
        expect(firstChild.stderr.closed).toBe(true);
        await trackOperation(instance.startGateway());

        const attempts = await readAttempts();
        expect(attempts).toHaveLength(2);
        expect(attempts[1]?.pid).not.toBe(firstAttempt?.pid);
        expect(instance.child?.pid).toBe(attempts[1]?.pid);
        await instance.stopGateway();
        expect(instance.child).toBeUndefined();
        expect(isProcessAlive(attempts[1]?.pid as number)).toBe(false);
        await expect.poll(() => isProcessAlive(drainingPid), { timeout: 500 }).toBe(false);
      } finally {
        await fs.writeFile(`${tracePath}.draining-release`, "");
        await Promise.allSettled([startup]);
      }
    },
  );

  it("force-kills Windows gateway descendants before retry cleanup settles", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const kill = vi.fn(() => true);
    const child = {
      exitCode: 1,
      kill,
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
    expect(kill).not.toHaveBeenCalled();
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
        init?.signal?.addEventListener(
          "abort",
          () => {
            const reason = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          },
          { once: true },
        );
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
        init?.signal?.addEventListener(
          "abort",
          () => {
            const reason = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason)));
          },
          { once: true },
        );
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
