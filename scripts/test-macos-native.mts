// CI resource owner; the disposable credentialless runner is the isolation boundary.
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

// TEMPORARY PR132251 diagnostics: remove before the final unsampled native proof.
async function observeNativeRunner(
  child: ChildProcess,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  sampleFile: string,
) {
  if (process.platform !== "darwin" || !child.pid) {
    return;
  }
  // Inert Node fixtures must never start platform diagnostics, even with CI markers.
  const executable = env.PATH?.split(path.delimiter)
    .map((dir) => path.join(dir, "swift"))
    .find((file) => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!executable || !/^swift(?:-driver)?$/.test(path.basename(fs.realpathSync(executable)))) {
    return;
  }
  const fd = fs.openSync(executable, "r");
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic, 0, magic.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (
    !["cffaedfe", "feedfacf", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(
      magic.toString("hex"),
    )
  ) {
    return;
  }

  const cap = 262_144;
  const command = (bin: string, args: string[], timeout = 5_000) =>
    new Promise<{ output: Buffer; failed: boolean }>((resolve) => {
      signal.throwIfAborted();
      // Do not use execFile's abort callback: join close before disposing resources.
      let result: { output: Buffer; failed: boolean };
      const proc = execFile(
        bin,
        args,
        { env, timeout, killSignal: "SIGKILL", maxBuffer: cap, encoding: "buffer" },
        (error, stdout) => {
          result = { output: stdout.subarray(0, cap), failed: error !== null };
        },
      );
      const abort = () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          console.error(
            "[macos-native] TEMP diagnostic cancellation failed; awaiting bounded command cleanup.",
          );
        }
      };
      proc.once("close", () => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  const live = () => !signal.aborted && child.exitCode === null && child.signalCode === null;
  const started = Date.now();
  let censusReported = false;
  while (live()) {
    await delay(5_000, undefined, { signal });
    const descendants = await command("/usr/bin/pgrep", ["-P", String(child.pid)]);
    if (!live()) {
      return;
    }
    const pids = descendants.output
      .toString()
      .trim()
      .split(/\s+/)
      .filter((pid) => /^\d+$/.test(pid));
    const census = await command("/bin/ps", [
      "-ww",
      "-p",
      [child.pid, ...pids.slice(0, 32)].join(","),
      "-o",
      "pid=,ppid=,etime=,comm=",
    ]);
    if (!live()) {
      return;
    }
    const rows = census.output
      .toString()
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+?)\s*$/.exec(line);
        if (!match) {
          return [];
        }
        const [, pid, ppid, age, commandPath] = match;
        if (!pid || !ppid || !age || !commandPath) {
          return [];
        }
        return [
          { pid: Number(pid), ppid: Number(ppid), age, executable: path.basename(commandPath) },
        ];
      });
    const owned = rows.some((row) => row.pid === child.pid && row.ppid === process.pid);
    // SwiftPM 6.3.3 SwiftTestCommand.TestRunner launches this helper directly on
    // macOS; UserToolchain.getSwiftTestingHelper owns its name (not truncated ucomm).
    const runners = rows.filter(
      (row) => row.ppid === child.pid && row.executable === "swiftpm-testing-helper",
    );
    const [runner, ...otherRunners] = runners;
    if (
      descendants.failed ||
      census.failed ||
      !owned ||
      pids.length > 32 ||
      !runner ||
      otherRunners.length > 0
    ) {
      if (!censusReported && Date.now() - started >= 60_000) {
        censusReported = true;
        const ownedRows = rows
          .filter((row) => row.pid === child.pid || row.ppid === child.pid)
          .map((row) => ({
            pid: row.pid,
            ppid: row.ppid,
            age: row.age,
            executable: row.executable.replace(/[^a-zA-Z0-9_.+-]/g, "?").slice(0, 80),
          }));
        console.error(
          `[macos-native] TEMP runner identity missing/ambiguous; no sample: ${JSON.stringify({ owned, childCount: pids.length, rows: ownedRows })}`,
        );
      }
      continue;
    }
    const age = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(runner.age);
    if (
      !age ||
      Number(age[1] ?? 0) * 86400 +
        Number(age[2] ?? 0) * 3600 +
        Number(age[3]) * 60 +
        Number(age[4]) <
        60
    ) {
      continue;
    }
    console.error(
      `[macos-native] TEMP sample: Swift pid ${child.pid}, runner pid ${runner.pid}, age ${runner.age}, duration 2s, cap ${cap} bytes`,
    );
    const sample = await command(
      "/usr/bin/sample",
      [String(runner.pid), "2", "-file", sampleFile],
      10_000,
    );
    // Use the historical sampler's regular-file contract, inside the owned root.
    if (fs.existsSync(sampleFile)) {
      const sampleFd = fs.openSync(sampleFile, "r");
      try {
        const bytes = Buffer.alloc(cap);
        const size = fs.readSync(sampleFd, bytes, 0, cap, 0);
        process.stdout.write(bytes.subarray(0, size));
        if (fs.fstatSync(sampleFd).size > cap) {
          console.error("[macos-native] TEMP sample output truncated at 262144 bytes.");
        }
      } finally {
        fs.closeSync(sampleFd);
      }
    }
    if (sample.failed && !signal.aborted) {
      console.error(
        "[macos-native] TEMP sample failed, timed out, or reached output cap; Swift status is unchanged.",
      );
    }
    return;
  }
}

