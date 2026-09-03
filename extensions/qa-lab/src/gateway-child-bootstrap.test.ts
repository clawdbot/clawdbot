import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as realTimeout } from "node:timers";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { isQaPosixProcessGroupAlive } from "./posix-process-group.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

// RPC is outside these process-lifetime tests. HTTP readiness and all processes stay real.
vi.mock("./gateway-rpc-client.js", () => ({
  startQaGatewayRpcClient: async () => ({ request: async () => ({}), stop: async () => {} }),
}));

type FixtureRecord = {
  kind: string;
  pid: number;
  pgid: number;
  descendant?: number;
  tempRoot?: string;
  submittedKey?: string;
};

// The fixture never contacts a provider or stores auth. Its independent failsafes
// and the parent watchdog also bound cleanup when the production owner is broken.
const fixtureSource = String.raw`
import fs from "node:fs";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
const [record, phase, mode, command, ...args] = process.argv.slice(2);
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const write = (kind, extra = {}) => fs.appendFileSync(record,
  JSON.stringify({ kind, pid: process.pid, pgid, ...extra }) + "\n");
if (command === "descendant") {
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(20), 30_000);
  write("descendant");
  process.send("ready");
} else {
  let input = "";
  if (command === "models") for await (const chunk of process.stdin) input += chunk;
  const current = command === "models" ? args[args.indexOf("--provider") + 1]
    : command === "update" ? (args.includes("--help") ? "help" : "repair") : command;
  write(current);
  if (current === phase) {
    process.on("SIGTERM", () => {
      if (mode === "running") for (const [fd, label] of [[1, "stdout"], [2, "stderr"]]) {
        try { fs.writeSync(fd, "\nshutdown " + label + " diagnostic apiKey=synthetic-drain-secret\n"); }
        catch { /* The fault matrix can close either parent-side pipe. */ }
      }
    });
    setTimeout(() => process.exit(20), 30_000);
    const child = spawn(process.execPath, [process.argv[1], record, phase, mode, "descendant"],
      { stdio: ["ignore", mode === "closed-pipes" ? "ignore" : "inherit", mode === "closed-pipes" ? "ignore" : "inherit", "ipc"] });
    await once(child, "message");
    write("ready", { descendant: child.pid, tempRoot: process.env.OPENCLAW_QA_TEMP_ROOT,
      ...(mode === "failure" ? { submittedKey: input.trim() } : {}) });
    if (mode === "running") {
      fs.writeSync(2, "plugin registry still pending apiKey=synthetic-stderr-secret\n::error::stderr diagnostic\nstderr ready\n");
      fs.writeSync(1, "diagnostic ".repeat(400) + "\nplugin scan still pending Authorization: Bearer synthetic-stdout-secret\n##[error]stdout diagnostic\nstdout ready\n");
    }
    if (mode !== "running") {
      if (mode === "failure") fs.writeSync(2, "Authorization: Bearer " + input.trim() + "\ncontext retained\n" + "diagnostic ".repeat(400));
      process.stdout.write("fixture-output");
      process.exit(mode === "failure" ? 17 : 0);
    }
  } else if (current === "gateway") {
    http.createServer((_request, response) => response.end("ok"))
      .listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
  } else {
    if (current === "help") process.stdout.write("--accept-capabilities");
    process.exit(0);
  }
}
`;

async function bounded<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realTimeout(() => reject(new Error("bootstrap operation did not settle")), ms);
      }),
    ]);
  } finally {
    clearRealTimeout(timer);
  }
}

