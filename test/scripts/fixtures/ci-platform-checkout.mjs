import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isPidAlive } from "../../../src/shared/pid-alive.ts";

const [mode, root, policyScenario, ...args] = process.argv.slice(2);
const linux = policyScenario.startsWith("linux:");
const scenario = linux ? policyScenario.slice("linux:".length) : policyScenario;
const fixture = fileURLToPath(import.meta.url);
const workspace = path.join(root, "workspace");
const lease = path.join(root, "lease");
const recordsDir = path.join(root, "pids");
const eventsFile = path.join(root, "events.jsonl");
const commandsFile = path.join(root, "commands.jsonl");

function publish(name, value) {
  const target = path.join(root, name);
  fs.writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify(value));
  fs.renameSync(`${target}.${process.pid}.tmp`, target);
}

function record(pid, role, attempt = 0) {
  publish(`pids/${pid}.json`, { pid, role, attempt });
}

function records() {
  // Keep producer observations and shutdown reports in the same order.
  return fs
    .readdirSync(recordsDir)
    .filter((file) => file.endsWith(".json"))
    .toSorted()
    .map((file) => JSON.parse(fs.readFileSync(path.join(recordsDir, file), "utf8")));
}

function liveRecords() {
  const owned = records();
  if (process.platform === "win32") {
    return owned.filter((entry) => isPidAlive(entry.pid));
  }
  // PID existence includes macOS zombies; observe active writers in one POSIX snapshot.
  const result = spawnSync("/bin/ps", ["-axo", "pid=,stat="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Fixture process census failed (${result.error?.code ?? result.status})`);
  }
  const alive = new Set();
  for (const line of result.stdout.trim().split("\n")) {
    const [pid, state] = line.trim().split(/\s+/u);
    if (!Number.isInteger(Number(pid)) || !state) {
      throw new Error("Fixture process census returned an invalid row");
    }
    if (!state.startsWith("Z")) {
      alive.add(Number(pid));
    }
  }
  return owned.filter((entry) => alive.has(entry.pid));
}

function boundary(name) {
  const alive = liveRecords();
  fs.appendFileSync(
    eventsFile,
    `${JSON.stringify({
      name,
      alive: alive.filter((entry) => entry.attempt > 0),
      sentinelAlive: alive.some((entry) => entry.role === "sentinel"),
    })}\n`,
  );
}

async function until(predicate, label, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(10);
  }
}

function launch(role, attempt) {
  const child = spawn(process.execPath, [fixture, role, root, policyScenario, String(attempt)], {
    stdio: "ignore",
  });
  child.on("error", (error) => {
    throw error;
  });
  child.unref();
}

function holdLease() {
  // Orphans stop themselves when the supervisor releases the lease; no PID discovery/kills.
  // The independent ceiling also covers a supervisor killed before it can unlink the lease.
  const deadline = Date.now() + 60_000;
  setInterval(() => {
    if (!fs.existsSync(lease) || Date.now() >= deadline) {
      process.exit(0);
    }
  }, 20);
  if (!fs.existsSync(lease)) {
    process.exit(0);
  }
}

function insideWorkspace(target) {
  const resolved = path.resolve(target);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Fixture command escaped workspace: ${target}`);
  }
  return resolved;
}

