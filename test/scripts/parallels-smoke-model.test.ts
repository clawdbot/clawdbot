// Parallels Smoke Model tests cover parallels smoke model script behavior.
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractLastOpenClawVersionFromLog,
  isLikelyMacosDesktopHome,
  modelProviderConfigBatchJson,
  parseProvider,
  parseMacosDsclUserHomeLine,
  readGitCommitEnv,
  readPositiveIntEnv,
  resolveLatestVersion,
  resolveParallelsModelTimeoutSeconds,
  resolveProviderAuth as resolveProviderAuthDirect,
  resolveMacosVmName,
  resolveSnapshot,
  ensureVmRunning,
  shouldSkipSnapshotRestore,
  resolveUbuntuVmName,
  resolveWindowsProviderAuth,
  run,
  runStreaming,
  shellQuote,
  SKIP_SNAPSHOT_RESTORE_ENV,
  validateSnapshotRestoreMode,
  withProgressOnStderr,
} from "../../scripts/e2e/parallels/common.ts";
import {
  LinuxGuest,
  MacosGuest,
  WindowsGuest,
  runPosixBackgroundShell,
  runWindowsBackgroundPowerShell,
} from "../../scripts/e2e/parallels/guest-transports.ts";
import { resolveHostCommandInvocation } from "../../scripts/e2e/parallels/host-command.ts";
import { testing as hostServerTesting } from "../../scripts/e2e/parallels/host-server.ts";
import { parseArgs as parseLinuxSmokeArgs } from "../../scripts/e2e/parallels/linux-smoke.ts";
import { parseArgs as parseMacosSmokeArgs } from "../../scripts/e2e/parallels/macos-smoke.ts";
import { parseArgs as parseNpmUpdateSmokeArgs } from "../../scripts/e2e/parallels/npm-update-smoke.ts";
import { testing as packageArtifactTesting } from "../../scripts/e2e/parallels/package-artifact.ts";
import { PhaseRunner } from "../../scripts/e2e/parallels/phase-runner.ts";
import {
  posixCodexPlatformPackageRepairFunction,
  windowsProviderOnlyPluginIsolationScript,
  windowsCodexPlatformPackageRepairFunction,
} from "../../scripts/e2e/parallels/plugin-isolation.ts";
import {
  resolveParallelsProviderAuth,
  runParallelsPrerequisiteEval,
} from "../../scripts/e2e/parallels/provider-auth-prerequisite.mjs";
import { parseArgs as parseWindowsSmokeArgs } from "../../scripts/e2e/parallels/windows-smoke.ts";
import { withEnv } from "../../src/test-utils/env.js";
import { spawnNodeEvalSync } from "../../src/test-utils/node-process.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const WRAPPERS = {
  linux: "scripts/e2e/parallels-linux-smoke.sh",
  macos: "scripts/e2e/parallels-macos-smoke.sh",
  npmUpdate: "scripts/e2e/parallels-npm-update-smoke.sh",
  windows: "scripts/e2e/parallels-windows-smoke.sh",
};
const WINDOWS_PREPARE_WRAPPER = "scripts/e2e/parallels-windows-prepare.sh";
const PROVIDER_AUTH_PREREQUISITE_PATH = "scripts/e2e/parallels/provider-auth-prerequisite.mjs";
const PROVIDER_AUTH_PREREQUISITE_SOURCE = readFileSync(PROVIDER_AUTH_PREREQUISITE_PATH, "utf8");

const TS_PATHS = {
  agentWorkspace: "scripts/e2e/parallels/agent-workspace.ts",
  common: "scripts/e2e/parallels/common.ts",
  guestTransports: "scripts/e2e/parallels/guest-transports.ts",
  hostCommand: "scripts/e2e/parallels/host-command.ts",
  hostServer: "scripts/e2e/parallels/host-server.ts",
  laneRunner: "scripts/e2e/parallels/lane-runner.ts",
  linux: "scripts/e2e/parallels/linux-smoke.ts",
  macosDiscord: "scripts/e2e/parallels/macos-discord.ts",
  macos: "scripts/e2e/parallels/macos-smoke.ts",
  npmUpdateScripts: "scripts/e2e/parallels/npm-update-scripts.ts",
  npmUpdate: "scripts/e2e/parallels/npm-update-smoke.ts",
  packageArtifact: "scripts/e2e/parallels/package-artifact.ts",
  parallelsVm: "scripts/e2e/parallels/parallels-vm.ts",
  phaseRunner: "scripts/e2e/parallels/phase-runner.ts",
  powershell: "scripts/e2e/parallels/powershell.ts",
  providerAuth: "scripts/e2e/parallels/provider-auth.ts",
  snapshots: "scripts/e2e/parallels/snapshots.ts",
  smokeCommon: "scripts/e2e/parallels/smoke-common.ts",
  windows: "scripts/e2e/parallels/windows-smoke.ts",
  windowsGit: "scripts/e2e/parallels/windows-git.ts",
};

const TS_SOURCE = Object.fromEntries(
  Object.entries(TS_PATHS).map(([name, filePath]) => [name, readFileSync(filePath, "utf8")]),
) as Record<keyof typeof TS_PATHS, string>;

const OS_TS_PATHS = [TS_PATHS.linux, TS_PATHS.macos, TS_PATHS.windows];
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function countNonEmptyLines(value: string): number {
  let count = 0;
  for (const line of value.split("\n")) {
    if (line) {
      count += 1;
    }
  }
  return count;
}

function expectFatalError(runTest: () => unknown, message: string): void {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  try {
    expect(runTest).toThrow("process.exit(1)");
    expect(stderr).toHaveBeenLastCalledWith(`error: ${message}\n`);
  } finally {
    exit.mockRestore();
    stderr.mockRestore();
  }
}

function fakePrlctlEnv(tempDir: string): Record<string, string> {
  const pathValue = `${tempDir}${delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
  const fakeBootstrap = pathToFileURL(join(tempDir, "prlctl-bootstrap.mjs")).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${fakeBootstrap}`]
    .filter(Boolean)
    .join(" ");
  return { NODE_OPTIONS: nodeOptions, PATH: pathValue, Path: pathValue };
}

function writeFakePrlctl(tempDir: string, posixScript: string, windowsBootstrap: string): void {
  const prlctlPath = join(tempDir, "prlctl");
  writeFileSync(prlctlPath, posixScript);
  chmodSync(prlctlPath, 0o755);
  copyFileSync(process.execPath, join(tempDir, "prlctl.exe"));
  writeFileSync(join(tempDir, "prlctl-bootstrap.mjs"), windowsBootstrap);
}

function writeNodeFakePrlctl(tempDir: string, body: string): void {
  const program = `const args = process.argv.slice(1);\n${body}`;
  writeFakePrlctl(
    tempDir,
    `#!/usr/bin/env node\n${program}\n`,
    `import { basename } from "node:path"; if ([process.argv0, process.execPath].some((value) => basename(value).toLowerCase() === "prlctl.exe")) { ${program} }`,
  );
}

function writeJsonFakePrlctl(tempDir: string, routes: Record<string, unknown>): void {
  const routeJson = JSON.stringify(routes);
  writeNodeFakePrlctl(
    tempDir,
    `const routes = ${routeJson}; for (const [command, payload] of Object.entries(routes)) { if (args.some((arg) => arg.includes(command))) { console.log(JSON.stringify(payload)); process.exit(0); } } process.exit(1);`,
  );
}

function withJsonFakePrlctl<T>(routes: Record<string, unknown>, runTest: () => T): T {
  const tempDir = makeTempDir(tempDirs, "openclaw-parallels-prlctl-");
  writeJsonFakePrlctl(tempDir, routes);
  return withEnv(fakePrlctlEnv(tempDir), runTest);
}

class FakeHostServerChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }

  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }

  exitWithSignal(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
}

class ExhaustedCleanupPhaseRunner {
  output = "";
  remainingTimeoutCalls = 0;

  append(text: string): void {
    this.output += text;
  }

  remainingTimeoutMs(fallbackMs?: number): number {
    this.remainingTimeoutCalls += 1;
    if (this.remainingTimeoutCalls > 2) {
      throw new Error("phase deadline exceeded before starting guest command");
    }
    return fallbackMs ?? 30_000;
  }
}

function createMacosGuest(phases: PhaseRunner): MacosGuest {
  return new MacosGuest(
    {
      getTransport: () => "current-user",
      getUser: () => "runner",
      path: "/usr/bin:/bin",
      resolveDesktopHome: () => "/Users/runner",
      vmName: "macOS VM",
    },
    phases,
  );
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address.");
  }
  return address.port;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("condition was not met before timeout");
}

