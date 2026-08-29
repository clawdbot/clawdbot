import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getProcessStartTime } from "../../../src/shared/pid-alive.ts";

const [mode, root, policyScenario, ...args] = process.argv.slice(2);
const linux = policyScenario.startsWith("linux:");
const scenario = linux ? policyScenario.slice("linux:".length) : policyScenario;
const fixture = fileURLToPath(import.meta.url);
const instance = randomUUID();
const workspace = path.join(root, "workspace");
const lease = path.join(root, "lease");
const recordsDir = path.join(root, "pids");
const eventsFile = path.join(root, "events.jsonl");
const commandsFile = path.join(root, "commands.jsonl");
const optionsFile = path.join(root, "fixture-options.json");
const options = fs.existsSync(optionsFile) ? JSON.parse(fs.readFileSync(optionsFile, "utf8")) : {};
const refsFile = path.join(root, "refs.json");

function resolveRef(cwd, ref) {
  const refs = fs.existsSync(refsFile) ? JSON.parse(fs.readFileSync(refsFile, "utf8")) : {};
  return refs[`${cwd}:${ref}`] ?? options.revisions?.[ref] ?? ref;
}

function saveRef(cwd, ref, revision) {
  const refs = fs.existsSync(refsFile) ? JSON.parse(fs.readFileSync(refsFile, "utf8")) : {};
  refs[`${cwd}:${ref}`] = revision;
  publish("refs.json", refs);
}

function recordCommand(tool, cwd, commandArgs) {
  fs.appendFileSync(commandsFile, `${JSON.stringify({ tool, cwd, args: commandArgs })}\n`);
}

function publish(name, value) {
  const target = path.join(root, name);
  fs.writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify(value));
  fs.renameSync(`${target}.${process.pid}.tmp`, target);
}