async function command() {
  holdLease();
  record(process.pid, mode);
  if (mode === "sentinel") {
    return;
  }
  if (mode === "find") {
    insideWorkspace(args[0]);
    // Observe before the real deletion, while prior Git children can still write.
    boundary("delete");
    const result = spawnSync("/usr/bin/find", args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (mode === "child" || mode === "grandchild") {
    const attempt = Number(args[0]);
    process.on("SIGTERM", () => {});
    record(process.pid, mode, attempt);
    if (mode === "child") {
      // Startup faults belong to the caller, not every consumer of this shared fixture.
      const startDelay = path.join(root, `tree-start-delay-${attempt}.json`);
      if (fs.existsSync(startDelay)) {
        await delay(JSON.parse(fs.readFileSync(startDelay, "utf8")));
      }
      launch("grandchild", attempt);
    } else {
      publish(`ready-${attempt}.json`, attempt);
    }
    return;
  }
  if (mode !== "git") {
    throw new Error(`Unexpected fixture mode: ${mode}`);
  }
  let cwd = workspace;
  while (args[0] === "-C" || args[0] === "-c") {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "-C") {
      cwd = insideWorkspace(value);
    }
  }
  fs.appendFileSync(commandsFile, `${JSON.stringify({ cwd, args })}\n`);
  const operation = args.shift();
  if (operation === "init") {
    boundary("init");
    const config = path.join(root, "fixture-config.json");
    if (fs.existsSync(config)) {
      await delay(JSON.parse(fs.readFileSync(config, "utf8")).initDelayMs);
    }
    fs.mkdirSync(insideWorkspace(args[0]), { recursive: true });
    if (linux && cwd === workspace) {
      if (fs.readdirSync(workspace).length !== 0) {
        throw new Error("Previous checkout survived workspace deletion");
      }
      fs.writeFileSync(path.join(workspace, ".previous-checkout"), "owned\n");
    }
  } else if (operation === "fetch") {
    const counter = path.join(root, "attempt.json");
    const attempt = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, "utf8")) + 1 : 1;
    boundary(`fetch:${attempt}`);
    publish("attempt.json", attempt);
    record(process.pid, "parent", attempt);
    launch("child", attempt);
    await until(() => fs.existsSync(path.join(root, `ready-${attempt}.json`)), "tree readiness");
    if (scenario.startsWith("cancel-")) {
      const owned = liveRecords();
      const alive = owned.filter((entry) => entry.attempt === attempt);
      if (
        !["parent", "child", "grandchild"].every((role) =>
          alive.some((entry) => entry.role === role),
        )
      ) {
        throw new Error("Cancellation tree is no longer alive");
      }
      const owner = owned.find((entry) => entry.role === "shell");
      // Both shells exec their replacements. Validate the current Python parent,
      // never an orphan's new parent or the Git group, before sending cancellation.
      if (!owner || owner.pid <= 1 || process.ppid !== owner.pid) {
        throw new Error("Cancellation owner is no longer the registered workflow parent");
      }
      const signal = scenario.slice("cancel-".length);
      fs.writeSync(1, `cancellation: ${JSON.stringify({ signal, owner: owner.pid, alive })}\n`);
      process.kill(owner.pid, signal);
    }
    if (scenario === "early-leader-exit") {
      process.exit(0);
    }
    if (scenario === "recovery" && attempt >= 3) {
      process.exit(0);
    }
    if (scenario === "harness-timeout" && cwd === workspace) {
      process.exit(0);
    }
    if (scenario === "harness-recovery" && (cwd === workspace || attempt > 2)) {
      process.exit(0);
    }
    if (scenario === "checkout-failure") {
      process.exit(0);
    }
    if (scenario === "git-failure") {
      process.exit(23);
    }
    if (scenario === "git-exit-124") {
      process.exit(124);
    }
    // Expire the two-second fetch budget only after the full tree is ready.
    // Immutable ticks avoid replacing a clock file held open by Windows readers.
    // Cancellation scenarios signal from the ready fetch without advancing this clock.
    if (!scenario.startsWith("cancel-")) {
      publish(`fetch-tick-${attempt}.json`, attempt);
    }
    return;
  } else if (operation === "checkout") {
    boundary(cwd === workspace ? "checkout" : "harness-checkout");
    if (scenario === "checkout-failure") {
      process.exit(23);
    }
    if (linux || cwd !== workspace) {
      const action = path.join(cwd, ".github/actions/setup-node-env");
      fs.mkdirSync(action, { recursive: true });
      fs.writeFileSync(path.join(action, "action.yml"), "fixture\n");
    }
  } else if (!["config", "remote", "sparse-checkout", "fetch"].includes(operation)) {
    throw new Error(`Unexpected fake git command: ${operation}`);
  }
  process.exit(0);
}

