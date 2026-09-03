/**
 * Real behavior proof for PR #136411 — a warn-level plugin registry diagnostic
 * must reach the operator through the Gateway's warning sink, not its info sink.
 *
 * WHY THIS EXISTS
 * The unit test in `src/gateway/server-plugins.test.ts` drives
 * `loadGatewayPlugins` with a mocked loader and a mocked `log` object. It proves
 * the branch calls `log.warn`, and nothing more. It cannot show that a real
 * Gateway startup, with a real plugin registry and the real
 * `createSubsystemLogger` sink, actually emits the diagnostic at warning
 * severity — which is the only thing an operator experiences. This script shows
 * that, end to end, and shows the pre-fix source failing the same assertions.
 *
 * WHAT IS REAL HERE
 *  - A real OpenClaw Gateway process (`gateway run`) on a free loopback port
 *    with its own HOME / OPENCLAW_HOME / OPENCLAW_STATE_DIR / config file. It is
 *    a separate process; nothing under test is imported into this one.
 *  - A real plugin, installed by the real `openclaw plugins install` CLI, so it
 *    lands in the real installed-plugin index and the real Gateway startup plan
 *    picks it up (`activation.onStartup` in its manifest). No loader is stubbed.
 *  - The diagnostics are produced by the real registrars in
 *    `src/plugins/registry-state.ts` + `registry-registrars-*.ts`: the fixture
 *    registers one unknown typed hook (warn) and one nameless command (error).
 *    This script never hand-builds a `PluginDiagnostic`.
 *  - The sink is the real `createSubsystemLogger("gateway")` used by the real
 *    `logGatewayPluginDiagnostics` in `src/gateway/server-plugin-bootstrap.ts`,
 *    reached through the production chain
 *    `finishGatewayStartup` -> `loadGatewayStartupPluginRuntime` ->
 *    `loadGatewayStartupPlugins` -> `prepareGatewayPluginLoad`.
 *  - Severity is read two independent ways: from the Gateway's own JSONL log
 *    file (`_meta.logLevelName`, written by the real tslog file transport) and
 *    from the Gateway's console stream under a real `consoleLevel: "warn"`
 *    filter — the level-filtered operator read the fix exists for.
 *
 * WHAT IS STUBBED
 *  - Nothing on the path under test. Only the environment is isolated: a temp
 *    home/state/config, `--auth none` on loopback, Control UI and Tailscale off,
 *    `OPENCLAW_SKIP_CHANNELS=1` so no channel credentials are needed. The
 *    bundled plugin inventory is the repository's real `extensions/` tree.
 *
 * SCENARIOS (all must pass; the script exits non-zero otherwise)
 *  1. WARN-SEVERITY — the warn diagnostic is recorded at WARN in the Gateway's
 *     own log file. Pre-fix this record is INFO. This is the fix.
 *  2. NO-INFO-RECORD — no INFO record carries that diagnostic message, so the
 *     line moved sinks rather than being emitted twice.
 *  3. WARN-VISIBLE-UNDER-FILTER — the diagnostic is present on the Gateway
 *     console while `logging.consoleLevel` is `warn`. Pre-fix it is absent
 *     entirely: a level-filtered operator read cannot see the degraded plugin.
 *  4. ERROR-CONTROL — an error-level diagnostic from the same real plugin is
 *     still recorded at ERROR and still reaches the console. The untouched
 *     branch must not have been collapsed into warn.
 *  5. FILTER-IS-REAL — an info-level Gateway startup line ("gateway ready") is
 *     present in the log file at INFO and absent from the console under the same
 *     filter. Without this, scenario 3 could be an artifact of capture rather
 *     than evidence that info-level routing hides the diagnostic.
 *
 * ANTI-VACUITY
 * Revert the one-line sink change in
 * `src/gateway/server-plugin-bootstrap.ts` (`params.log.warn(message)` ->
 * `params.log.info(message)`) and re-run: scenarios 1, 2 and 3 fail and the
 * script exits 1, while 4 and 5 still pass. Same harness, same real Gateway,
 * opposite verdict.
 *
 * ENTRYPOINT
 * Drives `dist/entry.js` when a build is present, otherwise `src/entry.ts`
 * through the repository's own tsx loader. Either way it is the production CLI
 * entry, and the script prints which one it used.
 *
 * Run: pnpm tsx scripts/proof-136411-plugin-diagnostic-warn-level.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

// Heartbeat from a worker thread: a main-thread setInterval provably does not
// fire during a synchronous tsx/jiti module compile, and a silent proof reads as
// a hung proof to a review harness.
const heartbeat = new Worker(
  `const { writeSync } = require("node:fs");
   let n = 0;
   setInterval(() => { writeSync(1, "[proof] still running (" + (++n) * 5 + "s)\\n"); }, 5000).unref?.();
   setInterval(() => {}, 1 << 30);`,
  { eval: true, stdout: false },
);

const repoRoot = process.env.PROOF_REPO_ROOT ?? process.cwd();
const PLUGIN_ID = "proof-136411-warn";
const UNKNOWN_HOOK = "proof_136411_not_a_real_hook";
const WARN_DIAGNOSTIC = `[plugins] unknown typed hook "${UNKNOWN_HOOK}" ignored`;
const ERROR_DIAGNOSTIC = "[plugins] command registration missing name";
const INFO_STARTUP_LINE = "gateway ready";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
    console.log(`  PASS ${label}: ${String(actual)}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`);
}

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

/**
 * Removes the temp home/state/plugin roots. Cleanup failure is reported but
 * never changes the proof's verdict.
 */
