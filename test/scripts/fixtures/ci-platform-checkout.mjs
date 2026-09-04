import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createWindowsProcessCensus,
  requestWindowsProcessCensus,
} from "./ci-windows-process-census.mjs";

const [mode, root, policyScenario, ...args] = process.argv.slice(2);
const linux = policyScenario.startsWith("linux:");
const scenario = linux ? policyScenario.slice("linux:".length) : policyScenario;
const fixture = fileURLToPath(import.meta.url);
const instance = randomUUID();
let ownWindowsCreationTime;
let census;
let actorLease;
const workspace = path.join(root, "workspace");
const runnerTemp = path.join(root, "temp");
const lease = path.join(root, "lease");
const recordsDir = path.join(root, "pids");
const eventsFile = path.join(root, "events.jsonl");
const commandsFile = path.join(root, "commands.jsonl");
const optionsFile = path.join(root, "fixture-options.json");
const options = fs.existsSync(optionsFile) ? JSON.parse(fs.readFileSync(optionsFile, "utf8")) : {};
const localGit = options.localGit ?? options.performance;
// Preload identity support before the cleanup handshake; its TypeScript graph
// uses .js specifiers that native Node type stripping cannot resolve.
let getFileLockProcessStartTime;
if (options.cancelDuringCleanup && ["supervise", "git"].includes(mode)) {
  const { tsImport } = await import("tsx/esm/api");
  ({ getFileLockProcessStartTime } = await tsImport(
    "../../../src/shared/pid-alive.ts",
    import.meta.url,
  ));
}
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

function recordCommand(tool, cwd, commandArgs, configuration) {
  const envProbe = options.performance
    ? JSON.stringify({
        token: Boolean(process.env.CLAWGRIT_REPORTS_APP_TOKEN),
        auth: Boolean(process.env.GIT_CONFIG_VALUE_1),
        hooks: process.env.GIT_CONFIG_VALUE_0 ?? null,
        prompt: process.env.GIT_TERMINAL_PROMPT ?? null,
        count: process.env.GIT_CONFIG_COUNT ?? null,
      })
    : process.env.CI_OWNER_PROBE;
  if (
    commandArgs[0] === "config" &&
    commandArgs.includes("http.https://github.com/.extraheader") &&
    commandArgs.at(-1).startsWith("AUTHORIZATION:")
  ) {
    commandArgs = [...commandArgs.slice(0, -1), "[redacted]"];
  }
  fs.appendFileSync(
    commandsFile,
    `${JSON.stringify({ tool, cwd, args: commandArgs, configuration, envProbe })}\n`,
  );
}

function publish(name, value) {
  const target = path.join(root, name);
  fs.writeFileSync(`${target}.${process.pid}.tmp`, JSON.stringify(value));
  fs.renameSync(`${target}.${process.pid}.tmp`, target);
}

function stall(attempt) {
  // Expire only a ready, deliberately stalled tree. Ordinary cancel-* cases
  // wait for their signal; cancelDuringCleanup needs a tick to enter real drain.
  if (!scenario.startsWith("cancel-")) {
    publish(`fetch-tick-${attempt}.json`, attempt);
  }
}

function assertActorLease() {
  if (mode !== "supervise" && fs.readFileSync(lease, "utf8") !== actorLease) {
    throw new Error("Fixture actor lease retired");
  }
}

function readWindowsProcessCensus(pids) {
  return mode === "supervise"
    ? census.read(pids)
    : requestWindowsProcessCensus(root, actorLease, pids);
}

async function record(pid, role, attempt = 0) {
  if (process.platform === "win32" && pid === process.pid && !ownWindowsCreationTime) {
    const identity = (await readWindowsProcessCensus([pid])).get(pid);
    if (!identity.alive || !identity.creationTime) {
      throw new Error("Fixture actor could not capture its own Windows birth");
    }
    ownWindowsCreationTime = identity.creationTime;
  }
  // Registration cannot outlive the exact lease held before the native await.
  assertActorLease();
  publish(`pids/${pid}.json`, {
    pid,
    role,
    attempt,
    instance: `${instance}-${pid}`,
    ...(process.platform === "win32" && pid === process.pid
      ? { creationTime: ownWindowsCreationTime }
      : {}),
  });
}

function records() {
  // Keep producer observations and shutdown reports in the same order.
  return fs
    .readdirSync(recordsDir)
    .filter((file) => file.endsWith(".json"))
    .toSorted()
    .map((file) => JSON.parse(fs.readFileSync(path.join(recordsDir, file), "utf8")));
}