function record(pid, role, attempt = 0) {
  publish(`pids/${pid}.json`, { pid, role, attempt, instance: `${instance}-${pid}` });
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
  const owned = records().filter(
    (entry) => !fs.existsSync(path.join(recordsDir, `${entry.instance}.dead`)),
  );
  const alive = new Set();
  if (process.platform === "win32") {
    for (const { pid } of owned) {
      try {
        process.kill(pid, 0);
        alive.add(pid);
      } catch (error) {
        if (error.code === "EPERM") {
          alive.add(pid);
        } else if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
  } else {
    // PID existence includes macOS zombies; observe active writers in one POSIX snapshot.
    const result = spawnSync("/bin/ps", ["-axo", "pid=,stat="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Fixture process census failed (${result.error?.code ?? result.status})`);
    }
    for (const line of result.stdout.trim().split("\n")) {
      const [pid, state] = line.trim().split(/\s+/u);
      if (!Number.isInteger(Number(pid)) || !state) {
        throw new Error("Fixture process census returned an invalid row");
      }
      if (!state.startsWith("Z")) {
        alive.add(Number(pid));
      }
    }
  }
  return owned.filter((entry) => {
    if (alive.has(entry.pid)) {
      return true;
    }
    // Separate command processes share this observed-dead fact. PID reuse cannot
    // revive that instance, while a newly registered instance is still checked.
    fs.writeFileSync(path.join(recordsDir, `${entry.instance}.dead`), "");
    return false;
  });
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
    process.on("SIGTERM", () => {
      if (options.cancelDuringCleanup) {
        publish("cleanup-started.json", attempt);
      }
    });
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
  if (["gh", "node", "pnpm"].includes(mode)) {
    const cwd = insideWorkspace(process.cwd());
    recordCommand(mode, cwd, args);
    if (mode === "node" && args[0] === "-e") {
      // The workflow's package-script capability probe; never evaluate candidate code.
      process.exit(0);
    }
    boundary(`consumer:${mode}`);
    if (mode === "gh") {
      fs.writeSync(
        1,
        JSON.stringify({
          state: "open",
          head: { sha: "a".repeat(40) },
          base: { repo: { full_name: "fixture/checkout" } },
        }),
      );
    }
    process.exit(0);
  }
  if (mode !== "git") {
    throw new Error(`Unexpected fixture mode: ${mode}`);
  }
  let cwd = insideWorkspace(process.cwd());
  while (args[0] === "-C" || args[0] === "-c") {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "-C") {
      cwd = insideWorkspace(value);
    }
  }
  recordCommand("git", cwd, args);
  const operation = args.shift();
  if (operation === "init") {
    boundary("init");
    const config = path.join(root, "fixture-config.json");
    if (fs.existsSync(config)) {
      await delay(JSON.parse(fs.readFileSync(config, "utf8")).initDelayMs);
    }
    const directory = insideWorkspace(args[0] ?? cwd);
    fs.mkdirSync(directory, { recursive: true });
    const kind = options.env?.CHECKOUT_KIND ?? "linux-node";
    if (
      linux &&
      directory !== path.join(workspace, ".ci-harness") &&
      ["linux-node", "clawhub", "android"].includes(kind)
    ) {
      if (fs.readdirSync(directory).length !== 0) {
        throw new Error("Previous checkout survived workspace deletion");
      }
      fs.writeFileSync(path.join(directory, ".previous-checkout"), "owned\n");
    }
  } else if (operation === "fetch") {
    const counter = path.join(root, "attempt.json");
    const attempt = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, "utf8")) + 1 : 1;
    boundary(`fetch:${attempt}`);
    publish("attempt.json", attempt);
    record(process.pid, "parent", attempt);
    if (options.cancelDuringCleanup) {
      const pid = process.ppid;
      publish("owner.json", { pid, startTime: getProcessStartTime(pid) });
      record(pid, "owner");
    }
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
    if (options.fetchResults) {
      const result = options.fetchResults[attempt - 1] ?? 0;
      if (result === "cleanup-failure") {
        fs.writeFileSync(path.join(root, "bin/ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        process.exit(0);
      }
      if (result === "hang") {
        return;
      }
      if (result === 0) {
        for (const refspec of args.slice(args.indexOf("origin") + 1)) {
          const [source, target] = refspec.replace(/^\+/u, "").split(":");
          const revision = options.mergeSnapshots?.[attempt - 1]?.sha ?? resolveRef(cwd, source);
          saveRef(cwd, target ?? "FETCH_HEAD", revision);
        }
      }
      process.exit(result);
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
    boundary(cwd === path.join(workspace, ".ci-harness") ? "harness-checkout" : "checkout");
    if (scenario === "checkout-failure") {
      process.exit(23);
    }
    if (options.checkoutResults) {
      const attempt = JSON.parse(fs.readFileSync(path.join(root, "attempt.json"), "utf8"));
      const code = options.checkoutResults[attempt - 1] ?? 0;
      if (code !== 0) {
        process.exit(code);
      }
    }
    saveRef(cwd, "HEAD", resolveRef(cwd, args.at(-1)));
    if (linux || cwd !== workspace) {
      const action = path.join(cwd, ".github/actions/setup-node-env");
      fs.mkdirSync(action, { recursive: true });
      fs.writeFileSync(path.join(action, "action.yml"), "fixture\n");
    }
    if (options.env?.CHECKOUT_KIND === "android") {
      const gradlew = path.join(cwd, "apps/android/gradlew");
      fs.mkdirSync(path.dirname(gradlew), { recursive: true });
      fs.writeFileSync(gradlew, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
  } else if (operation === "rev-parse") {
    boundary("rev-parse");
    fs.writeSync(1, `${args.map((ref) => resolveRef(cwd, ref)).join("\n")}\n`);
  } else if (operation === "show" && args.join(" ").startsWith("-s --format=%P ")) {
    boundary("show-parents");
    const snapshot = options.mergeSnapshots?.find((entry) => entry.sha === args.at(-1));
    const head = snapshot?.head ?? "a".repeat(40);
    fs.writeSync(1, `${"c".repeat(40)} ${head}\n`);
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
  const runnerTemp = path.join(root, "temp");
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(runnerTemp);
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
  const extraTools = [
    ...(linux ? ["find"] : []),
    ...(options.consumers ? ["gh", "node", "pnpm"] : []),
  ];
  for (const tool of extraTools) {
    const argv = [process.execPath, fixture, tool, root, policyScenario].map(quote);
    fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\nexec ${argv.join(" ")} "$@"\n`, {
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
    cancelledDuringCleanup: false,
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
          ...extraTools.map((tool) => path.join(bin, tool)),
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
        RUNNER_TEMP: shellPath(runnerTemp),
        GITHUB_OUTPUT: path.join(root, "github-output"),
        GITHUB_ENV: path.join(root, "github-env"),
        RUNNER_OS: linux ? "Linux" : process.platform === "win32" ? "Windows" : "macOS",
        PATHEXT: process.env.PATHEXT,
        CHECKOUT_REPO: "fixture/checkout",
        CHECKOUT_SHA: "a".repeat(40),
        CHECKOUT_BASE_SHA: linux && scenario === "early-leader-exit" ? "c".repeat(40) : "",
        WORKFLOW_SHA: "b".repeat(40),
        ...options.env,
      },
    });
    if (shell.pid) {
      record(shell.pid, "shell");
    }
    const exited = once(shell, "exit");
    if (options.cancelDuringCleanup) {
      await until(
        () => fs.existsSync(path.join(root, "cleanup-started.json")),
        "cleanup readiness",
      );
      const owner = JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8"));
      const ownerStatus = fs.readFileSync(`/proc/${owner.pid}/status`, "utf8");
      const parentPid = Number(ownerStatus.match(/^PPid:\s+(\d+)$/mu)?.[1]);
      // The raw owner is a child of Bash; bind the signal to the birth identity Git observed.
      if (
        parentPid !== shell.pid ||
        owner.startTime === null ||
        getProcessStartTime(owner.pid) !== owner.startTime
      ) {
        throw new Error("Raw Git owner changed before cleanup cancellation");
      }
      process.kill(owner.pid, "SIGTERM");
      report.cancelledDuringCleanup = true;
    }
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