function removeTempRoots(): void {
  for (const dir of tempRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error: unknown) {
      console.log(`  cleanup WARN: could not remove ${dir}: ${String(error)}`);
    }
  }
}

/** Resolves the production CLI entry, preferring a build when one exists. */
function resolveEntry(): { args: string[]; label: string } {
  const dist = path.join(repoRoot, "dist", "entry.js");
  if (fs.existsSync(dist)) {
    return { args: [dist], label: "dist/entry.js (built)" };
  }
  return {
    args: [
      "--import",
      path.join(repoRoot, "scripts", "tsx.mjs"),
      path.join(repoRoot, "src", "entry.ts"),
    ],
    label: "src/entry.ts (tsx loader)",
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * Writes a real installable plugin whose `register()` trips one genuine warn
 * registrar refusal (unknown typed hook) and one genuine error refusal
 * (command with a blank name). `activation.onStartup` is what puts it in the
 * real Gateway startup plan.
 */
function writeFixturePlugin(): string {
  const dir = tempDir("proof-136411-plugin-");
  fs.writeFileSync(
    path.join(dir, "proof-warn.cjs"),
    `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.on(${JSON.stringify(UNKNOWN_HOOK)}, () => undefined);
    api.registerCommand({ name: "   ", description: "proof fixture", handler: () => undefined });
  },
};
`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: PLUGIN_ID,
        version: "0.0.1",
        main: "proof-warn.cjs",
        openclaw: { extensions: ["./proof-warn.cjs"] },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: PLUGIN_ID,
        version: "0.0.1",
        description: "real behavior proof fixture for PR #136411",
        main: "proof-warn.cjs",
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {} },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return dir;
}

type LogRecord = { level: string; message: string };

/** Reads the Gateway's own JSONL log file and its real per-record severity. */
function readGatewayLogRecords(file: string): LogRecord[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const records: LogRecord[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        message?: unknown;
        _meta?: { logLevelName?: unknown };
      };
      const level = parsed._meta?.logLevelName;
      records.push({
        level: typeof level === "string" ? level : "",
        message: typeof parsed.message === "string" ? parsed.message : "",
      });
    } catch {
      // A partially flushed final line is not a proof failure.
    }
  }
  return records;
}

function severityOf(records: readonly LogRecord[], needle: string): string {
  const levels = records.filter((r) => r.message.includes(needle)).map((r) => r.level);
  if (levels.length === 0) {
    return "(absent)";
  }
  return [...new Set(levels)].toSorted().join("+");
}

/** Redacts the temp roots so captured output is safe to quote publicly. */
function redact(text: string): string {
  let out = text;
  for (const dir of tempRoots) {
    out = out.split(dir).join("<temp>");
  }
  return out.split(repoRoot).join("<repo>").split(os.homedir()).join("<home>");
}