const dirs = createTempDirHarness();
const cleanups: Array<() => Promise<void>> = [];
const realKill = process.kill.bind(process);
beforeEach(() => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
  vi.stubEnv("OPENCLAW_QA_KEEP_TEMP", undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    await dirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function fixture(phase: string, mode: string) {
  const root = await dirs.makeTempDir("qa-bootstrap-lifetime-");
  const record = path.join(root, "events.jsonl");
  const cli = path.join(root, "fixture.mjs");
  await fs.writeFile(cli, fixtureSource);
  const records = (): FixtureRecord[] =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const pidAlive = (pid: number) => {
    try {
      realKill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return false;
      }
      throw error;
    }
    // ps handles both zombie orphans and exit between the independent probes.
    const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    if (state.error) {
      throw state.error;
    }
    return state.status === 0 && !state.stdout.trim().startsWith("Z");
  };
  const assertStopped = () => {
    for (const entry of records()) {
      expect(pidAlive(entry.pid), `fixture PID ${entry.pid}`).toBe(false);
      if (entry.pid === entry.pgid) {
        expect(isQaPosixProcessGroupAlive(entry.pgid)).toBe(false);
      }
    }
  };
  const killFixtures = () => {
    for (const pid of new Set(records().map((entry) => entry.pid))) {
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("invalid fixture PID");
      }
      try {
        realKill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
  const owner = createQaGatewayChild();
  const pending: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>) => {
    const observed = promise.catch((error: unknown) => error);
    pending.push(observed);
    return observed;
  };
  const watchdog = realTimeout(killFixtures, 20_000);
  cleanups.push(async () => {
    try {
      // Close admission first, then independently kill children even if stop hangs.
      const stopping = owner.stop();
      killFixtures();
      await bounded(Promise.all([...pending, stopping]));
      await vi.waitFor(assertStopped, { timeout: 5_000 });
    } finally {
      clearRealTimeout(watchdog);
    }
  });
  const command = {
    executablePath: process.execPath,
    argsPrefix: [cli, record, phase, mode],
    tempParentDir: root,
    usePackagedPlugins: true,
  };
  return {
    root,
    records,
    assertStopped,
    owner,
    track,
    command,
    start: () =>
      owner.start({
        repoRoot: process.cwd(),
        command,
        providerMode: "mock-openai",
        controlUiEnabled: false,
        transportBaseUrl: "http://127.0.0.1:1",
      }),
    ready: async (count = 1) => {
      await vi.waitFor(
        () => expect(records().filter((entry) => entry.kind === "ready")).toHaveLength(count),
        { timeout: 10_000 },
      );
      const ready = records().filter((entry) => entry.kind === "ready");
      for (const entry of ready) {
        expect(entry.pgid).toBe(entry.pid);
        expect(records().find((item) => item.pid === entry.descendant)?.pgid).toBe(entry.pgid);
      }
      return ready;
    },
  };
}

describe.skipIf(process.platform === "win32")("packaged QA bootstrap lifetime", () => {
  it.each([
    { phase: "openai", mode: "running" },
    { phase: "anthropic", mode: "running" },
    { phase: "help", mode: "leader-exited" },
    { phase: "repair", mode: "leader-exited" },
  ])("stops during $phase ($mode) before any gateway spawn", async ({ phase, mode }) => {
    const f = await fixture(phase, mode);
    const starting = f.track(f.start());
    const [ready] = await f.ready();
    await expect(bounded(f.owner.stop())).resolves.toEqual({
      process: "confirmed-stopped",
      errors: [],
    });
    expect(await bounded(starting)).toBeInstanceOf(Error);
    f.assertStopped();
    expect(f.records().some((entry) => entry.kind === "gateway")).toBe(false);
    expect(existsSync(ready!.tempRoot!)).toBe(false);
  });

  it("owns overlapping post-start commands without displacing the gateway", async () => {
    const f = await fixture("hang", "running");
    const gateway = await f.start();
    const pid = gateway.pid;
    const commands = [f.track(gateway.runCli(["hang"])), f.track(gateway.runCli(["hang"]))];
    await f.ready(2);
    expect(gateway.pid).toBe(pid);
    expect(isQaPosixProcessGroupAlive(pid!)).toBe(true);
    await expect(bounded(f.owner.stop())).resolves.toEqual({
      process: "confirmed-stopped",
      errors: [],
    });
    for (const command of commands) {
      expect(await bounded(command)).toBeInstanceOf(Error);
    }
    f.assertStopped();
    expect(() => gateway.runCli(["hang"])).toThrow("lifecycle is closed");
  });

  it.each(["leader-exited", "closed-pipes"])(
    "settles descendants after successful CLI exit (%s)",
    async (mode) => {
      const f = await fixture("probe", mode);
      const lifetime = new QaGatewayChildLifecycle();
      const command = f.track(
        runQaGatewayCliCommand({
          ...f.command,
          lifetime,
          args: ["probe"],
          cwd: f.root,
          env: { HOME: f.root },
        }),
      );
      cleanups.push(async () => {
        await lifetime.stop();
      });
      await f.ready();
      expect(await bounded(command)).toBe("fixture-output");
      f.assertStopped();
      await expect(lifetime.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    },
  );

  it.each(["timeout", "cancel", "stdout", "stderr", "stdin", "process"] as const)(
    "retains bounded redacted diagnostics after %s failure and settles the real CLI tree",
    async (failure) => {
      const f = await fixture("probe", "running");
      const lifetime = new QaGatewayChildLifecycle();
      const registration = vi.spyOn(lifetime, "register");
      if (failure === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const command = f.track(
        runQaGatewayCliCommand({
          ...f.command,
          lifetime,
          args: ["probe", "unlabeled-argv-secret"],
          cwd: f.root,
          env: { HOME: f.root, QA_SYNTHETIC_SECRET: "unlabeled-env-secret" },
          stdin: failure === "stdin" ? "unlabeled-stdin-secret" : undefined,
        }),
      );
      cleanups.push(async () => {
        await lifetime.stop();
      });
      const child = registration.mock.calls[0]![0];
      const observed = { stdout: "", stderr: "" };
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream]!.on("data", (chunk) => (observed[stream] += String(chunk)));
      }
      await f.ready();
      await vi.waitFor(() => {
        expect(observed.stdout).toContain("stdout ready");
        expect(observed.stderr).toContain("stderr ready");
      });
      let stopping: Promise<unknown> | undefined;
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(120_000);
      } else if (failure === "cancel") {
        stopping = f.track(lifetime.stop());
      } else {
        const error = Object.assign(
          new AggregateError(
            [new Error("unlabeled-nested-secret")],
            "apiKey=synthetic-stream-secret",
            { cause: new Error("unlabeled-cause-secret") },
          ),
          { spawnargs: ["unlabeled-spawnargs-secret"], env: { key: "unlabeled-error-env-secret" } },
        );
        if (failure === "process") {
          child.emit("error", error);
        } else if (failure === "stdin") {
          child.stdin!.emit("error", error);
        } else {
          await bounded(
            new Promise<void>((resolve) => {
              child[failure]!.once("error", () => resolve());
              child[failure]!.destroy(error);
            }),
          );
        }
      }
      (failure === "process" ? child.stderr! : child).emit("error", new Error("later failure"));
      const error = await bounded(command);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected CLI failure");
      }
      expect(error.message).toContain(
        failure === "timeout"
          ? "exceeded 120000ms"
          : failure === "cancel"
            ? "CLI cancelled"
            : `${failure} failed`,
      );
      expect(error.message).not.toContain("later failure");
      expect(error.message).toContain("plugin registry still pending apiKey=<redacted>");
      expect(error.message).toContain("plugin scan still pending Authorization: Bearer <redacted>");
      expect(error.message.indexOf("plugin registry")).toBeLessThan(
        error.message.indexOf("plugin scan"),
      );
      for (const stream of ["stdout", "stderr"] as const) {
        if (failure !== stream) {
          expect(error.message).toContain(`shutdown ${stream} diagnostic apiKey=<redacted>`);
        }
      }
      expect(error.message.length).toBeLessThanOrEqual(2_048);
      expect(error.message).toContain(": :error::stderr diagnostic");
      expect(error.message).toContain("# #[error]stdout diagnostic");
      expect(error.message).not.toMatch(/(^|[\r\n])[^\S\r\n]*::/u);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("errors");
      const diagnostic = inspect(error, { depth: null });
      expect(diagnostic).not.toMatch(/synthetic-[\w-]+-secret|unlabeled-[\w-]+-secret/u);
      f.assertStopped();
      if (stopping) {
        expect(await bounded(stopping)).toEqual({ process: "confirmed-stopped", errors: [] });
      }
      await expect(lifetime.stop()).resolves.toEqual({ process: "confirmed-stopped", errors: [] });
    },
  );

  it("retains denied bootstrap shutdown and safely reports combined failures until a later stop", async () => {
    const f = await fixture("openai", "failure");
    const signalFault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const ready = f.records().find((entry) => entry.kind === "ready");
      if (ready && pid === -ready.pgid && (signal === "SIGTERM" || signal === "SIGKILL")) {
        throw Object.assign(new Error("synthetic group signal denied"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    const starting = f.track(f.start());
    const [ready] = await f.ready();
    const error = await bounded(starting);
    expect(error).toBeInstanceOf(AggregateError);
    const diagnostic = inspect(error, { depth: null });
    expect(diagnostic).toContain("OpenClaw CLI exited 17");
    expect(diagnostic).toContain("process tree remained alive");
    expect(ready!.submittedKey).toMatch(/^sk-qa-mock-[a-f0-9]{32}$/u);
    expect(diagnostic).not.toContain(ready!.submittedKey);
    expect(diagnostic).not.toContain("diagnostic ".repeat(400));
    const stopped = await bounded(f.owner.stop());
    expect(stopped.process).toBe("unconfirmed");
    expect(stopped.errors.length).toBeGreaterThan(0);
    expect(inspect(stopped, { depth: null })).not.toContain(ready!.submittedKey);
    expect(isQaPosixProcessGroupAlive(ready!.pgid)).toBe(true);
    expect(existsSync(ready!.tempRoot!)).toBe(true);
    expect(f.records().some((entry) => entry.kind === "gateway")).toBe(false);
    signalFault.mockRestore();
    await expect(bounded(f.owner.stop())).resolves.toEqual({
      process: "confirmed-stopped",
      errors: [],
    });
    f.assertStopped();
    expect(existsSync(ready!.tempRoot!)).toBe(false);
  });
});