await runWithFailedTrailer("macos-native", async () => {
  const env = process.env;
  // Invocation checks prevent accidental local use; these markers are not a sandbox.
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "macOS" ||
    !env.RUNNER_TEMP ||
    !env.HOME ||
    process.platform === "win32"
  ) {
    throw new Error(
      "Run native app tests in the disposable macos-swift GitHub CI job, never on an operator desktop.",
    );
  }
  const [profileMode, ...args] = process.argv.slice(2);
  if (profileMode !== "default" && profileMode !== "named") {
    throw new Error("Select default or named profile semantics before the Swift test arguments.");
  }
  if (!args.includes("--skip-build")) {
    throw new Error(
      "Build tests first with swift build --build-tests; this launcher requires --skip-build.",
    );
  }

  // Keep Unix socket fixture paths short, independently of RUNNER_TEMP's length.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-test-"));
  let canRemove = true;
  const diagnosticAbort = new AbortController();
  let diagnostic: Promise<void> | undefined;
  let removeDiagnosticListeners: (() => void) | undefined;
  try {
    const home = path.join(root, "home");
    const state = path.join(root, "state");
    const tmp = path.join(root, "tmp");
    for (const dir of [home, state, tmp]) {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "DEVELOPER_DIR",
      "SDKROOT",
      "TOOLCHAINS",
      "LANG",
      "LC_ALL",
      "TERM",
      "DYLD_FRAMEWORK_PATH",
      "DYLD_LIBRARY_PATH",
      "LLVM_PROFILE_FILE",
      "SWIFTPM_MODULECACHE_OVERRIDE",
      "CLANG_MODULE_CACHE_PATH",
      // Preserve Actions' orphan-cleanup correlation through the isolated child env.
      "RUNNER_TRACKING_ID",
    ]) {
      if (env[key] !== undefined) {
        childEnv[key] = env[key];
      }
    }
    Object.assign(childEnv, {
      CI: "true",
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: `${tmp}/`,
      TMP: tmp,
      TEMP: tmp,
      // The full suite protects default-profile lifecycle behavior. Named-profile
      // construction is exercised separately; both use the disposable runner's account.
      OPENCLAW_PROFILE: profileMode === "named" ? `test-${randomUUID()}` : "default",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    });

    // Keep SwiftPM's build cache available without inheriting the runner's app state.
    const cache = path.join(home, "Library/Caches");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(env.HOME, "Library/Caches/org.swift.swiftpm"),
      path.join(cache, "org.swift.swiftpm"),
    );
    canRemove = false;
    process.exitCode = await runManagedCommand({
      bin: "swift",
      args: ["test", ...args],
      env: childEnv,
      requireProcessTreeExit: true,
      // TEMPORARY: observe exit separately from close without changing command ownership.
      onReady(child) {
        const report = (event: string, code: number | null, signal: NodeJS.Signals | null) => {
          const facts = {
            pid: child.pid,
            code,
            signal,
            stdoutPiped: child.stdout !== null,
            stderrPiped: child.stderr !== null,
            stdoutClosed: child.stdout?.closed ?? true,
            stderrClosed: child.stderr?.closed ?? true,
          };
          console.error(`[macos-native] TEMP Swift ${event}: ${JSON.stringify(facts)}`);
          diagnosticAbort.abort();
        };
        const exited = (code: number | null, signal: NodeJS.Signals | null) =>
          report("exit", code, signal);
        const closed = (code: number | null, signal: NodeJS.Signals | null) =>
          report("close", code, signal);
        const failed = () => diagnosticAbort.abort();
        child.once("exit", exited);
        child.once("close", closed);
        child.once("error", failed);
        removeDiagnosticListeners = () => {
          child.off("exit", exited);
          child.off("close", closed);
          child.off("error", failed);
        };
        const sampleFile = path.join(root, "native-runner.sample");
        diagnostic = observeNativeRunner(child, childEnv, diagnosticAbort.signal, sampleFile).catch(
          () => {
            if (!diagnosticAbort.signal.aborted) {
              console.error("[macos-native] TEMP observer unavailable; Swift status is unchanged.");
            }
          },
        );
      },
      onSignal: () => diagnosticAbort.abort(),
    });
    canRemove = true;
  } finally {
    diagnosticAbort.abort();
    await diagnostic;
    removeDiagnosticListeners?.();
    // Retain evidence/resources if process-tree completion could not be established.
    if (canRemove) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`[macos-native] retained resources after incomplete launch/cleanup: ${root}`);
    }
  }
});