async function liveRecords() {
  const owned = records().filter(
    (entry) =>
      !fs.existsSync(path.join(recordsDir, `${entry.instance}.dead`)) &&
      // The creator owns this shell through track(close), not a later PID lookup.
      !(process.platform === "win32" && entry.role === "shell"),
  );
  if (owned.length === 0) {
    return [];
  }
  const alive = new Set();
  const pids = new Set(owned.map((entry) => entry.pid));
  const windowsCensus =
    process.platform === "win32" ? await readWindowsProcessCensus([...pids]) : undefined;
  if (windowsCensus) {
    for (const entry of owned) {
      if (typeof entry.creationTime !== "string" || !/^\d+$/.test(entry.creationTime)) {
        throw new Error("Fixture Windows actor is missing its registered birth");
      }
    }
    for (const identity of windowsCensus.values()) {
      if (identity.alive) alive.add(identity.pid);
    }
  } else {
    // Linux can census the owned PID set in one ps call. Apple ps scans the
    // whole host for multiple PIDs; keep its singleton queries under one budget.
    const pidLists = process.platform === "linux" ? [[...pids]] : [...pids].map((pid) => [pid]);
    const deadline = Date.now() + 1_000;
    for (const selectedPids of pidLists) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Fixture process census failed (ETIMEDOUT)");
      }
      const result = spawnSync("/bin/ps", ["-o", "pid=,stat=", "-p", selectedPids.join(",")], {
        encoding: "utf8",
        timeout: remaining,
      });
      if (result.error || result.signal || result.stderr !== "" || Date.now() > deadline) {
        throw new Error(
          `Fixture process census failed (${result.error?.code ?? result.signal ?? "unverified"})`,
        );
      }
      // Apple ps and procps exit 1 without output when all selected PIDs are absent.
      if (result.status === 1 && result.stdout === "") {
        continue;
      }
      const remainingPids = new Set(selectedPids);
      for (const line of result.stdout.trim().split("\n")) {
        // Darwin can expose ?E during exit. Count it as live until a later census
        // proves termination; never turn that transient state into a dead receipt.
        const row = /^(\d+)\s+([RSDTtXZxKWPIU?][<+NLlsEVWX]*)$/u.exec(line.trim());
        if (result.status !== 0 || !row || !remainingPids.delete(Number(row[1]))) {
          throw new Error(
            `Fixture process census returned an invalid row (exit ${result.status}, pids ${selectedPids.join(",")}, stdout ${JSON.stringify(result.stdout)})`,
          );
        }
        if (!row[2].startsWith("Z")) {
          alive.add(Number(row[1]));
        }
      }
    }
  }
  assertActorLease();
  return owned.filter((entry) => {
    if (
      alive.has(entry.pid) &&
      (!windowsCensus || windowsCensus.get(entry.pid).creationTime === entry.creationTime)
    ) {
      return true;
    }
    // Separate command processes share this observed-dead fact. PID reuse cannot
    // revive that instance, while a newly registered instance is still checked.
    fs.writeFileSync(path.join(recordsDir, `${entry.instance}.dead`), "");
    return false;
  });
}

function isWorkflowDescendant(pid, shellPid) {
  const deadline = Date.now() + 1_000;
  const visited = new Set();
  while (pid > 1 && !visited.has(pid)) {
    if (pid === shellPid) return true;
    visited.add(pid);
    const result = spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: Math.max(1, deadline - Date.now()),
    });
    if (
      result.error ||
      result.status !== 0 ||
      result.stderr ||
      Date.now() > deadline ||
      !/^\d+$/u.test(result.stdout.trim())
    ) {
      throw new Error("Fixture owner ancestry census failed");
    }
    pid = Number(result.stdout.trim());
  }
  return false;
}

async function boundary(name) {
  const alive = await liveRecords();
  assertActorLease();
  fs.appendFileSync(
    eventsFile,
    `${JSON.stringify({
      name,
      alive: alive.filter((entry) => entry.attempt > 0),
      sentinelAlive: alive.some((entry) => entry.role === "sentinel"),
    })}\n`,
  );
}

async function until(predicate, label, deadline) {
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    const satisfied = await predicate();
    // Truthful completion after expiry cannot authorize namespace release.
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    if (satisfied) return;
    await delay(Math.max(0, Math.min(10, deadline - Date.now())));
  }
}

async function waitForReady(predicate, child, stopped = () => !fs.existsSync(lease)) {
  // Readiness belongs to the owned child's lifetime. The supervisor's existing
  // watchdog bounds startup; an independent short timer can preempt legal Git work.
  while (!stopped() && child.exitCode === null && child.signalCode === null) {
    if (predicate()) {
      return true;
    }
    await delay(10);
  }
  return false;
}