async function supervise() {
  fs.mkdirSync(recordsDir);
  fs.writeFileSync(eventsFile, "");
  fs.writeFileSync(commandsFile, "");
  fs.writeFileSync(lease, "owned\n");
  const bin = path.join(root, "bin");
  const commandPath = `${bin}${path.delimiter}${process.env.PATH}`;
  const home = path.join(root, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  // Git Bash accepts forward-slash native paths; native Node records native Windows PIDs.
  const shellPath = (value) => value.replaceAll("\\", "/");
  const gitArgs = [process.execPath, fixture, "git", root, policyScenario];
  // Python's native Windows Popen needs a batch/executable entrypoint, not a
  // Bash shebang. Do not shadow it with an extensionless script on Windows.
  if (process.platform === "win32") {
    const argv = gitArgs.map((value) => `"${value}"`);
    fs.writeFileSync(path.join(bin, "git.cmd"), `@echo off\r\n${argv.join(" ")} %*\r\n`);
  } else {
    const argv = gitArgs.map((value) => quote(shellPath(value)));
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/bash\nexec ${argv.join(" ")} "$@"\n`, {
      mode: 0o755,
    });
  }
  if (linux) {
    const argv = [process.execPath, fixture, "find", root, policyScenario].map(quote);
    fs.writeFileSync(path.join(bin, "find"), `#!/bin/bash\nexec ${argv.join(" ")} "$@"\n`, {
      mode: 0o755,
    });
  }
  if (scenario === "cleanup-failure") {
    // Fail the real POSIX inspection boundary, without a production injection hook.
    fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  if (scenario.startsWith("non-executable-")) {
    fs.chmodSync(path.join(bin, scenario.slice("non-executable-".length)), 0o644);
  }
  const output = fs.openSync(path.join(root, "workflow.log"), "w");
  let shell;
  let stopping;
  const report = {
    code: null,
    boundaries: [],
    readyAttempts: [],
    cleanupRemaining: [],
    ownedProcesses: [],
    commands: [],
    output: "",
  };
  const stop = (error) => {
    stopping ??= (async () => {
      if (error) {
        report.error = String(error);
      }
      fs.rmSync(lease, { force: true });
      if (shell && shell.exitCode === null && shell.signalCode === null) {
        // Only this fixture's still-owned detached shell group may be signaled.
        if (process.platform === "win32") {
          const taskkill = path.join(process.env.SystemRoot, "System32", "taskkill.exe");
          spawnSync(taskkill, ["/PID", String(shell.pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 2_000,
            killSignal: "SIGKILL",
          });
        } else {
          try {
            process.kill(-shell.pid, "SIGKILL");
          } catch (err) {
            if (err.code !== "ESRCH") {
              throw err;
            }
          }
        }
      }
      try {
        await until(() => liveRecords().length === 0, "fixture cleanup");
      } catch (err) {
        report.error ??= String(err);
      }
      report.cleanupRemaining = liveRecords();
      report.ownedProcesses = records();
      report.boundaries = fs
        .readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      report.readyAttempts = fs
        .readdirSync(root)
        .filter((name) => /^ready-\d+\.json$/u.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")))
        .toSorted((left, right) => left - right);
      report.commands = fs
        .readFileSync(commandsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      report.output = fs.readFileSync(path.join(root, "workflow.log"), "utf8");
      publish("report.json", report);
      fs.closeSync(output);
      process.exit(report.error ? 1 : 0);
    })();
    return stopping;
  };
  process.once("disconnect", () => void stop("test parent disconnected"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => void stop(`supervisor received ${signal}`));
  }
  setTimeout(() => void stop("fixture deadline exceeded"), 45_000);
  try {
    if (process.platform !== "win32") {
      // A noexec mount can make PATH skip mocks and select real tools. Verify
      // resolution and executability before the workflow gets any chance to run.
      const preflight = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          'for mock in "$@"; do resolved=$(command -v "${mock##*/}") || resolved=; if [[ "$resolved" != "$mock" || ! -x "$mock" ]]; then printf "mock unavailable: %s (resolved: %s)\\n" "$mock" "$resolved" >&2; exit 1; fi; done',
          "checkout-fixture",
          path.join(bin, "git"),
          ...(linux ? [path.join(bin, "find")] : []),
        ],
        {
          cwd: workspace,
          env: { PATH: commandPath },
          encoding: "utf8",
          timeout: 2_000,
          killSignal: "SIGKILL",
        },
      );
      if (preflight.error || preflight.status !== 0) {
        const detail =
          preflight.error?.message || preflight.stderr.trim() || `exit ${preflight.status}`;
        throw new Error(`Fixture setup: mock command resolution failed: ${detail}`);
      }
    }
    const sentinel = spawn(process.execPath, [fixture, "sentinel", root, policyScenario], {
      detached: true,
      stdio: "ignore",
    });
    sentinel.on("error", (error) => void stop(error));
    await until(() => records().some((entry) => entry.role === "sentinel"), "sentinel readiness");
    if (stopping) {
      return;
    }
    const checkoutScript = shellPath(path.join(root, "checkout.sh"));
    // Git for Windows' Bash launcher prepends real Git to PATH. Reassert the
    // fixture's command boundary inside Bash so the test cannot contact GitHub.
    const shellArgs =
      process.platform === "win32"
        ? [
            "-c",
            'export PATH="$(cygpath -u "$1"):$PATH"; source "$2"',
            "checkout-fixture",
            bin,
            checkoutScript,
          ]
        : [checkoutScript];
    shell = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", ...shellArgs], {
      cwd: workspace,
      detached: true,
      stdio: ["ignore", output, output],
      env: {
        PATH: commandPath,
        HOME: home,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: root,
        TEMP: root,
        TMP: root,
        GITHUB_WORKSPACE: shellPath(workspace),
        RUNNER_OS: linux ? "Linux" : process.platform === "win32" ? "Windows" : "macOS",
        PATHEXT: process.env.PATHEXT,
        CHECKOUT_REPO: "fixture/checkout",
        CHECKOUT_SHA: "a".repeat(40),
        CHECKOUT_BASE_SHA: linux && scenario === "early-leader-exit" ? "c".repeat(40) : "",
        WORKFLOW_SHA: "b".repeat(40),
      },
    });
    if (shell.pid) {
      record(shell.pid, "shell");
    }
    const exited = once(shell, "exit");
    const [code] = await exited;
    report.code = code;
    boundary("exit");
    await stop();
  } catch (error) {
    await stop(error);
  }
}

if (mode === "supervise") {
  await supervise();
} else {
  await command();
}