function run(
  entryArgs: string[],
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...entryArgs, ...args], { cwd: repoRoot, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function main(): Promise<number> {
  console.log("proof-136411: warn-level plugin diagnostics must use the Gateway warning sink");
  const entry = resolveEntry();
  console.log(`  entrypoint: ${entry.label}`);

  const cacheRoot = path.join(repoRoot, ".artifacts", "proof-136411");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const stateRoot = tempDir("proof-136411-home-");
  const pluginDir = writeFixturePlugin();
  const configPath = path.join(stateRoot, "openclaw.json");
  const logFile = path.join(stateRoot, "openclaw.log");
  const port = await freePort();

  // `consoleLevel: "warn"` is the operator read the fix is about: an info-level
  // diagnostic is filtered out of it entirely.
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        browser: { enabled: false },
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "none" },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        logging: { level: "info", consoleLevel: "warn", file: logFile },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const env: Record<string, string> = {
    CI: "1",
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: stateRoot,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: stateRoot,
    OPENCLAW_STATE_DIR: path.join(stateRoot, "state"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
    // HOME is a fresh temp dir every run, so without a stable cache root each
    // child would recompile the whole CLI from source and the proof would take
    // minutes instead of seconds. The caches hold build output only; nothing on
    // the path under test is cached.
    NODE_COMPILE_CACHE: path.join(cacheRoot, "node-compile-cache"),
    XDG_CACHE_HOME: path.join(cacheRoot, "xdg"),
  };

  console.log("\n=== install: the real plugins install CLI, into the isolated home ===");
  const install = await run(
    entry.args,
    ["plugins", "install", pluginDir, "--force", "--accept-capabilities"],
    env,
  );
  for (const line of redact(install.output).trim().split("\n").slice(-3)) {
    console.log(`  install | ${line}`);
  }
  check("plugins install succeeded", install.code, 0);
  if (install.code !== 0) {
    return 1;
  }

  console.log("\n=== gateway: a real startup that must present the diagnostic ===");
  let gateway: ChildProcess | undefined;
  let consoleStream = "";
  try {
    gateway = spawn(
      process.execPath,
      [
        ...entry.args,
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--auth",
        "none",
        "--tailscale",
        "off",
        "--allow-unconfigured",
      ],
      { cwd: repoRoot, env },
    );
    gateway.stdout?.on("data", (chunk: Buffer) => {
      consoleStream += chunk.toString();
    });
    gateway.stderr?.on("data", (chunk: Buffer) => {
      consoleStream += chunk.toString();
    });

    const deadline = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (response.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await delay(1_000);
    }
    check("gateway reported ready", ready, true);
    if (!ready) {
      console.log(redact(consoleStream).trim().split("\n").slice(-20).join("\n"));
      return 1;
    }

    // The diagnostics are emitted after the listener binds, and the file
    // transport flushes asynchronously; wait for the record rather than sleeping
    // a fixed interval.
    const recordDeadline = Date.now() + 60_000;
    let records = readGatewayLogRecords(logFile);
    while (
      Date.now() < recordDeadline &&
      !records.some((record) => record.message.includes(ERROR_DIAGNOSTIC))
    ) {
      await delay(500);
      records = readGatewayLogRecords(logFile);
    }

    const consoleLines = redact(consoleStream)
      .split("\n")
      .filter((line) => line.includes("[plugins]"));
    for (const line of consoleLines) {
      console.log(`  console | ${line.trim()}`);
    }
    for (const record of records.filter((r) => r.message.includes("[plugins]"))) {
      console.log(`  logfile | ${record.level} ${redact(record.message)}`);
    }

    console.log("\n--- scenario 1: WARN-SEVERITY (the fix) ---");
    check(
      "warn diagnostic severity in the gateway log",
      severityOf(records, WARN_DIAGNOSTIC),
      "WARN",
    );

    console.log("--- scenario 2: NO-INFO-RECORD ---");
    check(
      "no INFO record carries the warn diagnostic",
      records.filter((r) => r.level === "INFO" && r.message.includes(WARN_DIAGNOSTIC)).length,
      0,
    );

    console.log("--- scenario 3: WARN-VISIBLE-UNDER-FILTER ---");
    check(
      "warn diagnostic reaches a consoleLevel=warn operator read",
      consoleStream.includes(WARN_DIAGNOSTIC),
      true,
    );

    console.log("--- scenario 4: ERROR-CONTROL (untouched branch) ---");
    check(
      "error diagnostic severity in the gateway log",
      severityOf(records, ERROR_DIAGNOSTIC),
      "ERROR",
    );
    check("error diagnostic reaches the console", consoleStream.includes(ERROR_DIAGNOSTIC), true);

    console.log("--- scenario 5: FILTER-IS-REAL ---");
    check(
      "an info startup line is recorded at INFO",
      severityOf(records, INFO_STARTUP_LINE),
      "INFO",
    );
    check(
      "that info line is filtered off the console",
      consoleStream.includes(INFO_STARTUP_LINE),
      false,
    );
  } finally {
    if (gateway?.pid !== undefined && gateway.exitCode === null) {
      gateway.kill("SIGTERM");
      const stopDeadline = Date.now() + 15_000;
      while (gateway.exitCode === null && Date.now() < stopDeadline) {
        await delay(250);
      }
      if (gateway.exitCode === null) {
        gateway.kill("SIGKILL");
      }
    }
  }

  console.log(`\n5 scenarios; ${passed} passed, ${failed} failed (${passed + failed} assertions)`);
  if (failed > 0) {
    console.log("Runtime assertions FAILED.");
    return 1;
  }
  console.log("All runtime assertions passed.");
  return 0;
}

// `process.exit()` does not unwind the stack, so it cannot live inside the try:
// the fixture cleanup below would never run. main() reports its verdict as a
// return code and the single exit happens after `finally`.
async function runProof(): Promise<number> {
  try {
    return await main();
  } catch (error: unknown) {
    console.error(error);
    return 1;
  } finally {
    await heartbeat.terminate();
    removeTempRoots();
  }
}

void runProof().then((exitCode) => {
  process.exit(exitCode);
});