function launch(role, attempt) {
  const child = spawn(process.execPath, [fixture, role, root, policyScenario, String(attempt)], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.on("error", (error) => {
    throw error;
  });
  child.unref();
  return child;
}

function holdLease() {
  actorLease = fs.readFileSync(lease, "utf8");
  const isLive = () => {
    try {
      return fs.readFileSync(lease, "utf8") === actorLease;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  // Orphans stop themselves when the supervisor releases the lease; no PID discovery/kills.
  // The independent ceiling also covers a supervisor killed before it can unlink the lease.
  const deadline = Date.now() + 60_000;
  setInterval(() => {
    if (!isLive() || Date.now() >= deadline) {
      process.exit(0);
    }
  }, 20);
  if (!isLive()) {
    process.exit(0);
  }
}

function insideOwnedPath(target) {
  const resolved = path.resolve(target);
  if (
    ![workspace, runnerTemp].some(
      (base) => resolved === base || resolved.startsWith(`${base}${path.sep}`),
    )
  ) {
    throw new Error(`Fixture command escaped owned paths: ${target}`);
  }
  return resolved;
}

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const shellPath = (value) => value.replaceAll("\\", "/");

function writeConsumer(target, tool) {
  const argv = [process.execPath, fixture, tool, root, policyScenario].map((value) =>
    quote(shellPath(value)),
  );
  fs.writeFileSync(target, `#!/bin/bash\nexec ${argv.join(" ")} "$@"\n`, { mode: 0o755 });
}

async function command() {
  holdLease();
  if (!options.performance || mode !== "observe") await record(process.pid, mode);
  if (mode === "sentinel") {
    return;
  }
  if (mode === "observe") {
    await boundary(args[0]);
    process.exit(0);
  }
  if (options.performance && ["curl", "tar", "sha256sum", "npm"].includes(mode)) {
    await boundary(`consumer:${mode}`);
    recordCommand(mode, process.cwd(), args);
    if (mode === "tar") {
      const directory = insideOwnedPath(args[args.indexOf("-C") + 1]);
      fs.writeFileSync(path.join(directory, "ocm"), "fixture\n");
    }
    process.exit(0);
  }
  if (mode === "date") {
    fs.writeSync(1, "2026-08-28T22:30:00Z\n");
    process.exit(0);
  }
  if (mode === "find") {
    insideOwnedPath(args[0]);
    // Observe before the real deletion, while prior Git children can still write.
    await boundary("delete");
    const result = spawnSync("/usr/bin/find", args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (mode === "rm") {
    const target = insideOwnedPath(args.at(-1));
    if (target === path.join(workspace, "publish")) {
      await boundary("delete");
    }
    recordCommand(mode, process.cwd(), args);
    const result = spawnSync("/bin/rm", args, { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
  if (mode === "child" || mode === "grandchild") {
    const attempt = Number(args[0]);
    process.on("SIGTERM", () => {
      if (
        options.cancelDuringCleanup &&
        (!options.cleanupCancelMatch ||
          fs.existsSync(path.join(root, `cleanup-target-${attempt}.json`)))
      ) {
        publish("cleanup-started.json", attempt);
      }
      if (options.cooperativeTrees) {
        process.exit(0);
      }
    });
    await record(process.pid, mode, attempt);
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
  if (["gh", "node", "pnpm", "go", "crabbox"].includes(mode)) {
    const cwd = insideOwnedPath(process.cwd());
    recordCommand(mode, cwd, args);
    if (options.performance && mode === "node") {
      await boundary("consumer:node");
      const allowed = [
        options.env.PERFORMANCE_REPORT_SELECTOR,
        options.env.PERFORMANCE_PUBLISHER_HELPER,
      ];
      if (allowed.includes(args[0]) || args[0] === "-e") {
        const result = spawnSync(process.execPath, args, { stdio: "inherit" });
        process.exit(result.status ?? 1);
      }
      if (args[0] === "-") process.exit(0); // OCM dependency check, no install in this fixture.
      throw new Error("Unexpected performance Node command");
    }
    if (mode === "node" && args[0] === "-e") {
      if (options.docsPublish) {
        // Execute only the workflow's trusted JSON reader for pre-fix RED proof.
        const result = spawnSync(process.execPath, args, { stdio: "inherit" });
        process.exit(result.status ?? 1);
      }
      // The workflow's package-script capability probe; never evaluate candidate code.
      process.exit(0);
    }
    await boundary(`consumer:${mode}`);
    if (mode === "go") {
      const [build, changeDirectory, source, outputFlag, output, target] = args;
      if (
        build !== "build" ||
        changeDirectory !== "-C" ||
        outputFlag !== "-o" ||
        target !== "./cmd/crabbox" ||
        args.length !== 6
      ) {
        throw new Error("Unexpected fixture Go build arguments");
      }
      if (!fs.statSync(path.join(insideOwnedPath(source), ".git")).isDirectory()) {
        throw new Error("Go build source is not a checkout");
      }
      writeConsumer(insideOwnedPath(output), "crabbox");
    }
    if (mode === "crabbox") {
      if (args.join(" ") === "--version") {
        fs.writeSync(1, "crabbox fixture\n");
      } else if (args.join(" ") === "warmup --help") {
        fs.writeSync(1, "-desktop\n");
      } else if (args.join(" ") !== "media preview --help") {
        throw new Error("Unexpected fixture Crabbox probe");
      }
    }
    if (mode === "gh" && options.publisher) {
      const result = spawnSync("bash", [options.publisher.gh, ...args], { stdio: "inherit" });
      process.exit(result.status ?? 1);
    }
    if (mode === "gh") {
      fs.writeSync(
        1,
        options.docsAgent
          ? JSON.stringify({ workflow_runs: options.workflowRuns ?? [] })
          : options.lsRemoteResults
            ? args.includes(".status")
              ? "ahead\n"
              : `${"c".repeat(40)}\n`
            : JSON.stringify({
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
  let cwd = insideOwnedPath(process.cwd());
  const configuration = [];
  while (args[0] === "-C" || args[0] === "-c") {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "-C") {
      cwd = insideOwnedPath(value);
    } else {
      configuration.push(value);
    }
  }
  recordCommand("git", cwd, args, configuration);
  let commandResult = options.commandResults?.[args.join(" ")];
  for (const [index, fault] of [options.gitFault, ...(options.gitFaults ?? [])].entries()) {
    if (!fault || !new RegExp(fault.match).test(args.join(" "))) continue;
    const countFile = path.join(root, `fault-count-${index}.json`);
    const count = fs.existsSync(countFile) ? JSON.parse(fs.readFileSync(countFile, "utf8")) + 1 : 1;
    publish(`fault-count-${index}.json`, count);
    if (count === (fault.occurrence ?? 1)) commandResult = fault;
  }
  const operation = args.shift();
  if (operation === "init" && !localGit) {
    await boundary("init");
    const config = path.join(root, "fixture-config.json");
    if (fs.existsSync(config)) {
      await delay(JSON.parse(fs.readFileSync(config, "utf8")).initDelayMs);
    }
    const directory = insideOwnedPath(args[0] ?? cwd);
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
    const gitDir = path.join(directory, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "preexisting.lock"), "not invocation-owned\n", {
      flag: "wx",
    });
    if (scenario === "pre-existing-lock") {
      fs.writeFileSync(path.join(gitDir, "shallow.lock"), "not invocation-owned\n", { flag: "wx" });
    }
    if (scenario === "recovery") {
      const sharedCache = path.join(root, "shared-git-cache");
      fs.mkdirSync(sharedCache, { recursive: true });
      fs.symlinkSync(sharedCache, path.join(gitDir, "shared-cache"), "junction");
    }
  } else if (
    options.publisher ||
    localGit ||
    options.pluginRelease ||
    options.releaseAdmission ||
    commandResult ||
    ["fetch", "ls-remote", "clone"].includes(operation) ||
    (operation === "worktree" && args[0] === "add") ||
    (operation === "rebase" && args[0] === "-X") ||
    operation === "push" ||
    (operation === "rev-parse" && options.revParseResult !== undefined)
  ) {
    // Keep the existing transport-result indexing; rebase/push/read faults have
    // independent results but share unique tree identities with those transports.
    const counterName =
      commandResult ||
      ((localGit || options.pluginRelease || options.releaseAdmission) && operation !== "fetch") ||
      ["rebase", "push", "rev-parse"].includes(operation)
        ? `${operation}-attempt.json`
        : "attempt.json";
    const counter = path.join(root, counterName);
    const resultAttempt = fs.existsSync(counter)
      ? JSON.parse(fs.readFileSync(counter, "utf8")) + 1
      : 1;
    publish(counterName, resultAttempt);
    const treeCounter = path.join(root, "tree-attempt.json");
    const attempt = fs.existsSync(treeCounter)
      ? JSON.parse(fs.readFileSync(treeCounter, "utf8")) + 1
      : 1;
    await boundary(`${operation}:${resultAttempt}`);
    publish("tree-attempt.json", attempt);
    await record(process.pid, "parent", attempt);
    if (operation === "clone" || operation === "worktree") {
      const directory = insideOwnedPath(operation === "clone" ? args.at(-1) : args.at(-2));
      if (operation === "clone" && options.docsPublish && fs.existsSync(directory)) {
        throw new Error("Previous publish path survived deletion");
      }
      fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
      fs.writeFileSync(path.join(directory, ".git/preexisting.lock"), "not invocation-owned\n", {
        flag: "wx",
      });
    }
    if (["fetch", "rebase", "push"].includes(operation) && !localGit) {
      const lock = path.join(cwd, operation === "fetch" ? ".git/shallow.lock" : ".git/index.lock");
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      try {
        fs.writeFileSync(lock, "fetch-owned\n", { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
        fs.writeSync(2, "fixture Git lock exists\n");
        process.exit(128);
      }
      // Normal Git exit rolls back locks; forced termination cannot run that cleanup.
      process.on("SIGTERM", () => {});
      process.once("exit", () => fs.unlinkSync(lock));
      if (scenario === "recovery") {
        fs.writeFileSync(
          path.join(cwd, ".git/shared-cache", `${attempt}.lock`),
          "outside Git ownership\n",
        );
      }
    }
    if (options.cancelDuringCleanup) {
      const pid = process.ppid;
      publish("owner.json", { pid, startTime: getFileLockProcessStartTime(pid) });
      await record(pid, "owner");
      if (
        options.cleanupCancelMatch &&
        new RegExp(options.cleanupCancelMatch).test([operation, ...args].join(" "))
      ) {
        publish(`cleanup-target-${attempt}.json`, attempt);
      }
    }
    const child = launch("child", attempt);
    if (
      !(await waitForReady(() => fs.existsSync(path.join(root, `ready-${attempt}.json`)), child))
    ) {
      throw new Error(
        `Git fixture child exited before readiness (${child.exitCode ?? child.signalCode})`,
      );
    }
    if (scenario.startsWith("cancel-") || commandResult?.code === "cancel") {
      const owned = await liveRecords();
      const alive = owned.filter((entry) => entry.attempt === attempt);
      if (
        !["parent", "child", "grandchild"].every((role) =>
          alive.some((entry) => entry.role === role),
        )
      ) {
        throw new Error("Cancellation tree is no longer alive");
      }
      const shell = owned.find((entry) => entry.role === "shell");
      const owner =
        (options.docsAgent ||
          options.performance ||
          options.pluginRelease ||
          options.releaseAdmission) &&
        process.ppid !== shell?.pid
          ? { pid: process.ppid }
          : shell;
      const parent =
        (options.docsAgent ||
          options.performance ||
          options.pluginRelease ||
          options.releaseAdmission) &&
        owner?.pid !== shell?.pid
          ? spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(owner?.pid)], { encoding: "utf8" })
          : undefined;
      // Gate policies retain a shell for the cadence block. Validate that direct
      // owner placement too, never signaling an orphan's parent or the Git group.
      if (
        !owner ||
        owner.pid <= 1 ||
        process.ppid !== owner.pid ||
        (parent &&
          (parent.status !== 0 ||
            (options.performance
              ? !isWorkflowDescendant(owner.pid, shell?.pid)
              : Number(parent.stdout.trim()) !== shell?.pid)))
      ) {
        throw new Error("Cancellation owner is no longer the registered workflow parent");
      }
      const signal =
        commandResult?.code === "cancel" ? "SIGTERM" : scenario.slice("cancel-".length);
      fs.writeSync(1, `cancellation: ${JSON.stringify({ signal, owner: owner.pid, alive })}\n`);
      process.kill(owner.pid, signal);
    }
    if (
      options.fetchResults ||
      options.lsRemoteResults ||
      options.cloneResults ||
      options.worktreeResults
    ) {
      const remoteResult =
        operation === "ls-remote" ? options.lsRemoteResults?.[resultAttempt - 1] : undefined;
      const operationResults =
        operation === "clone"
          ? options.cloneResults
          : operation === "worktree"
            ? options.worktreeResults
            : operation === "rebase"
              ? options.rebaseResults
              : operation === "push"
                ? options.pushResults
                : operation === "rev-parse" && options.revParseResult !== undefined
                  ? [options.revParseResult]
                  : (localGit || options.pluginRelease || options.releaseAdmission) &&
                      operation !== "fetch"
                    ? undefined
                    : options.fetchResults;
      const result =
        commandResult?.code ?? remoteResult?.code ?? operationResults?.[resultAttempt - 1] ?? 0;
      if (commandResult?.output !== undefined) {
        fs.writeSync(1, commandResult.output);
      }
      if (remoteResult) {
        fs.writeSync(1, remoteResult.output);
      }
      if (localGit && ["fetch", "push"].includes(operation) && result !== 0) {
        const lock = path.join(cwd, ".git/shallow.lock");
        fs.writeFileSync(lock, "owned fixture lock\n", { flag: "wx" });
        process.on("SIGTERM", () => {});
        process.once("exit", () => fs.unlinkSync(lock));
      }
      if (options.performance?.remoteDuplicateAttempt === resultAttempt && operation === "push") {
        const pushed = spawnSync(
          options.performance.git,
          ["-C", cwd, "push", options.performance.remote, "HEAD:main"],
          { stdio: "inherit" },
        );
        if (pushed.status !== 0)
          throw new Error("Fixture ambiguous push did not reach local remote");
      }
      if (result === "cleanup-failure") {
        fs.writeFileSync(path.join(root, "bin/ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        process.exit(0);
      }
      if (result === "cancel") return;
      if (result === "hang") {
        stall(attempt);
        return;
      }
      if (result === 0 && localGit && commandResult?.output === undefined) {
        const commandArgs = [...args];
        if (["fetch", "push"].includes(operation)) {
          const index = commandArgs.indexOf("origin");
          if (index < 0) throw new Error("Unexpected local Git transport remote");
          commandArgs[index] = localGit.remote;
        }
        // Only local file transport is allowed; never fall through to a live URL.
        const result = spawnSync(
          localGit.git,
          [
            "-C",
            cwd,
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.file.allow=always",
            ...configuration.flatMap((value) => ["-c", value]),
            operation,
            ...commandArgs,
          ],
          { stdio: "inherit" },
        );
        if (operation === "init" && result.status === 0) {
          const directory = args.at(-1) === "main" ? cwd : insideOwnedPath(args.at(-1));
          fs.writeFileSync(path.join(directory, ".git/preexisting.lock"), "not invocation-owned\n");
        }
        if (
          options.localGit &&
          operation === "checkout" &&
          cwd === workspace &&
          result.status === 0
        ) {
          // Capture the candidate index at its producer, before harness materialization.
          fs.copyFileSync(path.join(workspace, ".git/index"), path.join(root, "candidate-index"));
        }
        process.exit(result.status ?? 1);
      }
      if (result === 0 && options.publisher) {
        const result = spawnSync(
          options.publisher.git,
          ["-C", cwd, ...configuration.flatMap((value) => ["-c", value]), operation, ...args],
          { stdio: "inherit" },
        );
        if (
          result.status === 0 &&
          operation === "fetch" &&
          options.env.FAKE_RACE === "recreate" &&
          fs.existsSync(`${options.env.FAKE_PR_STATE}.raced`)
        ) {
          const update = spawnSync(
            options.publisher.git,
            [
              "--git-dir",
              options.env.FAKE_ORIGIN,
              "update-ref",
              "refs/heads/automation/locale",
              options.env.FAKE_INITIAL_MAIN,
            ],
            { stdio: "inherit" },
          );
          if (update.status !== 0) process.exit(update.status ?? 1);
        }
        process.exit(result.status ?? 1);
      }
      if (result === 0 && operation === "rev-parse" && commandResult?.output === undefined) {
        fs.writeSync(1, `${resolveRef(cwd, args[0])}\n`);
      }
      if (result === 0 && operation === "fetch") {
        for (const refspec of args.slice(args.indexOf("origin") + 1)) {
          const [source, target] = refspec.replace(/^\+/u, "").split(":");
          const revision =
            options.mergeSnapshots?.[resultAttempt - 1]?.sha ?? resolveRef(cwd, source);
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
    stall(attempt);
    return;
  } else if (operation === "checkout") {
    await boundary(cwd === path.join(workspace, ".ci-harness") ? "harness-checkout" : "checkout");
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
  } else if (
    operation === "diff" &&
    (args.join(" ") === "--quiet -- docs .openclaw-sync" ||
      (options.docsAgent && args.join(" ") === "--quiet") ||
      options.maturity)
  ) {
    await boundary("diff");
    process.exit(options.diffResult ?? (options.maturity ? 0 : 1));
  } else if (
    ["add", "commit"].includes(operation) ||
    (operation === "config" && (options.docsPublish || options.docsAgent)) ||
    (operation === "rebase" && args[0] === "--abort")
  ) {
    await boundary(operation === "rebase" ? "rebase-abort" : operation);
    // An abort without an active rebase is an ordinary ignored Git failure.
    process.exit(operation === "rebase" ? 128 : 0);
  } else if (options.docsAgent && ["ls-files", "diff"].includes(operation)) {
    await boundary(operation);
  } else if (operation === "cat-file" || (operation === "show" && options.objects)) {
    await boundary(`${operation}:${args.at(-1)}`);
    const spec = args.at(-1);
    if (spec.endsWith("^{commit}")) {
      process.exit(options.baseAvailableAfter === 0 ? 0 : 1);
    }
    const object = options.objects?.[spec];
    if (operation === "show" && object) {
      fs.writeSync(1, object.text);
    }
    process.exit(object ? ((operation === "cat-file" ? object.probe : object.code) ?? 0) : 1);
  } else if (operation === "rev-parse") {
    await boundary("rev-parse");
    if (args[0] === "--verify") {
      fs.writeSync(1, "fixture quiet probe stdout\n");
      fs.writeSync(2, "fixture quiet probe stderr\n");
      const counter = path.join(root, "attempt.json");
      const attempt = fs.existsSync(counter) ? JSON.parse(fs.readFileSync(counter, "utf8")) : 0;
      process.exit(
        options.baseAvailableAfter !== undefined && attempt >= options.baseAvailableAfter ? 0 : 1,
      );
    }
    fs.writeSync(1, `${args.map((ref) => resolveRef(cwd, ref)).join("\n")}\n`);
  } else if (operation === "tag" && args[0] === "--points-at") {
    await boundary("tag");
  } else if (operation === "merge-base" && options.mergeBase) {
    await boundary("merge-base");
    if (args[0] === "--is-ancestor") {
      process.exit(options.mergeBase.ancestor ? 0 : 1);
    }
    fs.writeSync(1, `${options.mergeBase.revision}\n`);
  } else if (operation === "check-ref-format") {
    await boundary("check-ref-format");
    fs.writeSync(1, "fixture quiet probe stdout\n");
    fs.writeSync(2, "fixture quiet probe stderr\n");
    process.exit(options.invalidRef ? 1 : 0);
  } else if (operation === "remote" && args[0] === "get-url") {
    fs.writeSync(1, "https://example.invalid/fixture.git\n");
  } else if (operation === "show" && args.join(" ").startsWith("-s --format=%P ")) {
    await boundary("show-parents");
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
  fs.writeFileSync(lease, instance);
  const bin = path.join(root, "bin");
  const commandPath = `${bin}${path.delimiter}${process.env.PATH}`;
  const home = path.join(runnerTemp, "home");
  fs.mkdirSync(bin);
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(home);
  // Git Bash accepts forward-slash native paths; native Node records native Windows PIDs.
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
    ...(options.docsPublish ? ["rm"] : []),
    ...(options.performance ? ["curl", "tar", "sha256sum", "npm"] : []),
    ...(options.docsAgent ? ["date"] : []),
    ...(options.consumers ? ["gh", "node", "pnpm", "go"] : []),
  ];
  for (const tool of extraTools) {
    writeConsumer(path.join(bin, tool), tool);
  }
  if (
    options.performance ||
    options.pluginRelease ||
    options.releaseAdmission ||
    options.publisher
  ) {
    fs.writeFileSync(
      path.join(bin, "timeout"),
      '#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
  }
  if (options.publisher) {
    fs.copyFileSync(path.join(root, "publisher-bin/sleep"), path.join(bin, "sleep"));
  }
  if (scenario === "cleanup-failure") {
    // Fail the real POSIX inspection boundary, without a production injection hook.
    fs.writeFileSync(path.join(bin, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  if (scenario.startsWith("non-executable-")) {
    fs.chmodSync(path.join(bin, scenario.slice("non-executable-".length)), 0o644);
  }
  const output = fs.openSync(path.join(root, "workflow.log"), "w");
  let sentinel;
  let shell;
  let stopping;
  let censusFailed = false;
  const pendingChildren = new Set();
  const track = (child) => {
    pendingChildren.add(child);
    // Spawn errors precede close; only close releases a direct child's ownership.
    const closed = new Promise((resolve) => {
      child.once("close", (code) => {
        pendingChildren.delete(child);
        resolve(code);
      });
    });
    child.on("error", (error) => void stop(error));
    return closed;
  };
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
    stopping ??= Promise.resolve().then(async () => {
      if (error) {
        report.error = String(error);
      }
      const cleanupEnd = Date.now() + 4_000;
      const actorEnd = census ? cleanupEnd - 1_000 : cleanupEnd;
      let cleanupError;
      let retirement;
      const retireCensus = () => (retirement ??= census.close());
      // Reserve the last second for the Windows helper. Closing at the actor cutoff
      // also cancels an in-flight census instead of waiting beyond the shared budget.
      const actorCutoff = census
        ? setTimeout(
            () => {
              cleanupError ??= new Error("Timed out waiting for fixture actors");
              void retireCensus().catch((err) => {
                cleanupError ??= err;
              });
            },
            Math.max(0, actorEnd - Date.now()),
          )
        : undefined;
      try {
        fs.rmSync(lease, { force: true });
        sentinel?.kill("SIGKILL");
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
        // Empty registration does not prove a spawned writer has closed.
        await until(() => pendingChildren.size === 0, "direct child close", actorEnd);
        await until(
          async () => {
            report.cleanupRemaining = await liveRecords();
            return report.cleanupRemaining.length === 0;
          },
          "fixture cleanup",
          actorEnd,
        );
      } catch (err) {
        cleanupError ??= err;
      } finally {
        clearTimeout(actorCutoff);
        if (census) {
          // Always join the same raw retirement, including one started by the cutoff.
          // A missing native close keeps ownership until the existing outer termination.
          try {
            await retireCensus();
          } catch (err) {
            cleanupError ??= err;
          }
          if (censusFailed) report.error = census.diagnostics();
        }
      }
      if (!cleanupError) {
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
        if (options.publisher || options.performance) {
          // Model Actions masking, including the mask-registration line itself.
          const masks = [...report.output.matchAll(/^::add-mask::(.+)$/gm)].map(
            (match) => match[1],
          );
          for (const value of [
            ...masks,
            options.env.CONTENTS_TOKEN,
            options.env.GH_TOKEN,
            options.env.CLAWGRIT_REPORTS_APP_TOKEN,
          ]) {
            if (value) report.output = report.output.replaceAll(value, "[redacted]");
          }
        }
      }
      // Report assembly is synchronous, but it must still finish within the original budget.
      if (Date.now() >= cleanupEnd) {
        cleanupError ??= new Error("Timed out waiting for fixture cleanup");
      }
      if (cleanupError) {
        // Only the completed report releases the namespace; exit alone does not.
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.error(`Fixture cleanup unverified; retaining ${root}: ${detail}`);
        if (censusFailed) console.error(census.diagnostics());
        fs.closeSync(output);
        process.exit(1);
      }
      publish("report.json", report);
      fs.closeSync(output);
      process.exit(report.error ? 1 : 0);
    });
    return stopping;
  };
  process.once("disconnect", () => void stop("test parent disconnected"));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => void stop(`supervisor received ${signal}`));
  }
  setTimeout(() => void stop("fixture deadline exceeded"), 45_000);
  try {
    if (process.platform === "win32") {
      census = createWindowsProcessCensus({
        root,
        token: instance,
        onFailure: (error) => {
          censusFailed = true;
          void stop(error);
        },
      });
      // Interpreter startup belongs to the existing supervisor watchdog, not a query deadline.
      await census.ready;
      if (stopping) {
        await stopping;
        return;
      }
    }
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
    if (["git", "python"].includes(options.setupFailure)) {
      fs.writeFileSync(
        path.join(bin, options.setupFailure === "git" ? "git" : "python3"),
        "#!/fixture-missing-interpreter\n",
        { mode: 0o755 },
      );
    }
    sentinel = spawn(process.execPath, [fixture, "sentinel", root, policyScenario], {
      // Parent teardown owns this group before self-registration. Keep startup
      // errors in the existing report so census failures do not become opaque exits.
      stdio: ["ignore", output, output],
    });
    // stop() joins the sentinel's actual close through pendingChildren before reporting.
    void track(sentinel);
    const sentinelReady = await waitForReady(
      () => records().some((entry) => entry.role === "sentinel"),
      sentinel,
      () => Boolean(stopping),
    );
    if (stopping) {
      return;
    }
    if (!sentinelReady) {
      throw new Error(
        `Sentinel exited before readiness (${sentinel.exitCode ?? sentinel.signalCode})`,
      );
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
      cwd: path.join(workspace, options.workingDirectory ?? ""),
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
        GITHUB_STEP_SUMMARY: path.join(root, "github-summary"),
        GITHUB_PATH: path.join(root, "github-path"),
        RUNNER_OS: linux ? "Linux" : process.platform === "win32" ? "Windows" : "macOS",
        PATHEXT: process.env.PATHEXT,
        CHECKOUT_REPO: "fixture/checkout",
        CHECKOUT_SHA: "a".repeat(40),
        CHECKOUT_BASE_SHA: linux && scenario === "early-leader-exit" ? "c".repeat(40) : "",
        WORKFLOW_SHA: "b".repeat(40),
        ...options.env,
      },
    });
    const closed = track(shell);
    if (shell.pid) {
      await record(shell.pid, "shell");
    }
    const ready = (name) =>
      waitForReady(
        () => fs.existsSync(path.join(root, name)),
        shell,
        () => Boolean(stopping),
      );
    if (options.cancelDuringCleanup && (await ready("cleanup-started.json"))) {
      const owner = JSON.parse(fs.readFileSync(path.join(root, "owner.json"), "utf8"));
      // File policies exec into Bash's PID; raw Git owners are its direct children.
      // Revalidate the observed birth and exact placement after awaited readiness.
      if (
        (owner.pid !== shell.pid &&
          (options.performance
            ? !isWorkflowDescendant(owner.pid, shell.pid)
            : Number(
                fs
                  .readFileSync(`/proc/${owner.pid}/status`, "utf8")
                  .match(/^PPid:\s+(\d+)$/mu)?.[1],
              ) !== shell.pid)) ||
        owner.startTime === null ||
        getFileLockProcessStartTime(owner.pid) !== owner.startTime ||
        stopping ||
        shell.exitCode !== null ||
        shell.signalCode !== null
      ) {
        throw new Error("Git owner changed before cleanup cancellation");
      }
      process.kill(owner.pid, "SIGTERM");
      report.cancelledDuringCleanup = true;
    }
    if (
      options.cancelDuringBackoff &&
      (await waitForReady(
        () =>
          options.performance
            ? fs.readFileSync(eventsFile, "utf8").includes('"name":"backoff"')
            : fs.readFileSync(path.join(root, "workflow.log"), "utf8").includes("; retrying"),
        shell,
        () => Boolean(stopping),
      ))
    ) {
      await boundary("backoff-cancel");
      shell.kill("SIGTERM");
    }
    const code = await closed;
    if (stopping) {
      // A signal can start cleanup while the supervised shell is closing. Keep
      // the top-level module alive until that cleanup publishes report.json.
      await stopping;
      return;
    }
    report.code = code;
    if (options.docsAgent && fs.readFileSync(path.join(root, "github-output"), "utf8")) {
      await boundary("output");
    }
    if (
      options.objects &&
      fs.existsSync(path.join(root, "github-env")) &&
      fs.readFileSync(path.join(root, "github-env"), "utf8").includes("PRE_COMMIT_CONFIG_PATH=")
    ) {
      await boundary("config-publication");
    }
    for (const [name, file] of options.publisher || options.maturity || options.performance
      ? [
          ["output", "github-output"],
          ["summary", "github-summary"],
        ]
      : []) {
      if (fs.existsSync(path.join(root, file)) && fs.readFileSync(path.join(root, file), "utf8"))
        await boundary(name);
    }
    await boundary("exit");
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