async function waitForProcessClose(
  child: ReturnType<typeof spawn>,
  timeoutMs = 3_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("child process did not close before timeout"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function runNode(source: string, options: NonNullable<Parameters<typeof run>[2]> = {}) {
  return run(process.execPath, ["-e", source], { quiet: true, ...options });
}

function runStreamingNode(
  source: string,
  options: NonNullable<Parameters<typeof runStreaming>[2]> = {},
) {
  return runStreaming(process.execPath, ["-e", source], { quiet: true, ...options });
}

type FakeCommandResult = { status: number; stderr: string; stdout: string };
type FakePosixBackgroundOptions = {
  done?: FakeCommandResult;
  exit?: FakeCommandResult[];
  launch?: FakeCommandResult;
  pid?: FakeCommandResult;
  tail?: () => FakeCommandResult;
};

function fakeResult(status = 0, stdout = "", stderr = ""): FakeCommandResult {
  return { status, stderr, stdout };
}

function createPosixBackgroundCommandFake(options: FakePosixBackgroundOptions): {
  runCommand: ReturnType<typeof vi.fn>;
  state: { cleanupPayload: string; cleanupRun: boolean; exitRead: boolean };
} {
  const state = { cleanupPayload: "", cleanupRun: false, exitRead: false };
  const exits = [...(options.exit ?? [])];
  const runCommand = vi.fn(
    (_command: string, args: string[], runOptions?: { input?: string }): FakeCommandResult => {
      if (args[0] === "/bin/dd" && args[1]?.includes("/cleanup.sh")) {
        state.cleanupPayload = runOptions?.input ?? "";
      }
      if (args[0] === "node" && args[1]?.endsWith("/launcher.mjs")) {
        return options.launch ?? fakeResult(0, "started\n");
      }
      if (args[0] === "/bin/test" && args.at(-1)?.endsWith("/pid")) {
        return options.pid ?? fakeResult();
      }
      if (args[0] === "/bin/test" && args.at(-1)?.endsWith("/done")) {
        return options.done ?? fakeResult();
      }
      if (args[0] === "/usr/bin/tail") {
        return options.tail?.() ?? fakeResult();
      }
      if (args[0] === "/bin/cat" && args.at(-1)?.endsWith("/exit")) {
        state.exitRead = true;
        return exits.shift() ?? fakeResult();
      }
      if (args[0] === "/bin/bash" && args[1]?.endsWith("/cleanup.sh")) {
        state.cleanupRun = true;
      }
      return fakeResult(0, "started\n");
    },
  );
  return { runCommand, state };
}

function runFakePosixBackground(
  fakeOptions: FakePosixBackgroundOptions,
  options: { append?: (chunk: unknown) => void; script: string; timeoutMs?: number },
) {
  const fake = createPosixBackgroundCommandFake(fakeOptions);
  return {
    ...fake,
    result: runPosixBackgroundShell({
      ...options,
      label: "macos update",
      pollIntervalMs: 1,
      runCommand: fake.runCommand as unknown as typeof run,
      timeoutMs: options.timeoutMs ?? 5_000,
      transportArgs: (args) => args,
    }),
  };
}

async function runFailingHostServer(fakePythonSource: string) {
  const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-server-");
  const fakePython = join(tempDir, "python3");
  writeFileSync(fakePython, fakePythonSource);
  chmodSync(fakePython, 0o755);
  const port = await unusedLoopbackPort();
  return spawnNodeEvalSync(
    `import { startHostServer } from "./${TS_PATHS.hostServer}"; await startHostServer({ dir: ".", hostIp: "127.0.0.1", port: ${port}, artifactPath: "artifact.tgz", label: "artifact" });`,
    {
      env: { ...process.env, PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}` },
      imports: ["tsx"],
      maxBuffer: 1024 * 1024,
    },
  );
}

function drainableProcessTreeScript(delayMs: number): string {
  const descendantScript = `const { writeFileSync } = require('node:fs'); writeFileSync(process.env.READY_FILE, 'ready'); process.on('SIGTERM', () => setTimeout(() => { writeFileSync(process.env.DRAIN_FILE, 'drained'); process.exit(0); }, ${delayMs})); setInterval(() => {}, 1000);`;
  return `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { env: process.env, stdio: 'ignore' }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
}

const SIGNAL_GRANDCHILD_SCRIPT = `const { writeFileSync } = require('node:fs'); writeFileSync(process.env.OPENCLAW_TEST_GRANDCHILD_PID, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
const SIGNAL_PARENT_SCRIPT = `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); spawn(process.execPath, ['-e', ${JSON.stringify(SIGNAL_GRANDCHILD_SCRIPT)}], { env: process.env, stdio: 'ignore' }); writeFileSync(process.env.OPENCLAW_TEST_READY_FILE, 'ready'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;

function createSignaledHostCommandFixture(streaming: boolean) {
  const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-signal-");
  const runnerPath = join(tempDir, "runner.mjs");
  const readyPath = join(tempDir, "ready");
  const grandchildPidPath = join(tempDir, "grandchild.pid");
  const commandName = streaming ? "runStreaming" : "run";
  const hostCommandUrl = pathToFileURL(join(process.cwd(), TS_PATHS.hostCommand)).href;
  const specificOption = streaming
    ? `logPath: ${JSON.stringify(join(tempDir, "stream.log"))},`
    : "check: false,";
  writeFileSync(
    runnerPath,
    `import { ${commandName} } from ${JSON.stringify(hostCommandUrl)};
${streaming ? "await " : ""}${commandName}(process.execPath, ['-e', ${JSON.stringify(SIGNAL_PARENT_SCRIPT)}], {
  ${specificOption}
  env: { ...process.env, OPENCLAW_TEST_GRANDCHILD_PID: ${JSON.stringify(grandchildPidPath)}, OPENCLAW_TEST_READY_FILE: ${JSON.stringify(readyPath)} },
  quiet: true,
  timeoutMs: 30_000,
});`,
  );
  return {
    grandchildPidPath,
    readyPath,
    runner: spawn(process.execPath, ["--import", "tsx", runnerPath], {
      cwd: process.cwd(),
      detached: !streaming,
      stdio: "ignore",
    }),
  };
}

function forceKillSignaledFixture(
  runnerPid: number,
  grandchildPid: number,
  processGroup: boolean,
): void {
  if (runnerPid && isProcessAlive(runnerPid)) {
    process.kill(processGroup ? -runnerPid : runnerPid, "SIGKILL");
  }
  if (grandchildPid && isProcessAlive(grandchildPid)) {
    process.kill(grandchildPid, "SIGKILL");
  }
}

describe("Parallels smoke model selection", () => {
  const {
    agentWorkspace: workspace,
    guestTransports: transports,
    hostCommand,
    hostServer,
    laneRunner,
    linux,
    macos,
    macosDiscord: discord,
    npmUpdate,
    npmUpdateScripts,
    packageArtifact,
    parallelsVm,
    phaseRunner,
    powershell,
    snapshots,
    smokeCommon,
    windows,
    windowsGit,
  } = TS_SOURCE;

  it("parses macOS dscl user homes with spaces on mounted volumes", () => {
    expect(parseMacosDsclUserHomeLine("clawuser /Volumes/Macintosh HD/Users/clawuser")).toEqual({
      user: "clawuser",
      home: "/Volumes/Macintosh HD/Users/clawuser",
    });
    expect(isLikelyMacosDesktopHome("/Volumes/Macintosh HD/Users/clawuser")).toBe(true);
    expect(isLikelyMacosDesktopHome("/var/empty")).toBe(false);
  });

  it("extracts the last OpenClaw version from a bounded log tail", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-log-tail-");
    const logPath = join(tempDir, "phase.log");
    writeFileSync(logPath, ["OpenClaw 0.0.1", "x".repeat(4096), "OpenClaw 2026.6.7"].join("\n"));

    await expect(extractLastOpenClawVersionFromLog(logPath, undefined, 128)).resolves.toBe(
      "2026.6.7",
    );
  });

  it("keeps the public shell entrypoints as thin TypeScript launchers", () => {
    for (const [platform, wrapperPath] of Object.entries(WRAPPERS)) {
      const wrapper = readFileSync(wrapperPath, "utf8");
      const scriptPath =
        platform === "npmUpdate"
          ? TS_PATHS.npmUpdate
          : TS_PATHS[platform as "linux" | "macos" | "windows"];

      expect(wrapper, wrapperPath).toContain('cd "$ROOT_DIR"');
      expect(wrapper, wrapperPath).toContain(`exec node --import tsx ${scriptPath}`);
      expect(wrapper, wrapperPath).not.toContain("pnpm exec tsx");
      expect(countNonEmptyLines(wrapper)).toBeLessThanOrEqual(6);
    }
  });

  it("owns the reusable Windows VM and OpenClaw baseline lifecycle", () => {
    const controller = readFileSync(WINDOWS_PREPARE_WRAPPER, "utf8");
    expect(controller).toContain("ensure_wsl_features");
    expect(controller).toContain("resolve_winget_manifest");
    expect(controller).toContain("pre-openclaw-native-e2e-");
    expect(controller).toContain('prlctl stop "$VM_NAME" --acpi');
    expect(controller).toContain("HypervisorPresent");
    expect(controller).toContain("git --version && node --version && npm --version");
    expect(controller).toContain("wait_for_check WSL 'wsl.exe --version'");
    expect(controller).toContain("ensure_wsl_default_version");
    expect(controller).toContain("WSL default version did not become 2 within 120 seconds");
    expect(controller).toContain("1641 { exit 105 }");
    expect(controller).toContain("3010 { exit 194 }");
    expect(controller).toContain('run_bounded 1800 prlctl exec "$VM_NAME" powershell.exe');
    expect(controller).not.toContain('run_windows_installer prlctl exec "$VM_NAME"');
    expect(controller).toContain(
      "if (Test-Path -LiteralPath '${GUEST_PROFILE_PS}/Downloads/OpenClawPrereqs')",
    );
    expect(controller).toContain("winget.exe download --source winget");
    expect(controller).toContain("OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY");
    expect(controller).not.toContain("openclaw-windows-node");
  });

  it.each([
    ["ensure_node", "v24.14.0", "v24.15.0", true, 0],
    ["ensure_node", "missing", "v24.15.0", true, 0],
    ["ensure_node", "v24.15.0", "v24.15.0", false, 0],
    ["ensure_node", "v24.14.0", "v24.14.0", true, 1],
    ["verify_baseline", "v24.14.0", "v24.15.0", false, 1],
    ["verify_baseline", "v24.15.0", "v24.15.0", false, 0],
  ])(
    "%s enforces the Windows Node contract from %s after installation of %s",
    (command, initialVersion, installedVersion, installs, exitCode) => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY=1 source "$1"
guest_version="$3"
guest_user_cmd() {
  case "$1" in
    'where node.exe') [[ "$guest_version" != missing ]] ;;
    'node.exe --version') [[ "$guest_version" != missing ]] && printf '%s\\r\\n' "$guest_version" ;;
    'git --version && node --version && npm --version'|'wsl.exe --version'|'wsl.exe --status') : ;;
    *) printf 'unexpected guest command: %s\\n' "$1" >&2; return 1 ;;
  esac
}
winget_download() { printf 'download=%s\\n' "$1"; WINGET_EXPECTED_HASH=fixture; }
downloaded_installer() { printf 'node.msi'; }
stage_installer() { printf 'staged-node.msi'; }
finish_installer_reboot() { :; }
wait_for_check() { guest_user_cmd "$2"; }
set_guest_paths() { :; }
guest_system_ps() { :; }
get_wsl_default_version() { printf '2'; }
assert_clean_product_state() { :; }
assert_no_pending_reboot() { :; }
installed_version="$4"
run_windows_installer() { printf 'installed-node\\n'; guest_version="$installed_version"; }
"$2"
printf 'verified-node=%s\\n' "$guest_version"`,
          "bash",
          WINDOWS_PREPARE_WRAPPER,
          command,
          initialVersion,
          installedVersion,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );

      expect(result.status, result.stderr).toBe(exitCode);
      expect(result.stdout.includes("installed-node")).toBe(installs);
      if (installs) {
        expect(result.stdout).toContain("download=OpenJS.NodeJS.LTS");
      }
      if (exitCode === 0) {
        expect(result.stdout).toContain("verified-node=v24.15.0");
      } else {
        expect(result.stderr).toContain("upgrade Node");
      }
    },
  );

  it("waits for Windows snapshot restoration before starting the guest", () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-windows-restore-");
    const statePath = join(tempDir, "state");
    writeFileSync(statePath, "restoring");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY=1 source "$1"
vm_state() { cat "$VM_STATE_FILE"; }
sleep() { printf stopped >"$VM_STATE_FILE"; }
run_bounded() { printf 'invoked=%s\\n' "$*"; }
ensure_vm_running`,
        "bash",
        WINDOWS_PREPARE_WRAPPER,
      ],
      { encoding: "utf8", env: { ...process.env, VM_STATE_FILE: statePath }, timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Starting VM: Windows 11");
    expect(readFileSync(statePath, "utf8")).toBe("stopped");
  });

  it("resets Linux product state before both install lanes", () => {
    for (const lane of ["fresh", "upgrade"]) {
      const restoreIndex = linux.indexOf(`this.phase("${lane}.restore-snapshot"`);
      const resetIndex = linux.indexOf(`this.phase("${lane}.reset-state"`);
      const installIndex = linux.indexOf(
        `this.phase("${lane}.${lane === "fresh" ? "install-latest-bootstrap" : "install-latest"}"`,
      );
      expect(restoreIndex).toBeGreaterThanOrEqual(0);
      expect(resetIndex).toBeGreaterThan(restoreIndex);
      expect(installIndex).toBeGreaterThan(resetIndex);
    }
    expect(linux).toContain("npm uninstall -g openclaw");
    expect(linux).toContain("rm -rf /root/.openclaw /root/.npm/_cacache");
  });

  it("uses a forced Windows gateway stop only when the installed CLI supports it", () => {
    expect(windows).toContain("Invoke-OpenClaw gateway stop --help");
    expect(windows).toContain("$stopHelp -match");
    expect(windows).toContain("$gatewayArgs += '--force'");
    expect(windows).toContain("Invoke-OpenClaw @gatewayArgs");
    expect(windows).not.toContain('const forceFlag = action === "stop"');
  });

  it("preserves caller arguments when loaded as the Windows controller library", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -- run-tests --app-option; OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY=1 source "$1"; printf "%s\\n" "$*"',
        "bash",
        WINDOWS_PREPARE_WRAPPER,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("run-tests --app-option");
  });

  it("bounds Windows prerequisite metadata downloads", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY=1 source "$1"; curl() { printf "%s\\n" "$@"; }; fetch_host_metadata "https://example.test/metadata"',
        "bash",
        WINDOWS_PREPARE_WRAPPER,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "-fsSL",
      "--connect-timeout",
      "10",
      "--max-time",
      "120",
      "https://example.test/metadata",
    ]);

    const controller = readFileSync(WINDOWS_PREPARE_WRAPPER, "utf8");
    expect(controller.match(/\bcurl -fsSL\b/g)).toHaveLength(1);
    expect(controller.match(/\bfetch_host_metadata\b/g)).toHaveLength(5);
    expect(controller).toContain("for attempt in 1 2 3");
    expect(controller).not.toContain("--retry 2");

    const tempDir = makeTempDir(tempDirs, "openclaw-windows-metadata-retry-");
    const callCount = join(tempDir, "curl-calls");
    writeFileSync(callCount, "0\n");
    const retryResult = spawnSync(
      "bash",
      [
        "-c",
        `OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY=1 source "$1"; curl() { count="$(<"$CURL_CALL_COUNT")"; count=$((count + 1)); printf '%s\\n' "$count" >"$CURL_CALL_COUNT"; if [[ "$count" == "1" ]]; then printf 'partial-'; return 28; fi; printf 'complete'; }; sleep() { :; }; fetch_host_metadata "https://example.test/metadata"`,
        "bash",
        WINDOWS_PREPARE_WRAPPER,
      ],
      { encoding: "utf8", env: { ...process.env, CURL_CALL_COUNT: callCount } },
    );
    expect(retryResult.status, retryResult.stderr).toBe(0);
    expect(retryResult.stdout).toBe("complete");
    expect(readFileSync(callCount, "utf8")).toBe("2\n");
  });

  it("accepts leading package-manager separators and still honors later terminators", () => {
    expect(parseLinuxSmokeArgs(["--", "--mode", "upgrade"]).mode).toBe("upgrade");
    expect(parseLinuxSmokeArgs(["--mode", "fresh", "--", "--mode", "upgrade"]).mode).toBe("fresh");
    expect(parseMacosSmokeArgs(["--", "--mode", "upgrade"]).mode).toBe("upgrade");
    expect(parseMacosSmokeArgs(["--mode", "fresh", "--", "--mode", "upgrade"]).mode).toBe("fresh");
    expect(parseMacosSmokeArgs([]).vmNameExplicit).toBe(false);
    expect(parseMacosSmokeArgs(["--vm", "macOS"]).vmNameExplicit).toBe(true);
    expect(parseMacosSmokeArgs(["--host-port", "65535"]).hostPort).toBe(65535);
    expect(parseLinuxSmokeArgs(["--host-port", "65535"]).hostPort).toBe(65535);
    expect(parseWindowsSmokeArgs(["--host-port", "65535"]).hostPort).toBe(65535);
    expect(parseWindowsSmokeArgs([]).snapshotHint).toBe("pre-openclaw-native-e2e-");
    for (const parseArgs of [parseMacosSmokeArgs, parseLinuxSmokeArgs, parseWindowsSmokeArgs]) {
      expect(parseArgs(["--npm-registry", "http://192.0.2.2:48123"]).npmRegistry).toBe(
        "http://192.0.2.2:48123",
      );
    }
    expect(parseNpmUpdateSmokeArgs(["--", "--package-spec", "openclaw@2026.5.1"]).packageSpec).toBe(
      "openclaw@2026.5.1",
    );
    expect(
      parseNpmUpdateSmokeArgs([
        "--package-spec",
        "openclaw@2026.5.1",
        "--",
        "--package-spec",
        "openclaw@latest",
      ]).packageSpec,
    ).toBe("openclaw@2026.5.1");
    expect(parseNpmUpdateSmokeArgs(["--macos-vm", "macOS"]).macosVm).toBe("macOS");
    expect(parseWindowsSmokeArgs(["--", "--upgrade-from-packed-main"]).upgradeFromPackedMain).toBe(
      true,
    );
    expect(
      parseWindowsSmokeArgs(["--mode", "fresh", "--", "--upgrade-from-packed-main"])
        .upgradeFromPackedMain,
    ).toBe(false);
  });

  it("starts the default macOS upgrade without host networking or packaging the checkout", () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-macos-upgrade-no-pack-");
    writeNodeFakePrlctl(
      tempDir,
      `if (args.includes("list")) {
         console.log(JSON.stringify([{ name: "macOS Tahoe", status: "running" }]));
         process.exit(0);
       }
       if (args.includes("exec") && args.includes("whoami")) {
         console.log("runner");
         process.exit(0);
       }
       process.stderr.write("FAKE_GUEST_COMMAND_BOUNDARY\\n");
       process.exit(73);`,
    );
    const fakePnpm = join(tempDir, "pnpm");
    writeFileSync(
      fakePnpm,
      '#!/usr/bin/env node\nprocess.stderr.write("UNEXPECTED_HOST_PACKAGE_BUILD\\n"); process.exit(86);\n',
    );
    chmodSync(fakePnpm, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        TS_PATHS.macos,
        "--mode",
        "upgrade",
        "--latest-version",
        "2026.8.25",
        "--api-key-env",
        "OPENCLAW_PARALLELS_TEST_API_KEY",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ...fakePrlctlEnv(tempDir),
          "BASH_FUNC_ifconfig%%": "() { return 1; }",
          OPENCLAW_PARALLELS_ARTIFACT_ROOT: join(tempDir, "artifacts"),
          OPENCLAW_PARALLELS_SKIP_SNAPSHOT_RESTORE: "1",
          OPENCLAW_PARALLELS_TEST_API_KEY: "fixture-not-a-real-credential",
          TMPDIR: tempDir,
          npm_execpath: fakePnpm,
        },
      },
    );

    expect(result.stderr).toContain("upgrade.restore-snapshot");
    expect(result.stderr).toContain("upgrade.reset-state");
    expect(result.stderr).toContain("FAKE_GUEST_COMMAND_BOUNDARY");
    expect(result.stderr).not.toContain("UNEXPECTED_HOST_PACKAGE_BUILD");
  });

  it("rejects short flags as Parallels smoke option values", () => {
    const cases = [
      [parseLinuxSmokeArgs, "--mode", "-h"],
      [parseMacosSmokeArgs, "--vm", "-h"],
      [parseWindowsSmokeArgs, "--model", "-h"],
      [parseNpmUpdateSmokeArgs, "--target-tarball", "-h"],
    ] as const;
    for (const [parseArgs, flag, value] of cases) {
      expectFatalError(() => parseArgs([flag, value]), `${flag} requires a value`);
    }
  });

  it("rejects inherited object keys as unknown Parallels smoke arguments", () => {
    for (const parseArgs of [parseMacosSmokeArgs, parseLinuxSmokeArgs, parseWindowsSmokeArgs]) {
      for (const arg of ["constructor", "toString"]) {
        expectFatalError(() => parseArgs([arg, "ignored"]), `unknown arg: ${arg}`);
      }
    }
  });

  it("keeps provider auth and model defaults in the shared helper", () => {
    expect(PROVIDER_AUTH_PREREQUISITE_SOURCE).toContain("OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL");
    expect(PROVIDER_AUTH_PREREQUISITE_SOURCE).toContain("openai/gpt-5.6-luna");
    expect(PROVIDER_AUTH_PREREQUISITE_SOURCE).toContain("tokenProvider: input.provider");

    for (const scriptPath of [...OS_TS_PATHS, TS_PATHS.npmUpdate]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toMatch(/resolve(?:Windows)?ProviderAuth/u);
      expect(script, scriptPath).toContain("--model <provider/model>");
      expect(script, scriptPath).toContain("modelId");
    }

    for (const scriptPath of [TS_PATHS.linux, TS_PATHS.macos]) {
      expect(readFileSync(scriptPath, "utf8")).toContain(
        '...(this.auth.tokenProvider ? ["--token-provider", this.auth.tokenProvider] : [])',
      );
    }
    expect(windows).toContain("tokenProviderArg");
  });

  it("repairs only the exact missing Codex platform package failure with a fresh npm cache", () => {
    const posixRepair = posixCodexPlatformPackageRepairFunction();
    const windowsRepair = windowsCodexPlatformPackageRepairFunction();

    for (const repair of [posixRepair, windowsRepair]) {
      expect(repair).toContain("Missing optional dependency @openai/codex-");
      expect(repair).toContain("NPM_CONFIG_CACHE");
      expect(repair).toContain("--ignore-scripts");
      expect(repair).toContain("codex-platform-repair: managed npm install completed");
    }
    expect(posixRepair).toContain("repair_missing_codex_platform_package");
    expect(windowsRepair).toContain("Repair-MissingCodexPlatformPackage");
  });

  it("keeps Windows provider-only plugin isolation temp scripts per run", () => {
    const script = windowsProviderOnlyPluginIsolationScript({
      fallbackPluginId: "openai",
      modelId: "openai/gpt-5.6-luna",
    });

    expect(script).toContain("[guid]::NewGuid().ToString('N')");
    expect(script).toContain("openclaw-parallels-plugin-isolation-");
    expect(script).not.toContain("'openclaw-parallels-plugin-isolation.cjs'");
    expect(script).toContain("try {");
    expect(script).toContain("} finally {");
    expect(script).toContain(
      "Remove-Item $isolationScriptPath -Force -ErrorAction SilentlyContinue",
    );
    expect(script).toContain("Remove-Item Env:OPENCLAW_PARALLELS_PLUGIN_ISOLATION");
  });

  it("writes full model ids as config map keys in provider batches", () => {
    const batch = JSON.parse(modelProviderConfigBatchJson("openai/gpt-5.5", "windows")) as Array<{
      path: string;
      value: unknown;
    }>;

    expect(batch.map((entry) => entry.path)).toContain('agents.defaults.models["openai/gpt-5.5"]');
    expect(JSON.stringify(batch)).not.toContain("agentRuntime");
  });

  it("keeps snapshot, host, package, and quote helpers shared", () => {
    const common = TS_SOURCE.common;

    expect(common).toContain('export * from "./host-command.ts"');
    expect(common).toContain('export * from "./lane-runner.ts"');
    const packageArtifactExports = new Set(
      (common.match(/export \{([^}]*)\} from "\.\/package-artifact\.ts";/)?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    expect(packageArtifactExports).toContain("packOpenClaw");
    expect(packageArtifactExports).toContain("packageVersionFromTgz");
    expect(packageArtifactExports).toContain("resolveOpenClawRegistryVersion");
    expect(common).not.toContain('export * from "./package-artifact.ts"');
    expect(common).toContain('export * from "./parallels-vm.ts"');
    expect(common).toContain('export * from "./snapshots.ts"');
    expect(hostCommand).toContain("export function shellQuote");
    expect(laneRunner).toContain("export async function runSmokeLane");
    expect(packageArtifact).toContain("withPackageLock");
    expect(packageArtifact).toContain("Wait for Parallels package lock");
    expect(packageArtifact).toContain("export async function packageVersionFromTgz");
    expect(packageArtifact).toContain("export async function packOpenClaw");
    expect(packageArtifact).toContain('"--allow-unreleased-changelog"');
    expect(packageArtifact).toContain("function resolveNpmPackTarballFilename");
    expect(packageArtifact).toContain("filename !== path.basename(filename)");
    expect(packageArtifact).toContain("filename !== path.win32.basename(filename)");
    expect(packageArtifact).toContain("npm pack did not report a safe tarball filename");
    expect(packageArtifact).not.toContain("path.basename(packed)");
    expect(parallelsVm).toContain("export function resolveUbuntuVmName");
    expect(parallelsVm).toContain("export function resolveMacosVmName");
    expect(parallelsVm).toContain("export function waitForVmStatus");
    expect(hostServer).toContain("export async function startHostServer");
    expect(hostServer).toContain("export async function startNpmRegistryServer");
    expect(hostServer).toContain("hostUrl: `http://127.0.0.1:${port}`");
    expect(hostServer).toContain('OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org"');
    expect(hostServer).toContain("http.server");
    expect(snapshots).toContain("export function resolveSnapshot");
    expect(smokeCommon).toContain("runSmokeLane");
    expect(smokeCommon).toContain("abstract class SmokeRunController");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("resolveSnapshot");
      expect(script, scriptPath).toContain(
        scriptPath === TS_PATHS.macos ? "runSmokeLane" : "SmokeRunController",
      );
      expect(script, scriptPath).not.toContain("def aliases(name: str)");
    }
  });

  it("bounds host artifact server startup stderr", () => {
    const retained = hostServerTesting.appendBoundedOutput(
      "a".repeat(10),
      Buffer.from("b".repeat(10)),
      12,
    );
    expect(retained).toBe(`${"a".repeat(2)}${"b".repeat(10)}`);
  });

  it("accepts npm 10/11 array and npm 12 workspace result shapes", () => {
    expect(
      packageArtifactTesting.resolveNpmPackTarballFilename([
        { filename: "openclaw-2026.6.11.tgz" },
      ]),
    ).toBe("openclaw-2026.6.11.tgz");
    expect(
      packageArtifactTesting.resolveNpmPackTarballFilename({
        openclaw: { filename: "openclaw-2026.6.11.tgz" },
      }),
    ).toBe("openclaw-2026.6.11.tgz");
  });

  it("keeps fresh package locks with malformed owner pids", async () => {
    const lockDir = makeTempDir(tempDirs, "openclaw-parallels-package-lock-");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), '{"pid":-1,"token":"stale"}\n');

    await expect(packageArtifactTesting.readLockOwner(lockDir)).resolves.toEqual({
      pid: undefined,
      token: "stale",
    });

    await packageArtifactTesting.removeStalePackageLock(lockDir, 2 * 60 * 60_000);

    expect(existsSync(lockDir)).toBe(true);
  });

  it("reclaims stale package locks with malformed owner pids", async () => {
    const lockDir = makeTempDir(tempDirs, "openclaw-parallels-package-lock-");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), '{"pid":-1,"token":"stale"}\n');

    await packageArtifactTesting.removeStalePackageLock(lockDir, 0);

    expect(existsSync(lockDir)).toBe(false);
  });

  it("removes a just-created package lock when owner writing fails", async () => {
    const parentDir = makeTempDir(tempDirs, "openclaw-parallels-package-lock-parent-");
    const lockDir = join(parentDir, "package.lock");
    const error = new Error("failed to write owner");

    await expect(
      packageArtifactTesting.acquirePackageLock(lockDir, "owner-token", {
        writeOwner: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);

    expect(existsSync(lockDir)).toBe(false);
  });

  it("keeps JSON-mode progress off stdout", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withProgressOnStderr(async () => {
        const { say } = await import("../../scripts/e2e/parallels/common.ts");
        say("progress");
        process.stdout.write('{"ok":true}\n');
      });

      expect(stdoutWrite).toHaveBeenCalledTimes(1);
      expect(stdoutWrite).toHaveBeenCalledWith('{"ok":true}\n');
      expect(JSON.parse(String(stdoutWrite.mock.calls[0]?.[0]))).toEqual({ ok: true });
      expect(stderrWrite).toHaveBeenCalledWith("==> progress\n");
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it("waits for host artifact server exit after SIGKILL before stop resolves", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeHostServerChild();
      const stop = hostServerTesting.stopHostServerChild(child as never, 100, 100);
      expect(child.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(100);
      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);

      let resolved = false;
      void stop.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);

      child.exit();
      await expect(stop).resolves.toBe(true);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats signaled host artifact server children as already exited", async () => {
    const child = new FakeHostServerChild();
    child.exitWithSignal("SIGTERM");

    await expect(hostServerTesting.stopHostServerChild(child as never, 100, 100)).resolves.toBe(
      true,
    );
    expect(child.signals).toEqual([]);
  });

  it("uses a temporary npmrc file and cleans it after resolving the latest package version", () => {
    const tempRoot = makeTempDir(tempDirs, "openclaw-parallels-version-");
    let userConfigPath = "";
    const version = resolveLatestVersion("", {
      createTempDir: (prefix) => {
        expect(prefix).toBe(join(tmpdir(), "openclaw-npm-"));
        return mkdtempSync(join(tempRoot, "npm-"));
      },
      runCommand: (command, args, options) => {
        userConfigPath = args.at(-1) ?? "";
        expect(command).toBe("npm");
        expect(args).toEqual(["view", "openclaw", "version", "--userconfig", userConfigPath]);
        expect(options).toEqual({ quiet: true });
        expect(statSync(userConfigPath).isFile()).toBe(true);
        return { status: 0, stderr: "", stdout: "2026.6.1\n" };
      },
    });

    expect(version).toBe("2026.6.1");
    expect(basename(userConfigPath)).toBe("npmrc");
    expect(existsSync(userConfigPath)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "reports only the bounded host artifact server stderr tail",
    async () => {
      const result = await runFailingHostServer(
        `#!/usr/bin/env bash
set -euo pipefail; printf 'BEGIN_MARKER\\n' >&2; head -c 50000 </dev/zero | tr '\\0' x >&2; printf '\\nTAIL_MARKER\\n' >&2; head -c 30000 </dev/zero | tr '\\0' x >&2; exit 42`,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("host artifact server exited early");
      expect(result.stderr).toContain("TAIL_MARKER");
      expect(result.stderr).not.toContain("BEGIN_MARKER");
      expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(90 * 1024);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports signaled host artifact server startup exits immediately",
    async () => {
      const result = await runFailingHostServer(
        `#!/usr/bin/env bash
kill -TERM "$$"`,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("host artifact server exited early: signal SIGTERM");
      expect(result.stderr).not.toContain("did not start");
    },
  );

  it("quotes shell args and resolves fuzzy snapshot hints through the shared TypeScript helper", () => {
    const output = withJsonFakePrlctl(
      {
        "snapshot-list": {
          "{older}": { name: "fresh", state: "running" },
          "{wanted}": { name: "fresh-poweroff-2026-04-01", state: "poweroff" },
          "{old-e2e}": {
            name: "pre-openclaw-native-e2e-2026-03-12",
            state: "poweroff",
            date: "2026-03-12 22:32:24",
          },
          "{new-e2e}": {
            name: "pre-openclaw-native-e2e-2026-07-26",
            state: "poweroff",
            date: "2026-07-26 11:52:02",
          },
          "{undated-first}": { name: "undated-family-1", state: "poweroff" },
          "{dated-later}": {
            name: "undated-family-2",
            state: "poweroff",
            date: "2026-07-26 11:52:02",
          },
          "{other}": { name: "unrelated", state: "poweroff" },
        },
      },
      () => {
        const snapshot = resolveSnapshot("vm", "fresh");
        const latestE2e = resolveSnapshot("vm", "pre-openclaw-native-e2e-");
        const missingDate = resolveSnapshot("vm", "undated-family-");
        return [
          shellQuote("it's ok"),
          [snapshot.id, snapshot.state, snapshot.name].join("\t"),
          [latestE2e.id, latestE2e.state, latestE2e.name].join("\t"),
          [missingDate.id, missingDate.state, missingDate.name].join("\t"),
        ].join("\n");
      },
    );

    expect(output.split("\n")[0]).toBe("'it'\"'\"'s ok'");
    expect(output).toContain("{wanted}\tpoweroff\tfresh-poweroff-2026-04-01");
    expect(output).toContain("{new-e2e}\tpoweroff\tpre-openclaw-native-e2e-2026-07-26");
    expect(output).toContain("{undated-first}\tpoweroff\tundated-family-1");
  });

  it("resolves a latest snapshot hint to the matching version before older LATEST labels", () => {
    const output = withJsonFakePrlctl(
      {
        "snapshot-list": {
          "{old}": { name: "macOS 26.3.1 LATEST", state: "poweron" },
          "{wanted}": { name: "macOS 26.5", state: "poweron" },
        },
      },
      () => {
        const snapshot = resolveSnapshot("vm", "macOS 26.5 latest");
        return [snapshot.id, snapshot.state, snapshot.name].join("\t");
      },
    );

    expect(output).toBe("{wanted}\tpoweron\tmacOS 26.5");
  });

  it.each(["poweron", "poweroff"] as const)(
    "restores a %s macOS snapshot without discarding its saved desktop session",
    (snapshotState) => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-macos-restore-");
      const callsPath = join(tempDir, "prlctl-calls.jsonl");
      const statePath = join(tempDir, "vm-state");
      writeNodeFakePrlctl(
        tempDir,
        `const fs = process.getBuiltinModule("node:fs");
const callsPath = ${JSON.stringify(callsPath)};
const statePath = ${JSON.stringify(statePath)};
const snapshotState = ${JSON.stringify(snapshotState)};
const commandIndex = args.findIndex((arg) =>
  ["list", "snapshot-list", "snapshot-switch", "status", "start", "exec"].includes(arg),
);
const commandArgs = args.slice(commandIndex);
fs.appendFileSync(callsPath, JSON.stringify(commandArgs) + "\\n");
if (commandArgs[0] === "list") {
  console.log(JSON.stringify([{ name: "macOS Tahoe", status: "running" }]));
} else if (commandArgs[0] === "snapshot-list") {
  console.log(JSON.stringify({ "{snapshot}": { name: "macOS 26.5 latest", state: snapshotState } }));
} else if (commandArgs[0] === "snapshot-switch") {
  fs.writeFileSync(statePath, snapshotState === "poweroff" || commandArgs.includes("--skip-resume") ? "stopped" : "running");
} else if (commandArgs[0] === "status") {
  console.log("VM macOS Tahoe " + fs.readFileSync(statePath, "utf8"));
} else if (commandArgs[0] === "start") {
  fs.writeFileSync(statePath, "running");
} else if (commandArgs[0] === "exec" && commandArgs.includes("whoami")) {
  console.log("desktop-user");
} else if (commandArgs[0] === "exec" && commandArgs.includes("/bin/dd")) {
  process.exit(41);
}`,
      );

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          TS_PATHS.macos,
          "--mode",
          "upgrade",
          "--latest-version",
          "2026.1.1",
          "--api-key-env",
          "OPENCLAW_PARALLELS_TEST_KEY",
          "--json",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            ...fakePrlctlEnv(tempDir),
            OPENCLAW_PARALLELS_ARTIFACT_ROOT: tempDir,
            OPENCLAW_PARALLELS_TEST_KEY: "fixture",
          },
          timeout: 20_000,
        },
      );

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("macOS guest command failed with exit code 41");
      const calls = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        calls.find(([command]) => command === "snapshot-switch"),
        result.stderr,
      ).toEqual(["snapshot-switch", "macOS Tahoe", "--id", "{snapshot}"]);
      expect(calls.filter(([command]) => command === "start")).toHaveLength(
        snapshotState === "poweroff" ? 1 : 0,
      );
    },
    30_000,
  );

  it("rejects skip-restore for combined Parallels smoke lanes", () => {
    expect(withEnv({ [SKIP_SNAPSHOT_RESTORE_ENV]: "1" }, () => shouldSkipSnapshotRestore())).toBe(
      true,
    );
    const invalidSkipBothResult = spawnNodeEvalSync(
      `process.env.${SKIP_SNAPSHOT_RESTORE_ENV} = "1"; const { validateSnapshotRestoreMode } = await import("./${TS_PATHS.common}"); validateSnapshotRestoreMode("both", "test smoke");`,
      { env: process.env, imports: ["tsx"] },
    );
    expect(invalidSkipBothResult.status).toBe(1);
    expect(invalidSkipBothResult.stderr).toContain(
      "OPENCLAW_PARALLELS_SKIP_SNAPSHOT_RESTORE=1 requires --mode fresh or --mode upgrade",
    );
    expect(() =>
      withEnv({ [SKIP_SNAPSHOT_RESTORE_ENV]: "1" }, () =>
        validateSnapshotRestoreMode("fresh", "test smoke"),
      ),
    ).not.toThrow();
    expect(() => validateSnapshotRestoreMode("both", "test smoke")).not.toThrow();
  });

  it("uses one Ubuntu VM fallback resolver for Linux lanes", () => {
    const output = withJsonFakePrlctl(
      {
        list: [
          { name: "Ubuntu 9007199254740993.04" },
          { name: "Ubuntu 26.04" },
          { name: "Ubuntu 25.10" },
          { name: "Ubuntu 23.10" },
          { name: "Ubuntu 24.04.3 ARM64" },
        ],
      },
      () => resolveUbuntuVmName("Ubuntu missing"),
    );

    expect(output).toBe("Ubuntu 26.04");
  });

  it("skips unsafe Ubuntu version names in fallback resolver", () => {
    const output = withJsonFakePrlctl(
      {
        list: [{ name: "Ubuntu 9007199254740993.04" }, { name: "Ubuntu 23.10" }],
      },
      () => resolveUbuntuVmName("Ubuntu missing"),
    );

    expect(output).toBe("Ubuntu 23.10");
  });

  it("uses the only macOS VM when the default name is unavailable", () => {
    const output = withJsonFakePrlctl({ list: [{ name: "Windows 11" }, { name: "macOS" }] }, () =>
      resolveMacosVmName("macOS Tahoe"),
    );

    expect(output).toBe("macOS");
  });

  it("does not infer destructive macOS smoke targets from arbitrary names", () => {
    const result = withJsonFakePrlctl({ list: [{ name: "macOS Work" }] }, () =>
      spawnNodeEvalSync(
        `const { resolveMacosVmName } = await import("./${TS_PATHS.parallelsVm}"); resolveMacosVmName("macOS Tahoe");`,
        { env: process.env, imports: ["tsx"] },
      ),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("select a macOS VM explicitly");
  });

  it("resumes suspended Parallels VMs", () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-vm-resume-");
    const statePath = join(tempDir, "state");
    writeFileSync(statePath, "suspended");
    writeNodeFakePrlctl(
      tempDir,
      `const { readFileSync, writeFileSync } = process.getBuiltinModule("node:fs"); if (args.includes("list")) { console.log(JSON.stringify([{ name: "Suspended VM", status: readFileSync(${JSON.stringify(statePath)}, "utf8") }])); process.exit(0); } if (args.includes("resume")) { writeFileSync(${JSON.stringify(statePath)}, "running"); process.exit(0); } process.exit(1);`,
    );
    const sleepPath = join(tempDir, "sleep");
    writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(sleepPath, 0o755);

    withEnv(fakePrlctlEnv(tempDir), () => ensureVmRunning("Suspended VM"));
    expect(readFileSync(statePath, "utf8")).toBe("running");
  });

  it("waits for apt locks during Linux snapshot bootstrap", () => {
    expect(linux).toContain("APT_LOCK_RETRY_SECONDS = 900");
    expect(linux).toContain("BOOTSTRAP_TIMEOUT_SECONDS = 1200");
    expect(linux).toContain("command -v wget");
    expect(linux).toContain("run_apt_with_lock_retry");
    expect(linux).toContain('"Could not get lock"');
    expect(linux).toContain('"Unable to acquire the dpkg frontend lock"');
    expect(linux).toContain('"Unable to lock directory"');
    expect(linux).toContain("downloadGuestFile");
    expect(linux).toContain("this.downloadGuestFile(tgzUrl");
    expect(linux).toContain("curl -fsSL --connect-timeout 10 --max-time 120 --retry 2");
    expect(linux).toContain("wget -q --timeout=10 --read-timeout=120 --tries=3");
  });

  it("keeps Linux bad-plugin diagnostics gated for historical update baselines", () => {
    expect(linux).toContain('BAD_PLUGIN_DIAGNOSTIC_MIN_VERSION = "2026.5.7"');
    expect(linux).toContain("parseOpenClawPackageVersion");
    expect(linux).toContain("maybeInjectBadPluginFixture");
    expect(linux).toContain("maybeVerifyBadPluginDiagnostic");
    expect(linux).toContain("Skipping bad plugin diagnostic fixture");
    expect(linux).toContain("Skipping bad plugin diagnostic assertion");
  });

  it("resolves provider defaults and explicit model overrides", () => {
    expect(
      resolveParallelsProviderAuth({ provider: "openai" }, { OPENAI_API_KEY: "sk-openai" }),
    ).toMatchObject({
      auth: { apiKeyEnv: "OPENAI_API_KEY", modelId: "openai/gpt-5.6-luna" },
      reason: null,
      status: "ready",
    });
    expect(
      resolveParallelsProviderAuth(
        {
          apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
          provider: "anthropic",
        },
        {
          CUSTOM_ANTHROPIC_KEY: "sk-anthropic",
          OPENCLAW_PARALLELS_ANTHROPIC_MODEL: "  anthropic/custom  ",
        },
      ),
    ).toMatchObject({
      auth: { apiKeyEnv: "CUSTOM_ANTHROPIC_KEY", modelId: "  anthropic/custom  " },
      reason: null,
      status: "ready",
    });
    const inheritedCredentials = Object.create(null) as Record<string, string>;
    for (const name of ["constructor", "toString", "__proto__"]) {
      Object.defineProperty(inheritedCredentials, name, { value: "inherited-secret" });
    }
    const inheritedEnv = Object.create(inheritedCredentials) as Record<string, string>;
    for (const apiKeyEnv of ["constructor", "toString", "__proto__"]) {
      expect(
        resolveParallelsProviderAuth({ apiKeyEnv, provider: "openai" }, inheritedEnv),
      ).toMatchObject({
        auth: { apiKeyValue: "" },
        reason: "credential_missing",
        status: "blocked",
      });
    }
    expect(
      withEnv({ OPENAI_API_KEY: "sk-openai" }, () =>
        resolveProviderAuthDirect({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "apiKey",
      authKeyFlag: "openai-api-key",
      modelId: "openai/gpt-5.6-luna",
      tokenProvider: "openai",
    });

    const windowsEnv = {
      OPENAI_API_KEY: "sk-openai",
      OPENCLAW_PARALLELS_OPENAI_MODEL: "openai/generic",
      OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL: "openai/windows",
    };
    const frozenWindows = resolveParallelsProviderAuth(
      { platform: "windows", provider: "openai" },
      windowsEnv,
    );
    expect(frozenWindows).toMatchObject({
      auth: { modelId: "openai/windows" },
      reason: null,
      status: "ready",
    });
    expect(withEnv(windowsEnv, () => resolveWindowsProviderAuth({ provider: "openai" }))).toEqual(
      frozenWindows.auth,
    );
    expect(
      resolveParallelsProviderAuth(
        { modelId: "openai/explicit", platform: "windows", provider: "openai" },
        windowsEnv,
      ).auth.modelId,
    ).toBe("openai/explicit");
    const whitespaceEnv = { OPENAI_API_KEY: "sk-openai", OPENCLAW_PARALLELS_OPENAI_MODEL: "   " };
    expect([
      resolveParallelsProviderAuth({ platform: "windows", provider: "openai" }, whitespaceEnv).auth
        .modelId,
      withEnv(whitespaceEnv, () => resolveWindowsProviderAuth({ provider: "openai" }).modelId),
    ]).toEqual(["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"]);

    expect(
      withEnv({ CUSTOM_ANTHROPIC_KEY: "sk-anthropic" }, () =>
        resolveProviderAuthDirect({
          apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
          modelId: "anthropic/custom",
          provider: "anthropic",
        }),
      ),
    ).toEqual({
      apiKeyEnv: "CUSTOM_ANTHROPIC_KEY",
      apiKeyValue: "sk-anthropic",
      authChoice: "apiKey",
      authKeyFlag: "anthropic-api-key",
      modelId: "anthropic/custom",
      tokenProvider: "anthropic",
    });
  });

  it("keeps prerequisite adapter failures sanitized and closed", () => {
    const cases = [
      ["--prerequisite-check", "--json", "--provider", "openai", "--provider", "anthropic"],
      ["--prerequisite-check", "--json", "--unknown"],
      ["--prerequisite-check", "--json", "--provider"],
      ["--prerequisite-check", "--json", "--provider", "unsupported-secret"],
      ["--prerequisite-check", "--json", "--provider", "constructor"],
      ["--prerequisite-check", "--json", "--platform", "private-platform"],
      ["--prerequisite-check", "--json", "--only", "windows,windows"],
      ["--prerequisite-check"],
    ];
    for (const args of cases) {
      const output: string[] = [];
      expect(runParallelsPrerequisiteEval(args, {}, { write: (value) => output.push(value) })).toBe(
        1,
      );
      expect(output).toEqual([
        '{"schema":"openclaw.parallels-prerequisite.v1","status":"blocked","reason":"invalid_arguments"}\n',
      ]);
      expect(output[0]).not.toContain("unsupported-secret");
    }

    const inheritedCredentials = Object.create(null) as Record<string, string>;
    for (const name of ["constructor", "toString", "__proto__"]) {
      Object.defineProperty(inheritedCredentials, name, { value: "inherited-secret" });
    }
    for (const apiKeyEnv of ["constructor", "toString", "__proto__"]) {
      const output: string[] = [];
      expect(
        runParallelsPrerequisiteEval(
          ["--prerequisite-check", "--json", "--api-key-env", apiKeyEnv],
          Object.create(inheritedCredentials) as Record<string, string>,
          { write: (value) => output.push(value) },
        ),
      ).toBe(1);
      expect(output).toEqual([
        '{"schema":"openclaw.parallels-prerequisite.v1","status":"blocked","reason":"credential_missing"}\n',
      ]);
    }

    const output: string[] = [];
    const env = { OPENAI_API_KEY: "sk-openai" };
    Object.defineProperty(env, "OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL", {
      get: () => {
        throw new Error("sentinel-secret");
      },
    });
    const write = (value: string) => output.push(value);
    expect(
      [
        ["--prerequisite-check", "--json"],
        ["--prerequisite-check", "--json", "--platform", "windows"],
        ["--prerequisite-check", "--json", "--only", "linux"],
      ].map((args) => runParallelsPrerequisiteEval(args, env, { write })),
    ).toEqual([1, 1, 0]);
    expect(output).toEqual([
      '{"schema":"openclaw.parallels-prerequisite.v1","status":"blocked","reason":"internal_error"}\n',
      '{"schema":"openclaw.parallels-prerequisite.v1","status":"blocked","reason":"internal_error"}\n',
      '{"schema":"openclaw.parallels-prerequisite.v1","status":"ready","reason":null}\n',
    ]);
    expect(output.join("")).not.toContain("sentinel-secret");
  });

  it("rejects invalid providers and missing keys before touching guests", () => {
    expectFatalError(() => parseProvider("bogus"), "invalid --provider: bogus");
    expectFatalError(
      () =>
        withEnv({ PARALLELS_TEST_MISSING_KEY: "" }, () =>
          resolveProviderAuthDirect({
            apiKeyEnv: "PARALLELS_TEST_MISSING_KEY",
            provider: "openai",
          }),
        ),
      "PARALLELS_TEST_MISSING_KEY is required",
    );
  });

  it("seeds agent workspace state before OS smoke agent turns", () => {
    // workspace-state.json was retired (b6535fb8de5: stop writing retired
    // smoke state); identity/bootstrap seeding remains the contract.
    expect(workspace).not.toContain("workspace-state.json");
    expect(workspace).toContain("IDENTITY.md");
    expect(workspace).toContain("BOOTSTRAP.md");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("AgentWorkspaceScript");
      expect(script, scriptPath).toContain("parallels-");
      if (scriptPath !== TS_PATHS.windows) {
        expect(script, scriptPath).toContain("agents.defaults.skipBootstrap");
        expect(script, scriptPath).toContain("tools.profile");
      }
      expect(script, scriptPath).toContain("--thinking");
      expect(script, scriptPath).toContain("off");
      expect(script, scriptPath).toContain("finalAssistant(Raw|Visible)Text");
    }
    expect(macos).toContain("modelProviderConfigBatchJson");
    expect(macos).toContain("config set --batch-file");
    expect(linux).toContain("modelProviderConfigBatchJson");
    expect(linux).toContain("config set --batch-file");
    expect(windows).toContain("windowsAgentTurnConfigPatchScript");
    expect(powershell).toContain("agents.defaults.skipBootstrap");
    expect(powershell).toContain("tools.profile");
    expect(powershell).toContain("replace(/^\\\\uFEFF/u");

    expect(npmUpdateScripts).toContain("posixAgentWorkspaceScript");
    expect(npmUpdateScripts).toContain("windowsAgentWorkspaceScript");
    expect(npmUpdateScripts).toContain("tools.profile");
    expect(npmUpdateScripts).toContain("--thinking off");
    expect(npmUpdateScripts).toContain("finalAssistant(Raw|Visible)Text");
    expect(npmUpdateScripts).toContain("posixAssertAgentOkScript");
    expect(npmUpdateScripts).toContain("windowsAgentTurnConfigPatchScript");
    expect(npmUpdateScripts).toContain("modelProviderConfigBatchJson");
    expect(npmUpdateScripts).toContain("config set --batch-file");
  });

  it("clears phase timers and applies phase deadlines to guest commands", () => {
    expect(phaseRunner).toContain("clearTimeout(timer)");
    expect(phaseRunner).toContain("remainingTimeoutMs");
    expect(transports).toContain("this.phases.remainingTimeoutMs");
    expect(parallelsVm).toContain("PRLCTL_STATUS_TIMEOUT_MS");
    expect(parallelsVm).toContain("probeTimeoutMs");
    expect(snapshots).toContain("SNAPSHOT_LIST_TIMEOUT_MS");

    for (const scriptPath of OS_TS_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("PhaseRunner");
      expect(script, scriptPath).toContain("validateSnapshotRestoreMode(this.options.mode");
      expect(script, scriptPath).toContain("remainingPhaseTimeoutMs");
      expect(script, scriptPath).toContain("timeoutMs:");
    }

    expect(macos).toContain("currentRunningSnapshotInfo(this.options.vmName)");
    expect(macos).toContain("shouldSkipSnapshotRestore()");
    expect(macos).toContain("Skip snapshot restore; using current running VM");

    expect(linux).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(windows).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(macos).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(macos).toContain("timeoutMs: this.remainingPhaseTimeoutMs(360_000)");
  });

  it("cleans POSIX guest scripts after the phase deadline is exhausted", () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-posix-cleanup-");
    const logPath = join(tempDir, "prlctl.log");
    writeNodeFakePrlctl(
      tempDir,
      `const fs = process.getBuiltinModule("node:fs"); const command = \` \${args.join(" ")} \`; fs.appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n"); if (command.includes(" dd of=/tmp/openclaw-parallels-") || command.includes(" /bin/dd of=/tmp/openclaw-parallels-")) fs.readFileSync(0); if (command.includes(" bash /tmp/openclaw-parallels-") || command.includes(" /bin/bash /tmp/openclaw-parallels-")) process.exit(1); if (command.includes(" /bin/rm -f /tmp/openclaw-parallels-")) fs.appendFileSync(${JSON.stringify(logPath)}, "cleanup\\n"); process.exit(0);`,
    );

    withEnv(fakePrlctlEnv(tempDir), () => {
      const linuxPhases = new ExhaustedCleanupPhaseRunner();
      const cleanupLinux = new LinuxGuest("Linux VM", linuxPhases as unknown as PhaseRunner);

      expect(() => cleanupLinux.bash("echo linux")).toThrow(
        "Linux guest command failed with exit code 1",
      );
      expect(linuxPhases.remainingTimeoutCalls).toBe(2);

      const macosPhases = new ExhaustedCleanupPhaseRunner();
      const cleanupMacos = createMacosGuest(macosPhases as unknown as PhaseRunner);

      expect(() => cleanupMacos.sh("echo macos")).toThrow(
        "macOS guest command failed with exit code 1",
      );
      expect(macosPhases.remainingTimeoutCalls).toBe(2);
    });

    const log = readFileSync(logPath, "utf8");
    expect(log.match(/^cleanup$/gm)).toHaveLength(2);
  });

  it("rejects Parallels macOS guest session false-success output", () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-session-unavailable-");
    writeNodeFakePrlctl(
      tempDir,
      `console.error("Unable to open new session in this virtual machine."); process.exit(0);`,
    );

    withEnv(fakePrlctlEnv(tempDir), () => {
      const phases = {
        append: () => undefined,
        remainingTimeoutMs: (fallbackMs?: number) => fallbackMs ?? 30_000,
      };
      const unavailableMacos = createMacosGuest(phases as unknown as PhaseRunner);

      expect(() => unavailableMacos.exec(["true"])).toThrow(
        "macOS guest command failed: Parallels guest session unavailable",
      );
    });
  });

  it("streams full phase logs to disk while bounding the failure tail", async () => {
    const runDir = makeTempDir(tempDirs, "openclaw-parallels-phase-");
    const logPhaseRunner = new PhaseRunner(runDir, 128);
    const writes: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await expect(
        logPhaseRunner.phase("noisy", 30, () => {
          logPhaseRunner.append(`old-${"x".repeat(256)}`);
          logPhaseRunner.append("recent failure");
          throw new Error("phase failed");
        }),
      ).rejects.toThrow("phase failed");

      const logText = readFileSync(join(runDir, "noisy.log"), "utf8");
      expect(logText).toContain("old-");
      expect(logText).toContain("recent failure");
      const stderr = writes.join("");
      expect(stderr).toContain("phase log tail truncated");
      expect(stderr).toContain("recent failure");
      expect(stderr).not.toContain(`old-${"x".repeat(200)}`);
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it("clamps oversized phase timers before scheduling", async () => {
    const runDir = makeTempDir(tempDirs, "openclaw-parallels-phase-timeout-");
    const timerPhaseRunner = new PhaseRunner(runDir, 128);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await expect(
        timerPhaseRunner.phase("oversized", MAX_TIMER_TIMEOUT_SECONDS + 1, () => undefined),
      ).resolves.toBeUndefined();
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      expect(readFileSync(join(runDir, "phase-timings.json"), "utf8")).toContain(
        `"timeoutSeconds": ${MAX_TIMER_TIMEOUT_SECONDS + 1}`,
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("runs POSIX guest shell scripts with a normal install umask", () => {
    expect(transports.match(/umask 022/g)).toHaveLength(2);
  });

  it("uses collision-resistant guest script names", () => {
    expect(transports).toContain('import { randomUUID } from "node:crypto"');
    expect(transports).toContain("guestScriptName");
    expect(transports).not.toContain("Date.now()}.sh");
    expect(transports).not.toContain("Date.now()}.ps1");
    expect(transports).not.toContain("Math.random()");
  });

  it("hardens restored macOS install lanes", () => {
    expect(macos).toContain('rm -rf "$HOME/.npm/_cacache"');
    expect(macos.match(/\.onboard-ref", 420/g)).toHaveLength(2);
    expect(macos).toContain('echo "npm install attempt $attempt failed; retrying in 5s"');
    expect(macos.match(/curl -fsSL --connect-timeout 10 --max-time 120 --retry 2/g)).toHaveLength(
      2,
    );
  });

  it("retries failed aggregate fresh lanes once from a restored snapshot", () => {
    expect(npmUpdate).toContain("retrying once from restored snapshot");
    expect(npmUpdate).toContain('attempt === 1 ? "" : `-retry-${attempt}`');
    expect(npmUpdate).toContain("failed after retry");
  });

  it("provisions portable Git before Windows dev update lanes", () => {
    const combined = `${windows}\n${windowsGit}`;

    expect(windows).toContain("prepareMinGitZip");
    expect(windows).toContain("ensureGuestGit");
    expect(windows).toContain("fresh.ensure-git");
    expect(windows).toContain("upgrade.ensure-git");
    expect(combined).toContain("MinGit-");
    expect(combined).toContain("portable-git");
    expect(combined).toContain("where.exe git.exe");
    expect(windowsGit.indexOf('"MinGit-2.55.0.4-64-bit.zip"')).toBeLessThan(
      windowsGit.indexOf('"MinGit-2.55.0.4-arm64.zip"'),
    );
    expect(
      combined.match(/curl\.exe -fsSL --connect-timeout 10 --max-time 120 --retry 2/g),
    ).toHaveLength(2);
    expect(windows).toContain("Invoke-RestMethod -Uri");
    expect(windows).toContain("-TimeoutSec 120");
    expect(windowsGit).toContain('if "-64-bit." in name:');
    expect(windowsGit).toContain('elif "-arm64." in name:');
  });

  it("preseeds dev update channel before stable-to-dev update lanes", () => {
    expect(macos).toContain('channel: "dev"');
    expect(windows).toContain("Name channel -Value 'dev'");
    expect(macos).toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1");
    expect(windows).toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS");
  });

  it("requires macOS dashboard smoke to load built assets", () => {
    expect(macos).toContain("asset_paths=");
    expect(macos).toContain("grep -E '(^|/)assets/'");
    expect(macos).toContain('curl -fsSL --connect-timeout 2 --max-time 5 "$asset_url"');
  });

  it("passes aggregate model overrides into each OS fresh lane", () => {
    expect(npmUpdate).toContain("scripts/e2e/parallels-${platform}-smoke.sh");
    expect(npmUpdate).toContain('this.formatRerun("bash", args, commandEnv)');
    expect(npmUpdate).toContain('"--model"');
    expect(npmUpdate).toContain("auth.modelId");
    expect(npmUpdate).toContain("authForPlatform");
    expect(npmUpdate).toContain("OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR");
  });

  it("keeps the Windows update config scrub compatible with PowerShell 5.1", () => {
    const script = npmUpdateScripts;

    expect(script).not.toContain("ConvertFrom-Json -AsHashtable");
    expect(script).not.toContain("ConvertTo-Json -Depth 100");
    expect(script).toContain('replace(/^\\\\uFEFF/u, "")');
    expect(script).toContain("$nodeScript | Set-Content -Path $nodeScriptPath -Encoding UTF8");
    expect(script).toContain("& node.exe $nodeScriptPath $configPath");
  });

  it("keeps aggregate update guest scripts isolated from the npm-update orchestrator", () => {
    const orchestrator = npmUpdate;
    const updateScripts = npmUpdateScripts;

    expect(orchestrator).toContain("macosUpdateScript");
    expect(orchestrator).toContain("windowsUpdateScript");
    expect(orchestrator).toContain("linuxUpdateScript");
    expect(orchestrator).toContain('import { randomUUID } from "node:crypto"');
    expect(orchestrator).not.toContain("process.pid}-${Date.now()");
    expect(orchestrator).not.toContain("Remove-FuturePluginEntries");
    expect(updateScripts).toContain("Remove-FuturePluginEntries");
    expect(updateScripts).toContain("scrub_future_plugin_entries");
    expect(updateScripts).toContain("Invoke-OpenClaw update");
    expect(updateScripts).toContain("Parallels npm update smoke test assistant.");
  });

  it("keeps macOS Discord roundtrip isolated from the lane orchestrator", () => {
    expect(macos).toContain("MacosDiscordSmoke");
    expect(macos).not.toContain("Authorization: Bot");
    expect(discord).toContain("Authorization: Bot");
    expect(discord).toContain('import { randomUUID } from "node:crypto"');
    expect(discord).not.toContain("Math.random()");
    expect(discord).toContain('"--silent"');
    expect(discord).toContain("doctor --fix --yes --non-interactive");
    expect(discord).toContain("channels status --probe --json");
    expect(discord).toContain("Stop ${this.input.vmName} after successful Discord smoke");
  });

  it("resolves macOS smoke commands from the guest PATH", () => {
    expect(macos).toContain("/usr/local/bin:/usr/local/sbin");
    expect(macos).toContain('const guestOpenClaw = "openclaw"');
    expect(macos).toContain('const guestNode = "node"');
    expect(macos).toContain('const guestNpm = "npm"');
    expect(macos).toContain("$(npm root -g)/openclaw/openclaw.mjs");
    expect(macos).toContain("guestOpenClawEntryExec");
    expect(macos).not.toContain('const guestOpenClaw = "/opt/homebrew/bin/openclaw"');
    expect(macos).not.toContain('const guestNode = "/opt/homebrew/bin/node"');
    expect(macos).not.toContain('const guestNpm = "/opt/homebrew/bin/npm"');
    expect(macos).not.toContain("/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs");
  });

  it("keeps Windows gateway reachability on a real deadline with start recovery", () => {
    expect(windows).toContain("OPENCLAW_PARALLELS_WINDOWS_GATEWAY_RECOVERY_AFTER_S");
    expect(windows).toContain("Date.now() < deadline");
    expect(windows).toContain("gateway start");
    expect(windows).toContain("gateway-reachable recovery");
  });

  it("runs Windows ref onboarding through a detached done-file runner", () => {
    expect(windows).toContain("guestPowerShellBackground");
    expect(windows).toContain("runWindowsBackgroundPowerShell");
    expect(transports).toContain("Join-Path (Join-Path $env:WINDIR 'Temp\\\\openclaw-parallels')");
    expect(transports).toContain("icacls.exe $runDir /inheritance:r");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(transports).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(transports).toContain("poll.status !== 0 && poll.status !== 124");
    expect(transports).toContain('cmd.exe /d /s /c start "" /b powershell.exe');
    expect(transports).toContain('if exist "${windowsDonePath}"');
    expect(transports).toContain('type "%WINDIR%\\\\Temp\\\\${guestRunDir}\\\\run.log"');
    expect(transports).toContain("WINDOWS_BACKGROUND_LOG_MAX_BYTES");
    expect(transports).toContain("Write-OpenClawUtf8File $pidPath ([string]$PID)");
    expect(transports).toContain('launch.stdout.includes("started")');
    expect(transports).toContain("waitForWindowsBackgroundMaterialized");
  });

  it("runs Windows package installs through the detached done-file runner", () => {
    expect(windows).toContain('guestPowerShellBackground(\n      "install-latest"');
    expect(windows).toContain("guestPowerShellBackground(\n      `install-main-${");
    expect(windows).toContain('guestPowerShellBackground(\n      "update-dev"');
    expect(windows).not.toMatch(/private installMain\(tempName: string\): void/u);
    expect(windows).not.toMatch(/private installLatestRelease\(\): void/u);
    expect(windows).not.toMatch(/private runDevChannelUpdate\(\): void/u);
    expect(windows).toContain("if (Test-Path $configPath)");
    expect(windows).toContain(
      "New-Item -ItemType Directory -Path (Split-Path $configPath -Parent) -Force",
    );
  });

  it("runs the macOS dev update through a detached done-file runner", () => {
    expect(macos).toContain('this.guest.shBackground(\n      "macos-update-dev"');
    expect(transports).toContain('spawn("/bin/bash"');
    expect(transports).toContain("detached: true");
    expect(transports).toContain("child.unref()");
    expect(transports).toContain("POSIX_BACKGROUND_LOG_MAX_BYTES");
    expect(transports).toContain('runGuest(["/bin/test", "-f", donePath]');
    expect(transports).toContain('runGuest(["/bin/cat", exitPath]');
    expect(transports).toContain('["/bin/mkdir", "-m", "700", "-p", runDir]');
    expect(transports).toContain('command=$(/bin/ps -p "$background_pid" -o command=');
    expect(transports).toContain("*${posixSingleQuote(runnerPath)}*)");
    expect(transports).not.toContain('transport(["/bin/bash", "-c"');
    expect(macos).toContain(
      'fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {}',
    );
    expect(macos).toContain("fs.mkdirSync(path.dirname(configPath), { recursive: true })");
  });

  it("accepts an ambiguous POSIX background launch after its run materializes", async () => {
    const output: string[] = [];
    const { result } = runFakePosixBackground(
      {
        exit: [fakeResult(124), fakeResult(0, "0\n")],
        launch: fakeResult(124),
        tail: () => fakeResult(0, "update complete\n"),
      },
      { append: (chunk) => output.push(String(chunk)), script: "echo update" },
    );
    await result;

    expect(output.join("")).toContain("update complete");
  });

  it("propagates a detached POSIX background exit failure", async () => {
    const { result } = runFakePosixBackground(
      { exit: [fakeResult(0, "7\n")], tail: () => fakeResult(0, "update failed\n") },
      { script: "exit 7" },
    );

    await expect(result).rejects.toThrow("macos update failed");
  });

  it("reads the POSIX background exit after log drain consumes the deadline", async () => {
    const { result, state } = runFakePosixBackground(
      {
        exit: [fakeResult(0, "0\n")],
        tail: () => {
          const until = Date.now() + 30;
          while (Date.now() < until) {
            // Simulate a completed log drain that exhausts the phase deadline.
          }
          return fakeResult(0, "update complete\n");
        },
      },
      { script: "echo update", timeoutMs: 25 },
    );
    await result;

    expect(state.exitRead).toBe(true);
  });

  it("cleans up an ambiguous POSIX launch when PID materialization is missed", async () => {
    const { result, state } = runFakePosixBackground(
      { launch: fakeResult(124), pid: fakeResult(1) },
      { script: "sleep 60", timeoutMs: 25 },
    );

    await expect(result).rejects.toThrow("macos update background launch failed");

    expect(state.cleanupRun).toBe(true);
  });

  it("force-stops the verified POSIX background process tree on timeout", async () => {
    const { result, state } = runFakePosixBackground(
      { done: fakeResult(1) },
      { script: "sleep 60", timeoutMs: 25 },
    );

    await expect(result).rejects.toThrow("macos update timed out");

    expect(state.cleanupPayload).toContain('command=$(/bin/ps -p "$background_pid" -o command=');
    expect(state.cleanupPayload).toContain('for child in $(/usr/bin/pgrep -P "$1"');
    expect(state.cleanupPayload).toContain('/bin/kill -TERM "$1"');
    expect(state.cleanupPayload).toContain('/bin/kill -KILL "$1"');
  });

  it("carries refreshed Windows guest environment into every PowerShell script", () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-windows-env-");
    const scriptsPath = join(tempDir, "scripts.jsonl");
    writeNodeFakePrlctl(
      tempDir,
      `if (args.includes("-EncodedCommand")) { const fs = process.getBuiltinModule("node:fs"); fs.appendFileSync(${JSON.stringify(scriptsPath)}, JSON.stringify(fs.readFileSync(0, "utf8")) + "\\n"); } process.exit(0);`,
    );
    let registry = "http://192.0.2.2:48123/first";
    withEnv(fakePrlctlEnv(tempDir), () => {
      const guest = new WindowsGuest("Windows VM", new PhaseRunner(tempDir), () => ({
        NPM_CONFIG_REGISTRY: registry,
      }));
      guest.powershell("Write-Output $env:NPM_CONFIG_REGISTRY");
      registry = "http://192.0.2.2:48123/second's";
      guest.powershell("Write-Output $env:NPM_CONFIG_REGISTRY");
    });

    const scripts = readFileSync(scriptsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string);
    expect(scripts).toEqual([
      "Set-Item -LiteralPath 'Env:NPM_CONFIG_REGISTRY' -Value 'http://192.0.2.2:48123/first'\nWrite-Output $env:NPM_CONFIG_REGISTRY",
      "Set-Item -LiteralPath 'Env:NPM_CONFIG_REGISTRY' -Value 'http://192.0.2.2:48123/second''s'\nWrite-Output $env:NPM_CONFIG_REGISTRY",
    ]);
  });

  it("carries Windows background environment before the detached command", async () => {
    let uploadedScript = "";
    const runCommand = (_command: string, _args: string[], options?: { input?: string }) => {
      uploadedScript = options?.input ?? "";
      return { status: 1, stderr: "fixture upload failure", stdout: "" };
    };
    await expect(
      runWindowsBackgroundPowerShell({
        env: { NPM_CONFIG_REGISTRY: "http://192.0.2.2:48123/candidate's" },
        label: "environment proof",
        runCommand,
        script: "Write-Output $env:NPM_CONFIG_REGISTRY",
        timeoutMs: 720_000,
        vmName: "Windows VM",
      }),
    ).rejects.toThrow("background script write failed");
    expect(uploadedScript).toContain(
      "Set-Item -LiteralPath 'Env:NPM_CONFIG_REGISTRY' -Value 'http://192.0.2.2:48123/candidate''s'\nWrite-Output $env:NPM_CONFIG_REGISTRY",
    );
  });

  it("paces ambiguous Windows background launch materialization probes", async () => {
    let calls = 0;
    const runCommand = vi.fn(() => {
      calls++;
      return { status: 0, stderr: "", stdout: "" };
    });

    await expect(
      runWindowsBackgroundPowerShell({
        label: "ambiguous launch",
        pollIntervalMs: 20,
        runCommand,
        script: "Write-Output ok",
        timeoutMs: 90,
        vmName: "Windows 11",
      }),
    ).rejects.toThrow("ambiguous launch background launch failed");

    expect(calls).toBeLessThan(20);
  });

  it("fails fast when a Windows Parallels VM stops during background work", async () => {
    const runCommand = vi.fn(() => ({
      status: 1,
      stderr:
        'Unable to perform the operation because "Windows 11" is not started. This operation can be performed for running virtual machines only.',
      stdout: "",
    }));

    await expect(
      runWindowsBackgroundPowerShell({
        label: "ref-onboard",
        runCommand,
        script: "Write-Output ok",
        timeoutMs: 720_000,
        vmName: "Windows 11",
      }),
    ).rejects.toThrow("ref-onboard failed: Parallels VM stopped");

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("fails boundedly when Windows background polling loses guest transport", async () => {
    const retries: string[] = [];
    let donePolls = 0;
    const runCommand = vi.fn((_command: string, args: string[], options?: { input?: string }) => {
      const command = args.at(-1) ?? "";
      if (options?.input) {
        return { status: 0, stderr: "", stdout: "" };
      }
      if (args.includes("--current-user")) {
        return { status: 0, stderr: "", stdout: "started\n" };
      }
      if (args.includes("cmd.exe") && command.includes("echo wait")) {
        donePolls++;
        return { status: 124, stderr: "", stdout: "" };
      }
      return { status: 0, stderr: "", stdout: "" };
    });

    await expect(
      runWindowsBackgroundPowerShell({
        label: "ref-onboard",
        onLaunchRetry: (message) => retries.push(message),
        pollIntervalMs: 1,
        runCommand,
        script: "Write-Output ok",
        timeoutMs: 720_000,
        vmName: "Windows 11",
      }),
    ).rejects.toThrow("ref-onboard done poll failed after 3 consecutive guest transport errors");

    expect(donePolls).toBe(3);
    expect(retries).toHaveLength(3);
    expect(retries.at(-1)).toContain("transport failure 3/3");
  });

  it("returns timed-out host command status when check is disabled", () => {
    const result = runNode("process.stdout.write('partial'); setTimeout(() => {}, 1000);", {
      check: false,
      timeoutMs: 50,
    });

    expect(result.status).toBe(124);
    expect(result.stdout).toBeTypeOf("string");
  });

  it("clamps oversized timed host command wrapper timeouts", () => {
    const result = runNode("setTimeout(() => process.exit(0), 25);", {
      check: false,
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
    });

    expect(result.status).toBe(0);
  });

  it.runIf(process.platform !== "win32")(
    "lets timed host command descendants drain before force kill",
    () => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-drain-");
      const readyFile = join(tempDir, "ready");
      const drainFile = join(tempDir, "drained");

      const result = runNode(drainableProcessTreeScript(25), {
        check: false,
        env: {
          ...process.env,
          DRAIN_FILE: drainFile,
          READY_FILE: readyFile,
        },
        timeoutMs: 250,
      });

      expect(result.status).toBe(124);
      expect(existsSync(readyFile)).toBe(true);
      expect(readFileSync(drainFile, "utf8")).toBe("drained");
    },
  );

  it.runIf(process.platform !== "win32")("throws checked timed host command timeouts", () => {
    expect(() => runNode("setInterval(() => {}, 1000);", { timeoutMs: 50 })).toThrow(
      /timed out after 50ms/u,
    );
  });

  it.runIf(process.platform !== "win32")("preserves child exit 124 in timed host commands", () => {
    const result = runNode("process.exit(124)", {
      check: false,
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(124);
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out host command process groups",
    async () => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-");
      const grandchildPidPath = join(tempDir, "grandchild.pid");
      let grandchildPid = 0;

      try {
        const result = runNode(SIGNAL_PARENT_SCRIPT, {
          check: false,
          env: {
            ...process.env,
            OPENCLAW_TEST_GRANDCHILD_PID: grandchildPidPath,
            OPENCLAW_TEST_READY_FILE: join(tempDir, "ready"),
          },
          timeoutMs: 500,
        });

        expect(result.status).toBe(124);
        grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);
        expect(Number.isInteger(grandchildPid)).toBe(true);
        await waitFor(() => !isProcessAlive(grandchildPid));
      } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "settles timed host commands when an escaped descendant retains child pipes",
    () => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-pipes-");
      const grandchildPidPath = join(tempDir, "grandchild.pid");
      let grandchildPid = 0;
      const grandchildScript = [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.env.GRANDCHILD_PID_PATH, String(process.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {`,
        "  detached: true,",
        "  env: process.env,",
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        "});",
        "child.unref();",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const startedAt = Date.now();

      try {
        const result = run(process.execPath, ["-e", parentScript], {
          check: false,
          env: {
            ...process.env,
            GRANDCHILD_PID_PATH: grandchildPidPath,
          },
          quiet: true,
          timeoutMs: 100,
        });

        expect(result.status).toBe(124);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);
        expect(Number.isInteger(grandchildPid)).toBe(true);
      } finally {
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(-grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reaps externally signaled timed host command descendants",
    async () => {
      const fixture = createSignaledHostCommandFixture(false);
      let runnerPid = 0;
      let grandchildPid = 0;

      try {
        runnerPid = fixture.runner.pid ?? 0;
        expect(runnerPid).toBeGreaterThan(0);
        await waitFor(
          () => existsSync(fixture.readyPath) && existsSync(fixture.grandchildPidPath),
          2_000,
        );
        grandchildPid = Number.parseInt(readFileSync(fixture.grandchildPidPath, "utf8"), 10);

        process.kill(-runnerPid, "SIGTERM");

        await expect(waitForProcessClose(fixture.runner, 3_000)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitFor(() => !isProcessAlive(grandchildPid), 3_000);
      } finally {
        forceKillSignaledFixture(runnerPid, grandchildPid, true);
      }
    },
  );

  it.runIf(process.platform !== "win32")("preserves timed host command spawn errors", () => {
    expect(() =>
      run("openclaw-definitely-missing-host-command", [], {
        check: false,
        quiet: true,
        timeoutMs: 50,
      }),
    ).toThrow(/ENOENT/u);
  });

  it("rejects streaming host commands when log writes fail", async () => {
    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-log-");
    await expect(
      runStreamingNode("process.stdout.write('ok')", { logPath: tempDir }),
    ).rejects.toThrow(/failed to write Parallels host command log/u);
  });

  it("clears streaming host command timers when spawn fails", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        runStreaming("openclaw-definitely-missing-host-command", [], {
          quiet: true,
          timeoutMs: 60 * 60 * 1000,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized streaming host command timeouts before arming timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        runStreamingNode("setTimeout(() => process.exit(0), 25);", {
          timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        }),
      ).resolves.toBe(0);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "lets timed streaming host command descendants drain before force kill",
    async () => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-streaming-host-command-drain-");
      const readyFile = join(tempDir, "ready");
      const drainFile = join(tempDir, "drained");
      const logPath = join(tempDir, "stream.log");

      const statusPromise = runStreamingNode(drainableProcessTreeScript(50), {
        env: {
          ...process.env,
          DRAIN_FILE: drainFile,
          READY_FILE: readyFile,
        },
        logPath,
        timeoutMs: 500,
      });

      await waitFor(() => existsSync(readyFile), 2_000);
      await expect(statusPromise).resolves.toBe(124);
      expect(readFileSync(drainFile, "utf8")).toBe("drained");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reaps externally signaled streaming host command descendants before re-raising",
    async () => {
      const fixture = createSignaledHostCommandFixture(true);
      let runnerPid = 0;
      let grandchildPid = 0;

      try {
        runnerPid = fixture.runner.pid ?? 0;
        expect(runnerPid).toBeGreaterThan(0);
        await waitFor(
          () => existsSync(fixture.readyPath) && existsSync(fixture.grandchildPidPath),
          2_000,
        );
        grandchildPid = Number.parseInt(readFileSync(fixture.grandchildPidPath, "utf8"), 10);

        fixture.runner.kill("SIGTERM");

        await expect(waitForProcessClose(fixture.runner, 3_000)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitFor(() => !isProcessAlive(grandchildPid), 3_000);
      } finally {
        forceKillSignaledFixture(runnerPid, grandchildPid, false);
      }
    },
  );

  it("streams host command logs instead of retaining them in memory", async () => {
    const runStreamingBlock = hostCommand.slice(
      hostCommand.indexOf("export async function runStreaming"),
    );
    expect(runStreamingBlock).toContain("createWriteStream");
    expect(runStreamingBlock).toContain("child.kill(signal)");
    expect(runStreamingBlock).toContain("writeLogChunk(chunk)");
    expect(runStreamingBlock).not.toContain('let log = ""');
    expect(runStreamingBlock).not.toContain("log += text");
    expect(runStreamingBlock).not.toContain("writeFile(options.logPath, log");

    const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-log-");
    const logPath = join(tempDir, "stream.log");
    const status = await runStreamingNode(
      "process.stdout.write('x'.repeat(128 * 1024)); process.stderr.write('stream-done');",
      { logPath },
    );

    expect(status).toBe(0);
    expect(statSync(logPath).size).toBeGreaterThan(128 * 1024);
    expect(readFileSync(logPath, "utf8")).toContain("stream-done");
  });

  it.runIf(process.platform !== "win32")(
    "does not treat timed command stderr as wrapper control data",
    () => {
      const result = runNode("process.stderr.write('__OPENCLAW_HOST_COMMAND_SPAWN_ERROR__{}\\n')", {
        check: false,
        timeoutMs: 500,
      });

      expect(result.status).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")("preserves timed host command output capture", () => {
    const expected = "x".repeat(256 * 1024);
    const result = runNode("process.stdout.write('x'.repeat(256 * 1024))", {
      check: false,
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.runIf(process.platform !== "win32")(
    "ignores broken stdin pipes from timed host commands that exit early",
    () => {
      const result = runNode("process.exit(0)", {
        check: false,
        input: "x".repeat(1024 * 1024),
        timeoutMs: 1_000,
      });

      expect(result.status).toBe(0);
    },
  );

  it("routes Windows host pnpm and npm shims through safe runners", () => {
    const comSpec = "C:\\Windows\\System32\\cmd.exe";

    expect(
      resolveHostCommandInvocation("pnpm", ["build"], {
        env: {
          ComSpec: comSpec,
          npm_execpath: "C:\\Tools\\pnpm.cmd",
        },
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "C:\\Tools\\pnpm.cmd build"],
      command: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    });

    const execPath = "C:\\nodejs\\node.exe";
    const npmCmdPath = win32.resolve(win32.dirname(execPath), "npm.cmd");
    expect(
      resolveHostCommandInvocation("npm", ["view", "openclaw", "version"], {
        env: { ComSpec: comSpec },
        execPath,
        existsSync: (candidate) => candidate === npmCmdPath,
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", `${npmCmdPath} view openclaw version`],
      command: comSpec,
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("wraps explicit Windows batch host commands without shell mode", () => {
    expect(
      resolveHostCommandInvocation("C:\\Tools\\helper.cmd", ["@scope/pkg@^1.0.0"], {
        comSpec: "cmd.exe",
        platform: "win32",
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "C:\\Tools\\helper.cmd @scope/pkg@^^1.0.0"],
      command: "cmd.exe",
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("ignores ambient ComSpec for Windows host batch commands", () => {
    expect(
      resolveHostCommandInvocation("C:\\Tools\\helper.cmd", ["build"], {
        env: {
          ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
          SystemRoot: "D:\\Windows",
        },
        platform: "win32",
      }).command,
    ).toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("runs the Windows agent turn through the detached done-file runner", () => {
    expect(windows).toContain('guestPowerShellBackground(\n      "agent-turn"');
    expect(windows).toContain("OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S");
    expect(windows).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S"',
    );
    expect(windows).toContain("windowsAgentTurnConfigPatchScript(this.auth.modelId)");
    expect(windows).toContain("--model");
    expect(windows).toContain('resolveParallelsModelTimeoutSeconds("windows")');
    expect(windows).toContain("finalAssistant(Raw|Visible)Text");
    expect(windows).toContain("parallels-windows-smoke-retry-$attempt");
    expect(windows).toContain("agent turn attempt $attempt failed or finished without OK response");
    expect(windows).not.toContain("$config.models.providers");
    expect(windows).not.toContain("timeoutSeconds = 300");
    expect(windows).toContain('"$sessionId.jsonl"');
  });

  it("gives GPT-5.6 Luna enough Parallels model time on slower desktop guests", () => {
    expect({
      linux: resolveParallelsModelTimeoutSeconds("linux"),
      macos: resolveParallelsModelTimeoutSeconds("macos"),
      windows: resolveParallelsModelTimeoutSeconds("windows"),
    }).toEqual({
      linux: 900,
      macos: 1800,
      windows: 1800,
    });
    expect(macos).toContain(
      'this.agentTimeoutSeconds = readPositiveIntEnv("OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S", 2700)',
    );
    expect(macos).toContain("--timeout ${this.modelTimeoutSeconds}");
    expect(linux).toContain('--timeout ${resolveParallelsModelTimeoutSeconds("linux")}');
  });

  it("rejects loose Parallels numeric limits before starting smoke lanes", () => {
    expect(
      withEnv({ OPENCLAW_PARALLELS_MODEL_TIMEOUT_S: "1200" }, () =>
        resolveParallelsModelTimeoutSeconds("linux"),
      ),
    ).toBe(1200);
    expect(
      withEnv({ OPENCLAW_PARALLELS_NUMERIC_TEST: " 42 " }, () =>
        readPositiveIntEnv("OPENCLAW_PARALLELS_NUMERIC_TEST", 7),
      ),
    ).toBe(42);
    expect(
      withEnv({ OPENCLAW_PARALLELS_DEV_TARGET_REF: ` ${"A".repeat(40)} ` }, () =>
        readGitCommitEnv("OPENCLAW_PARALLELS_DEV_TARGET_REF"),
      ),
    ).toBe("a".repeat(40));
    expect(
      withEnv({ OPENCLAW_PARALLELS_DEV_TARGET_REF: " " }, () =>
        readGitCommitEnv("OPENCLAW_PARALLELS_DEV_TARGET_REF"),
      ),
    ).toBeUndefined();

    expectFatalError(
      () =>
        withEnv({ OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: "1800s" }, () =>
          resolveParallelsModelTimeoutSeconds("macos"),
        ),
      "invalid OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: 1800s",
    );
    for (const [parseArgs, value] of [
      [parseMacosSmokeArgs, "18425x"],
      [parseLinuxSmokeArgs, "1e4"],
      [parseWindowsSmokeArgs, "0x4800"],
    ] as const) {
      expectFatalError(() => parseArgs(["--host-port", value]), `invalid --host-port: ${value}`);
    }
    for (const parseArgs of [parseMacosSmokeArgs, parseLinuxSmokeArgs, parseWindowsSmokeArgs]) {
      expectFatalError(() => parseArgs(["--host-port", "65536"]), "invalid --host-port: 65536");
    }
    for (const [name, value, fallback] of [
      ["OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S", "1e3", 1500],
      ["OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S", "2700s", 2700],
      ["OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S", "12.5", 7200],
    ] as const) {
      expectFatalError(
        () => withEnv({ [name]: value }, () => readPositiveIntEnv(name, fallback)),
        `invalid ${name}: ${value}`,
      );
    }
    expectFatalError(
      () =>
        withEnv({ OPENCLAW_PARALLELS_DEV_TARGET_REF: "main" }, () =>
          readGitCommitEnv("OPENCLAW_PARALLELS_DEV_TARGET_REF"),
        ),
      "invalid OPENCLAW_PARALLELS_DEV_TARGET_REF: expected a full 40-character commit SHA",
    );
    expectFatalError(
      () => parseNpmUpdateSmokeArgs(["--platform", "macos,macos"]),
      "duplicate --platform entry: macos",
    );

    expect(macos).toContain(
      'this.updateDevTimeoutSeconds = readPositiveIntEnv(\n      "OPENCLAW_PARALLELS_MACOS_UPDATE_DEV_TIMEOUT_S"',
    );
    expect(linux).toContain('readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S"');
    expect(windows).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S"',
    );
    expect(packageArtifact).toContain(
      'readPositiveIntEnv("OPENCLAW_PARALLELS_PACKAGE_LOCK_TIMEOUT_MS", 30 * 60_000)',
    );
    expect(npmUpdate).toContain(
      'readPositiveIntEnv("OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S", 2700)',
    );
  });

  it("waits through transient Windows restoring state before VM operations", () => {
    expect(windows).toContain("waitForVmNotRestoring");
    expect(windows).toContain("snapshot-switch retry");
    expect(transports).toContain("launch retry");
  });

  it("preserves bundled plugin inventory during dev updates", () => {
    const devUpdateLines = [macos, windows].map((script) =>
      script.split("\n").find((line) => line.includes("update --channel dev")),
    );

    expect(devUpdateLines).not.toContain(undefined);
    for (const updateLine of devUpdateLines) {
      expect(updateLine).not.toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
    }
    expect(powershell).toContain("windowsScopedEnvFunction");
    expect(windows).toContain(
      "Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
    expect(windows).toContain("$script:OpenClawUpdateExit = $LASTEXITCODE");
    expect(windows).not.toContain("$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'");
    for (const script of [macos, windows]) {
      expect(script).toContain('readGitCommitEnv("OPENCLAW_PARALLELS_DEV_TARGET_REF")');
      expect(script).toContain("OPENCLAW_UPDATE_DEV_TARGET_REF");
      expect(script).toContain('const expectedBranch = this.devTargetCommit ? "HEAD" : "main"');
      expect(script).toContain("dev update checkout head");
    }
    expect(macos).toContain("OPENCLAW_UPDATE_DEV_TARGET_REF=${shellQuote(this.devTargetCommit)}");
    expect(windows).toContain(
      "OPENCLAW_UPDATE_DEV_TARGET_REF = ${psSingleQuote(this.devTargetCommit)}",
    );
  });

  it("keeps Parallels dev updates on the test-owned gateway lifecycle", () => {
    expect(macos).toContain(
      "update --channel dev --yes --json --no-restart --timeout ${this.updateDevTimeoutSeconds}",
    );
    expect(windows).toContain(
      "update --channel dev --yes --json --no-restart --timeout ${this.updateTimeoutSeconds}",
    );
    expect(macos).toContain("--install-daemon");
    expect(windows).toContain("--install-daemon");
  });

  it("writes Parallels phase timing artifacts", () => {
    expect(phaseRunner).toContain("phase-timings.json");
    expect(phaseRunner).toContain("slowest");
    expect(npmUpdate).toContain("timings: this.timings");
    expect(npmUpdate).toContain("recordTiming");
  });

  it("resolves Windows OpenClaw commands without assuming the npm shim path", () => {
    expect(powershell).toContain("windowsOpenClawResolver");
    expect(powershell).toContain("OPENCLAW_PARALLELS_AGENT_RUNTIME_POLICY_SUPPORTED");
    expect(powershell).toContain("Programs\\nodejs");
    expect(powershell).toContain('selectedModelEntry.agentRuntime = { id: "openclaw" }');
    expect(powershell).toContain("delete selectedModelEntry.agentRuntime");
    expect(powershell).toContain("delete providerEntry.agentRuntime");
    expect(powershell).toContain("Resolve-OpenClawCommand");
    expect(powershell).toContain("npm\\node_modules\\openclaw\\openclaw.mjs");
    expect(powershell).toContain("$ErrorActionPreference = 'Continue'");
    expect(powershell).toContain("$PSNativeCommandUseErrorActionPreference = $false");
    expect(windows).toContain("windowsOpenClawResolver");
    expect(windows).toContain("Invoke-OpenClaw gateway");
    expect(windows).not.toContain("Join-Path $env:APPDATA 'npm\\\\openclaw.cmd'");
  });
});
