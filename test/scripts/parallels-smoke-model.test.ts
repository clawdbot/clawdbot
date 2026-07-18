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
  rmSync,
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

function expectFatalError(run: () => unknown, message: string): void {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
  try {
    expect(run).toThrow("process.exit(1)");
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

describe("Parallels smoke model selection", () => {
  it("parses macOS dscl user homes with spaces on mounted volumes", () => {
    expect(parseMacosDsclUserHomeLine("clawuser /Volumes/Macintosh HD/Users/clawuser")).toEqual({
      user: "clawuser",
      home: "/Volumes/Macintosh HD/Users/clawuser",
    });
    expect(isLikelyMacosDesktopHome("/Volumes/Macintosh HD/Users/clawuser")).toBe(true);
    expect(isLikelyMacosDesktopHome("/var/empty")).toBe(false);
  });

  it("extracts the last OpenClaw version from a bounded log tail", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-log-tail-"));
    const logPath = join(tempDir, "phase.log");
    try {
      writeFileSync(logPath, ["OpenClaw 0.0.1", "x".repeat(4096), "OpenClaw 2026.6.7"].join("\n"));

      await expect(extractLastOpenClawVersionFromLog(logPath, undefined, 128)).resolves.toBe(
        "2026.6.7",
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
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
    expect(controller).toContain("OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY");
    expect(controller).not.toContain("openclaw-windows-node");
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
        `OPENCLAW_PARALLELS_WINDOWS_LIBRARY_ONLY=1 source "$1"
curl() {
  count="$(<"$CURL_CALL_COUNT")"
  count=$((count + 1))
  printf '%s\\n' "$count" >"$CURL_CALL_COUNT"
  if [[ "$count" == "1" ]]; then
    printf 'partial-'
    return 28
  fi
  printf 'complete'
}
sleep() { :; }
fetch_host_metadata "https://example.test/metadata"`,
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

  it("keeps provider auth and model defaults in the shared TypeScript helper", () => {
    const providerAuth = readFileSync(TS_PATHS.providerAuth, "utf8");

    expect(providerAuth).toContain("OPENCLAW_PARALLELS_OPENAI_MODEL");
    expect(providerAuth).toContain("OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL");
    expect(providerAuth).toContain("openai/gpt-5.6-luna");
    expect(providerAuth).toContain('authChoice: "openai-api-key"');
    expect(providerAuth).toContain('authChoice: "apiKey"');
    expect(providerAuth).toContain('authChoice: "minimax-global-api"');

    for (const scriptPath of [...OS_TS_PATHS, TS_PATHS.npmUpdate]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toMatch(/resolve(?:Windows)?ProviderAuth/u);
      expect(script, scriptPath).toContain("--model <provider/model>");
      expect(script, scriptPath).toContain("modelId");
    }
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
    const common = readFileSync(TS_PATHS.common, "utf8");
    const hostCommand = readFileSync(TS_PATHS.hostCommand, "utf8");
    const hostServer = readFileSync(TS_PATHS.hostServer, "utf8");
    const laneRunner = readFileSync(TS_PATHS.laneRunner, "utf8");
    const packageArtifact = readFileSync(TS_PATHS.packageArtifact, "utf8");
    const parallelsVm = readFileSync(TS_PATHS.parallelsVm, "utf8");
    const snapshots = readFileSync(TS_PATHS.snapshots, "utf8");
    const smokeCommon = readFileSync(TS_PATHS.smokeCommon, "utf8");

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
    const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-parallels-version-"));
    let userConfigPath = "";
    try {
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
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "reports only the bounded host artifact server stderr tail",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-server-"));
      const fakePython = join(tempDir, "python3");
      writeFileSync(
        fakePython,
        `#!/usr/bin/env bash
set -euo pipefail
printf 'BEGIN_MARKER\\n' >&2
head -c 50000 </dev/zero | tr '\\0' x >&2
printf '\\nTAIL_MARKER\\n' >&2
head -c 30000 </dev/zero | tr '\\0' x >&2
exit 42
`,
      );
      chmodSync(fakePython, 0o755);

      try {
        const port = await unusedLoopbackPort();
        const result = spawnNodeEvalSync(
          `import { startHostServer } from "./${TS_PATHS.hostServer}"; await startHostServer({ dir: ".", hostIp: "127.0.0.1", port: ${port}, artifactPath: "artifact.tgz", label: "artifact" });`,
          {
            env: {
              ...process.env,
              PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
            },
            imports: ["tsx"],
            maxBuffer: 1024 * 1024,
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("host artifact server exited early");
        expect(result.stderr).toContain("TAIL_MARKER");
        expect(result.stderr).not.toContain("BEGIN_MARKER");
        expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThan(90 * 1024);
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports signaled host artifact server startup exits immediately",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-server-signal-"));
      const fakePython = join(tempDir, "python3");
      writeFileSync(
        fakePython,
        `#!/usr/bin/env bash
kill -TERM "$$"
`,
      );
      chmodSync(fakePython, 0o755);

      try {
        const port = await unusedLoopbackPort();
        const result = spawnNodeEvalSync(
          `import { startHostServer } from "./${TS_PATHS.hostServer}"; await startHostServer({ dir: ".", hostIp: "127.0.0.1", port: ${port}, artifactPath: "artifact.tgz", label: "artifact" });`,
          {
            env: {
              ...process.env,
              PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
            },
            imports: ["tsx"],
            maxBuffer: 1024 * 1024,
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("host artifact server exited early: signal SIGTERM");
        expect(result.stderr).not.toContain("did not start");
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("quotes shell args and resolves fuzzy snapshot hints through the shared TypeScript helper", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-helper-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "snapshot-list" ]]; then
  cat <<'JSON'
{
  "{older}": {"name": "fresh", "state": "running"},
  "{wanted}": {"name": "fresh-poweroff-2026-04-01", "state": "poweroff"},
  "{other}": {"name": "unrelated", "state": "poweroff"}
}
JSON
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("snapshot-list"))) {
    console.log(JSON.stringify({
      "{older}": { name: "fresh", state: "running" },
      "{wanted}": { name: "fresh-poweroff-2026-04-01", state: "poweroff" },
      "{other}": { name: "unrelated", state: "poweroff" },
    }));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => {
        const snapshot = resolveSnapshot("vm", "fresh");
        return `${shellQuote("it's ok")}\n${[snapshot.id, snapshot.state, snapshot.name].join("\t")}`;
      });

      expect(output.split("\n")[0]).toBe("'it'\"'\"'s ok'");
      expect(output).toContain("{wanted}\tpoweroff\tfresh-poweroff-2026-04-01");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("resolves a latest snapshot hint to the matching version before older LATEST labels", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-snapshot-latest-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "snapshot-list" ]]; then
  cat <<'JSON'
{
  "{old}": {"name": "macOS 26.3.1 LATEST", "state": "poweron"},
  "{wanted}": {"name": "macOS 26.5", "state": "poweron"}
}
JSON
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("snapshot-list"))) {
    console.log(JSON.stringify({
      "{old}": { name: "macOS 26.3.1 LATEST", state: "poweron" },
      "{wanted}": { name: "macOS 26.5", state: "poweron" },
    }));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => {
        const snapshot = resolveSnapshot("vm", "macOS 26.5 latest");
        return [snapshot.id, snapshot.state, snapshot.name].join("\t");
      });

      expect(output).toBe("{wanted}\tpoweron\tmacOS 26.5");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

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
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-vm-helper-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  cat <<'JSON'
[
  {"name": "Ubuntu 9007199254740993.04"},
  {"name": "Ubuntu 26.04"},
  {"name": "Ubuntu 25.10"},
  {"name": "Ubuntu 23.10"},
  {"name": "Ubuntu 24.04.3 ARM64"}
]
JSON
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("list"))) {
    console.log(JSON.stringify([
      { name: "Ubuntu 9007199254740993.04" },
      { name: "Ubuntu 26.04" },
      { name: "Ubuntu 25.10" },
      { name: "Ubuntu 23.10" },
      { name: "Ubuntu 24.04.3 ARM64" },
    ]));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => resolveUbuntuVmName("Ubuntu missing"));

      expect(output).toBe("Ubuntu 26.04");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("skips unsafe Ubuntu version names in fallback resolver", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-vm-helper-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  cat <<'JSON'
[
  {"name": "Ubuntu 9007199254740993.04"},
  {"name": "Ubuntu 23.10"}
]
JSON
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("list"))) {
    console.log(JSON.stringify([
      { name: "Ubuntu 9007199254740993.04" },
      { name: "Ubuntu 23.10" },
    ]));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => resolveUbuntuVmName("Ubuntu missing"));

      expect(output).toBe("Ubuntu 23.10");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses the only macOS VM when the default name is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-macos-vm-helper-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  printf '[{"name":"Windows 11"},{"name":"macOS"}]\n'
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("list"))) {
    console.log(JSON.stringify([{ name: "Windows 11" }, { name: "macOS" }]));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const output = withEnv(fakePrlctlEnv(tempDir), () => resolveMacosVmName("macOS Tahoe"));

      expect(output).toBe("macOS");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("does not infer destructive macOS smoke targets from arbitrary names", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-macos-vm-guard-"));
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list" ]]; then
  printf '[{"name":"macOS Work"}]\n'
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  if (process.argv.some((arg) => arg.includes("list"))) {
    console.log(JSON.stringify([{ name: "macOS Work" }]));
    process.exit(0);
  }
  process.exit(1);
}
`,
    );

    try {
      const result = spawnNodeEvalSync(
        `const { resolveMacosVmName } = await import("./${TS_PATHS.parallelsVm}"); resolveMacosVmName("macOS Tahoe");`,
        { env: { ...process.env, ...fakePrlctlEnv(tempDir) }, imports: ["tsx"] },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("select a macOS VM explicitly");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("resumes suspended Parallels VMs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-vm-resume-"));
    const statePath = join(tempDir, "state");
    writeFileSync(statePath, "suspended");
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
state_path="${statePath}"
if [[ "$1" == "list" ]]; then
  printf '[{"name":"Suspended VM","status":"%s"}]\n' "$(cat "$state_path")"
  exit 0
fi
if [[ "$1" == "resume" && "$2" == "Suspended VM" ]]; then
  printf 'running' >"$state_path"
  exit 0
fi
exit 1
`,
      `import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  const args = process.argv.slice(1);
  if (args.includes("list")) {
    console.log(JSON.stringify([{ name: "Suspended VM", status: readFileSync(${JSON.stringify(statePath)}, "utf8") }]));
    process.exit(0);
  }
  if (args.includes("resume")) {
    writeFileSync(${JSON.stringify(statePath)}, "running");
    process.exit(0);
  }
  process.exit(1);
}
`,
    );
    const sleepPath = join(tempDir, "sleep");
    writeFileSync(sleepPath, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(sleepPath, 0o755);

    try {
      withEnv(fakePrlctlEnv(tempDir), () => ensureVmRunning("Suspended VM"));
      expect(readFileSync(statePath, "utf8")).toBe("running");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("waits for apt locks during Linux snapshot bootstrap", () => {
    const script = readFileSync(TS_PATHS.linux, "utf8");

    expect(script).toContain("APT_LOCK_RETRY_SECONDS = 900");
    expect(script).toContain("BOOTSTRAP_TIMEOUT_SECONDS = 1200");
    expect(script).toContain("command -v wget");
    expect(script).toContain("run_apt_with_lock_retry");
    expect(script).toContain('"Could not get lock"');
    expect(script).toContain('"Unable to acquire the dpkg frontend lock"');
    expect(script).toContain('"Unable to lock directory"');
    expect(script).toContain("downloadGuestFile");
    expect(script).toContain("this.downloadGuestFile(tgzUrl");
    expect(script).toContain("curl -fsSL --connect-timeout 10 --max-time 120 --retry 2");
    expect(script).toContain("wget -q --timeout=10 --read-timeout=120 --tries=3");
  });

  it("keeps Linux bad-plugin diagnostics gated for historical update baselines", () => {
    const script = readFileSync(TS_PATHS.linux, "utf8");

    expect(script).toContain('BAD_PLUGIN_DIAGNOSTIC_MIN_VERSION = "2026.5.7"');
    expect(script).toContain("parseOpenClawPackageVersion");
    expect(script).toContain("maybeInjectBadPluginFixture");
    expect(script).toContain("maybeVerifyBadPluginDiagnostic");
    expect(script).toContain("Skipping bad plugin diagnostic fixture");
    expect(script).toContain("Skipping bad plugin diagnostic assertion");
  });

  it("resolves provider defaults and explicit model overrides", () => {
    expect(
      withEnv({ OPENAI_API_KEY: "sk-openai" }, () =>
        resolveProviderAuthDirect({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/gpt-5.6-luna",
    });

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
    });
  });

  it("uses the shared GPT-5.6 Luna model for Windows smoke unless overridden", () => {
    expect(
      withEnv({ OPENAI_API_KEY: "sk-openai" }, () =>
        resolveWindowsProviderAuth({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/gpt-5.6-luna",
    });

    expect(
      withEnv(
        {
          OPENAI_API_KEY: "sk-openai",
          OPENCLAW_PARALLELS_WINDOWS_OPENAI_MODEL: "openai/custom-windows",
        },
        () => resolveWindowsProviderAuth({ provider: "openai" }),
      ),
    ).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "sk-openai",
      authChoice: "openai-api-key",
      authKeyFlag: "openai-api-key",
      modelId: "openai/custom-windows",
    });
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
    const workspace = readFileSync(TS_PATHS.agentWorkspace, "utf8");

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
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain("modelProviderConfigBatchJson");
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain("config set --batch-file");
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain("modelProviderConfigBatchJson");
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain("config set --batch-file");
    expect(readFileSync(TS_PATHS.windows, "utf8")).toContain("windowsAgentTurnConfigPatchScript");
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");
    expect(powershell).toContain("agents.defaults.skipBootstrap");
    expect(powershell).toContain("tools.profile");
    expect(powershell).toContain("replace(/^\\\\uFEFF/u");

    const npmUpdateScripts = readFileSync(TS_PATHS.npmUpdateScripts, "utf8");
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
    const phaseRunner = readFileSync(TS_PATHS.phaseRunner, "utf8");
    const guestTransports = readFileSync(TS_PATHS.guestTransports, "utf8");
    const parallelsVm = readFileSync(TS_PATHS.parallelsVm, "utf8");
    const snapshots = readFileSync(TS_PATHS.snapshots, "utf8");

    expect(phaseRunner).toContain("clearTimeout(timer)");
    expect(phaseRunner).toContain("remainingTimeoutMs");
    expect(guestTransports).toContain("this.phases.remainingTimeoutMs");
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

    const macos = readFileSync(TS_PATHS.macos, "utf8");
    expect(macos).toContain("currentRunningSnapshotInfo(this.options.vmName)");
    expect(macos).toContain("shouldSkipSnapshotRestore()");
    expect(macos).toContain("Skip snapshot restore; using current running VM");

    const linux = readFileSync(TS_PATHS.linux, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");
    expect(linux).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(windows).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(macos).toContain("probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000)");
    expect(macos).toContain("timeoutMs: this.remainingPhaseTimeoutMs(360_000)");
  });

  it("cleans POSIX guest scripts after the phase deadline is exhausted", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-posix-cleanup-"));
    const logPath = join(tempDir, "prlctl.log");
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
set -euo pipefail
log_path=${JSON.stringify(logPath)}
printf '%s\\n' "$*" >>"$log_path"
args=" $* "
if [[ "$args" == *" dd of=/tmp/openclaw-parallels-"* || "$args" == *" /bin/dd of=/tmp/openclaw-parallels-"* ]]; then
  cat >/dev/null
  exit 0
fi
if [[ "$args" == *" bash /tmp/openclaw-parallels-"* || "$args" == *" /bin/bash /tmp/openclaw-parallels-"* ]]; then
  exit 1
fi
if [[ "$args" == *" /bin/rm -f /tmp/openclaw-parallels-"* ]]; then
  printf 'cleanup\\n' >>"$log_path"
  exit 0
fi
exit 0
`,
      `import { basename } from "node:path";
const isPrlctl = [process.argv0, process.execPath].some((value) =>
  basename(value).toLowerCase() === "prlctl.exe",
);
if (isPrlctl) {
  process.exit(1);
}
`,
    );

    try {
      withEnv(fakePrlctlEnv(tempDir), () => {
        const linuxPhases = new ExhaustedCleanupPhaseRunner();
        const linux = new LinuxGuest("Linux VM", linuxPhases as unknown as PhaseRunner);

        expect(() => linux.bash("echo linux")).toThrow(
          "Linux guest command failed with exit code 1",
        );
        expect(linuxPhases.remainingTimeoutCalls).toBe(2);

        const macosPhases = new ExhaustedCleanupPhaseRunner();
        const macos = new MacosGuest(
          {
            getTransport: () => "current-user",
            getUser: () => "runner",
            path: "/usr/bin:/bin",
            resolveDesktopHome: () => "/Users/runner",
            vmName: "macOS VM",
          },
          macosPhases as unknown as PhaseRunner,
        );

        expect(() => macos.sh("echo macos")).toThrow("macOS guest command failed with exit code 1");
        expect(macosPhases.remainingTimeoutCalls).toBe(2);
      });

      const log = readFileSync(logPath, "utf8");
      expect(log.match(/^cleanup$/gm)).toHaveLength(2);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects Parallels macOS guest session false-success output", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-session-unavailable-"));
    tempDirs.push(tempDir);
    writeFakePrlctl(
      tempDir,
      `#!/usr/bin/env bash
printf '%s\n' 'Unable to open new session in this virtual machine.' >&2
exit 0
`,
      "",
    );

    withEnv(fakePrlctlEnv(tempDir), () => {
      const phases = {
        append: () => undefined,
        remainingTimeoutMs: (fallbackMs?: number) => fallbackMs ?? 30_000,
      };
      const macos = new MacosGuest(
        {
          getTransport: () => "current-user",
          getUser: () => "runner",
          path: "/usr/bin:/bin",
          resolveDesktopHome: () => "/Users/runner",
          vmName: "macOS VM",
        },
        phases as unknown as PhaseRunner,
      );

      expect(() => macos.exec(["true"])).toThrow(
        "macOS guest command failed: Parallels guest session unavailable",
      );
    });
  });

  it("streams full phase logs to disk while bounding the failure tail", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-phase-"));
    const phaseRunner = new PhaseRunner(runDir, 128);
    const writes: string[] = [];
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await expect(
        phaseRunner.phase("noisy", 30, () => {
          phaseRunner.append(`old-${"x".repeat(256)}`);
          phaseRunner.append("recent failure");
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
      rmSync(runDir, { force: true, recursive: true });
    }
  });

  it("clamps oversized phase timers before scheduling", async () => {
    const runDir = makeTempDir(tempDirs, "openclaw-parallels-phase-timeout-");
    const phaseRunner = new PhaseRunner(runDir, 128);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      await expect(
        phaseRunner.phase("oversized", MAX_TIMER_TIMEOUT_SECONDS + 1, () => undefined),
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
    const guestTransports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(guestTransports.match(/umask 022/g)).toHaveLength(2);
  });

  it("uses collision-resistant guest script names", () => {
    const guestTransports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(guestTransports).toContain('import { randomUUID } from "node:crypto"');
    expect(guestTransports).toContain("guestScriptName");
    expect(guestTransports).not.toContain("Date.now()}.sh");
    expect(guestTransports).not.toContain("Date.now()}.ps1");
    expect(guestTransports).not.toContain("Math.random()");
  });

  it("hardens restored macOS install lanes", () => {
    const macos = readFileSync(TS_PATHS.macos, "utf8");

    expect(macos).toContain('rm -rf "$HOME/.npm/_cacache"');
    expect(macos.match(/\.onboard-ref", 420/g)).toHaveLength(2);
    expect(macos).toContain('echo "npm install attempt $attempt failed; retrying in 5s"');
    expect(macos.match(/curl -fsSL --connect-timeout 10 --max-time 120 --retry 2/g)).toHaveLength(
      2,
    );
  });

  it("retries failed aggregate fresh lanes once from a restored snapshot", () => {
    const script = readFileSync(TS_PATHS.npmUpdate, "utf8");

    expect(script).toContain("retrying once from restored snapshot");
    expect(script).toContain('attempt === 1 ? "" : `-retry-${attempt}`');
    expect(script).toContain("failed after retry");
  });

  it("provisions portable Git before Windows dev update lanes", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");
    const windowsGit = readFileSync(TS_PATHS.windowsGit, "utf8");
    const combined = `${script}\n${windowsGit}`;

    expect(script).toContain("prepareMinGitZip");
    expect(script).toContain("ensureGuestGit");
    expect(script).toContain("fresh.ensure-git");
    expect(script).toContain("upgrade.ensure-git");
    expect(combined).toContain("MinGit-");
    expect(combined).toContain("portable-git");
    expect(combined).toContain("where.exe git.exe");
    expect(windowsGit.indexOf('"MinGit-2.53.0.2-64-bit.zip"')).toBeLessThan(
      windowsGit.indexOf('"MinGit-2.53.0.2-arm64.zip"'),
    );
    expect(
      combined.match(/curl\.exe -fsSL --connect-timeout 10 --max-time 120 --retry 2/g),
    ).toHaveLength(2);
    expect(script).toContain("Invoke-RestMethod -Uri");
    expect(script).toContain("-TimeoutSec 120");
    expect(windowsGit).toContain('if "-64-bit." in name:');
    expect(windowsGit).toContain('elif "-arm64." in name:');
  });

  it("preseeds dev update channel before stable-to-dev update lanes", () => {
    const macos = readFileSync(TS_PATHS.macos, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");

    expect(macos).toContain('channel: "dev"');
    expect(windows).toContain("Name channel -Value 'dev'");
    expect(macos).toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1");
    expect(windows).toContain("OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS");
  });

  it("requires macOS dashboard smoke to load built assets", () => {
    const macos = readFileSync(TS_PATHS.macos, "utf8");

    expect(macos).toContain("asset_paths=");
    expect(macos).toContain("grep -E '(^|/)assets/'");
    expect(macos).toContain('curl -fsSL --connect-timeout 2 --max-time 5 "$asset_url"');
  });

  it("passes aggregate model overrides into each OS fresh lane", () => {
    const script = readFileSync(TS_PATHS.npmUpdate, "utf8");

    expect(script).toContain("scripts/e2e/parallels-${platform}-smoke.sh");
    expect(script).toContain('this.formatRerun("bash", args, env)');
    expect(script).toContain('"--model"');
    expect(script).toContain("auth.modelId");
    expect(script).toContain("authForPlatform");
    expect(script).toContain("OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR");
  });

  it("keeps the Windows update config scrub compatible with PowerShell 5.1", () => {
    const script = readFileSync(TS_PATHS.npmUpdateScripts, "utf8");

    expect(script).not.toContain("ConvertFrom-Json -AsHashtable");
    expect(script).not.toContain("ConvertTo-Json -Depth 100");
    expect(script).toContain('replace(/^\\\\uFEFF/u, "")');
    expect(script).toContain("$nodeScript | Set-Content -Path $nodeScriptPath -Encoding UTF8");
    expect(script).toContain("& node.exe $nodeScriptPath $configPath");
  });

  it("keeps aggregate update guest scripts isolated from the npm-update orchestrator", () => {
    const orchestrator = readFileSync(TS_PATHS.npmUpdate, "utf8");
    const updateScripts = readFileSync(TS_PATHS.npmUpdateScripts, "utf8");

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
    const macos = readFileSync(TS_PATHS.macos, "utf8");
    const discord = readFileSync(TS_PATHS.macosDiscord, "utf8");

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
    const macos = readFileSync(TS_PATHS.macos, "utf8");

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
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain("OPENCLAW_PARALLELS_WINDOWS_GATEWAY_RECOVERY_AFTER_S");
    expect(script).toContain("Date.now() < deadline");
    expect(script).toContain("gateway start");
    expect(script).toContain("gateway-reachable recovery");
  });

  it("runs Windows ref onboarding through a detached done-file runner", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");
    const transports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(script).toContain("guestPowerShellBackground");
    expect(script).toContain("runWindowsBackgroundPowerShell");
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
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain('guestPowerShellBackground(\n      "install-latest"');
    expect(script).toContain("guestPowerShellBackground(\n      `install-main-${");
    expect(script).not.toMatch(/private installMain\(tempName: string\): void/u);
    expect(script).not.toMatch(/private installLatestRelease\(\): void/u);
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

  it("returns timed-out host command status when check is disabled", () => {
    const result = run(
      process.execPath,
      ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 1000);"],
      {
        check: false,
        quiet: true,
        timeoutMs: 50,
      },
    );

    expect(result.status).toBe(124);
    expect(result.stdout).toBeTypeOf("string");
  });

  it("clamps oversized timed host command wrapper timeouts", () => {
    const result = run(process.execPath, ["-e", "setTimeout(() => process.exit(0), 25);"], {
      check: false,
      quiet: true,
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
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        "    writeFileSync(process.env.DRAIN_FILE, 'drained');",
        "    process.exit(0);",
        "  }, 25);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { env: process.env, stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      try {
        const result = run(process.execPath, ["-e", parentScript], {
          check: false,
          env: {
            ...process.env,
            DRAIN_FILE: drainFile,
            READY_FILE: readyFile,
          },
          quiet: true,
          timeoutMs: 250,
        });

        expect(result.status).toBe(124);
        expect(existsSync(readyFile)).toBe(true);
        expect(readFileSync(drainFile, "utf8")).toBe("drained");
      } finally {
        cleanupTempDirs(tempDirs);
      }
    },
  );

  it.runIf(process.platform !== "win32")("throws checked timed host command timeouts", () => {
    expect(() =>
      run(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        quiet: true,
        timeoutMs: 50,
      }),
    ).toThrow(/timed out after 50ms/u);
  });

  it.runIf(process.platform !== "win32")("preserves child exit 124 in timed host commands", () => {
    const result = run(process.execPath, ["-e", "process.exit(124)"], {
      check: false,
      quiet: true,
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(124);
  });

  it.runIf(process.platform !== "win32")(
    "kills timed-out host command process groups",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-command-"));
      const scriptPath = join(tempDir, "spawn-grandchild.mjs");
      const grandchildPidPath = join(tempDir, "grandchild.pid");
      let grandchildPid = 0;
      writeFileSync(
        scriptPath,
        `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "inherit" });
writeFileSync(process.argv[2], String(grandchild.pid));
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      try {
        const result = run(process.execPath, [scriptPath, grandchildPidPath], {
          check: false,
          quiet: true,
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
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reaps externally signaled timed host command descendants",
    async () => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-host-command-signal-");
      const runnerPath = join(tempDir, "runner.mjs");
      const readyPath = join(tempDir, "ready");
      const grandchildPidPath = join(tempDir, "grandchild.pid");
      const hostCommandUrl = pathToFileURL(join(process.cwd(), TS_PATHS.hostCommand)).href;
      let runnerPid = 0;
      let grandchildPid = 0;

      try {
        const grandchildScript = [
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.OPENCLAW_TEST_GRANDCHILD_PID, String(process.pid));",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { env: process.env, stdio: 'ignore' });`,
          "writeFileSync(process.env.OPENCLAW_TEST_READY_FILE, 'ready');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        writeFileSync(
          runnerPath,
          [
            `import { run } from ${JSON.stringify(hostCommandUrl)};`,
            `run(process.execPath, ['-e', ${JSON.stringify(parentScript)}], {`,
            "  check: false,",
            "  env: {",
            "    ...process.env,",
            `    OPENCLAW_TEST_GRANDCHILD_PID: ${JSON.stringify(grandchildPidPath)},`,
            `    OPENCLAW_TEST_READY_FILE: ${JSON.stringify(readyPath)},`,
            "  },",
            "  quiet: true,",
            "  timeoutMs: 30_000,",
            "});",
          ].join("\n"),
          "utf8",
        );

        const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
        });
        runnerPid = runner.pid ?? 0;
        expect(runnerPid).toBeGreaterThan(0);
        await waitFor(() => existsSync(readyPath) && existsSync(grandchildPidPath), 2_000);
        grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);

        process.kill(-runnerPid, "SIGTERM");

        await expect(waitForProcessClose(runner, 3_000)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitFor(() => !isProcessAlive(grandchildPid), 3_000);
      } finally {
        if (runnerPid && isProcessAlive(runnerPid)) {
          process.kill(-runnerPid, "SIGKILL");
        }
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
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
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-command-log-"));
    try {
      await expect(
        runStreaming(process.execPath, ["-e", "process.stdout.write('ok')"], {
          logPath: tempDir,
          quiet: true,
        }),
      ).rejects.toThrow(/failed to write Parallels host command log/u);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
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
        runStreaming(process.execPath, ["-e", "setTimeout(() => process.exit(0), 25);"], {
          quiet: true,
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
      const descendantScript = [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync(process.env.READY_FILE, 'ready');",
        "process.on('SIGTERM', () => {",
        "  setTimeout(() => {",
        "    writeFileSync(process.env.DRAIN_FILE, 'drained');",
        "    process.exit(0);",
        "  }, 50);",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { env: process.env, stdio: 'ignore' });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      try {
        const statusPromise = runStreaming(process.execPath, ["-e", parentScript], {
          env: {
            ...process.env,
            DRAIN_FILE: drainFile,
            READY_FILE: readyFile,
          },
          logPath,
          quiet: true,
          timeoutMs: 500,
        });

        await waitFor(() => existsSync(readyFile), 2_000);
        await expect(statusPromise).resolves.toBe(124);
        expect(readFileSync(drainFile, "utf8")).toBe("drained");
      } finally {
        cleanupTempDirs(tempDirs);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reaps externally signaled streaming host command descendants before re-raising",
    async () => {
      const tempDir = makeTempDir(tempDirs, "openclaw-parallels-streaming-host-command-signal-");
      const runnerPath = join(tempDir, "runner.mjs");
      const readyPath = join(tempDir, "ready");
      const grandchildPidPath = join(tempDir, "grandchild.pid");
      const logPath = join(tempDir, "stream.log");
      const hostCommandUrl = pathToFileURL(join(process.cwd(), TS_PATHS.hostCommand)).href;
      let runnerPid = 0;
      let grandchildPid = 0;

      try {
        const grandchildScript = [
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.OPENCLAW_TEST_GRANDCHILD_PID, String(process.pid));",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { env: process.env, stdio: 'ignore' });`,
          "writeFileSync(process.env.OPENCLAW_TEST_READY_FILE, 'ready');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n");
        writeFileSync(
          runnerPath,
          [
            `import { runStreaming } from ${JSON.stringify(hostCommandUrl)};`,
            `await runStreaming(process.execPath, ['-e', ${JSON.stringify(parentScript)}], {`,
            "  env: {",
            "    ...process.env,",
            `    OPENCLAW_TEST_GRANDCHILD_PID: ${JSON.stringify(grandchildPidPath)},`,
            `    OPENCLAW_TEST_READY_FILE: ${JSON.stringify(readyPath)},`,
            "  },",
            `  logPath: ${JSON.stringify(logPath)},`,
            "  quiet: true,",
            "  timeoutMs: 30_000,",
            "});",
          ].join("\n"),
          "utf8",
        );

        const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
          cwd: process.cwd(),
          stdio: "ignore",
        });
        runnerPid = runner.pid ?? 0;
        expect(runnerPid).toBeGreaterThan(0);
        await waitFor(() => existsSync(readyPath) && existsSync(grandchildPidPath), 2_000);
        grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);

        runner.kill("SIGTERM");

        await expect(waitForProcessClose(runner, 3_000)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitFor(() => !isProcessAlive(grandchildPid), 3_000);
      } finally {
        if (runnerPid && isProcessAlive(runnerPid)) {
          process.kill(runnerPid, "SIGKILL");
        }
        if (grandchildPid && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it("streams host command logs instead of retaining them in memory", async () => {
    const source = readFileSync(TS_PATHS.hostCommand, "utf8");
    const runStreamingBlock = source.slice(source.indexOf("export async function runStreaming"));
    expect(runStreamingBlock).toContain("createWriteStream");
    expect(runStreamingBlock).toContain("child.kill(signal)");
    expect(runStreamingBlock).toContain("writeLogChunk(chunk)");
    expect(runStreamingBlock).not.toContain('let log = ""');
    expect(runStreamingBlock).not.toContain("log += text");
    expect(runStreamingBlock).not.toContain("writeFile(options.logPath, log");

    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-parallels-host-command-log-"));
    const logPath = join(tempDir, "stream.log");
    try {
      const status = await runStreaming(
        process.execPath,
        [
          "-e",
          "process.stdout.write('x'.repeat(128 * 1024)); process.stderr.write('stream-done');",
        ],
        {
          logPath,
          quiet: true,
        },
      );

      expect(status).toBe(0);
      expect(statSync(logPath).size).toBeGreaterThan(128 * 1024);
      expect(readFileSync(logPath, "utf8")).toContain("stream-done");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not treat timed command stderr as wrapper control data",
    () => {
      const result = run(
        process.execPath,
        ["-e", "process.stderr.write('__OPENCLAW_HOST_COMMAND_SPAWN_ERROR__{}\\n')"],
        {
          check: false,
          quiet: true,
          timeoutMs: 500,
        },
      );

      expect(result.status).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")("preserves timed host command output capture", () => {
    const expected = "x".repeat(256 * 1024);
    const result = run(process.execPath, ["-e", "process.stdout.write('x'.repeat(256 * 1024))"], {
      check: false,
      quiet: true,
      timeoutMs: 1_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it.runIf(process.platform !== "win32")(
    "ignores broken stdin pipes from timed host commands that exit early",
    () => {
      const result = run(process.execPath, ["-e", "process.exit(0)"], {
        check: false,
        input: "x".repeat(1024 * 1024),
        quiet: true,
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
    const script = readFileSync(TS_PATHS.windows, "utf8");

    expect(script).toContain('guestPowerShellBackground(\n      "agent-turn"');
    expect(script).toContain("OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S");
    expect(script).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S"',
    );
    expect(script).toContain("windowsAgentTurnConfigPatchScript(this.auth.modelId)");
    expect(script).toContain("--model");
    expect(script).toContain('resolveParallelsModelTimeoutSeconds("windows")');
    expect(script).toContain("finalAssistant(Raw|Visible)Text");
    expect(script).toContain("parallels-windows-smoke-retry-$attempt");
    expect(script).toContain("agent turn attempt $attempt failed or finished without OK response");
    expect(script).not.toContain("$config.models.providers");
    expect(script).not.toContain("timeoutSeconds = 300");
    expect(script).toContain('"$sessionId.jsonl"');
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
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain(
      'this.agentTimeoutSeconds = readPositiveIntEnv("OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S", 2700)',
    );
    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain("--timeout ${this.modelTimeoutSeconds}");
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain(
      '--timeout ${resolveParallelsModelTimeoutSeconds("linux")}',
    );
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

    expectFatalError(
      () =>
        withEnv({ OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: "1800s" }, () =>
          resolveParallelsModelTimeoutSeconds("macos"),
        ),
      "invalid OPENCLAW_PARALLELS_MACOS_MODEL_TIMEOUT_S: 1800s",
    );
    expectFatalError(
      () => parseMacosSmokeArgs(["--host-port", "18425x"]),
      "invalid --host-port: 18425x",
    );
    expectFatalError(() => parseLinuxSmokeArgs(["--host-port", "1e4"]), "invalid --host-port: 1e4");
    expectFatalError(
      () => parseWindowsSmokeArgs(["--host-port", "0x4800"]),
      "invalid --host-port: 0x4800",
    );
    for (const parseArgs of [parseMacosSmokeArgs, parseLinuxSmokeArgs, parseWindowsSmokeArgs]) {
      expectFatalError(() => parseArgs(["--host-port", "65536"]), "invalid --host-port: 65536");
    }
    expectFatalError(
      () =>
        withEnv({ OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S: "1e3" }, () =>
          readPositiveIntEnv("OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S", 1500),
        ),
      "invalid OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S: 1e3",
    );
    expectFatalError(
      () =>
        withEnv({ OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S: "2700s" }, () =>
          readPositiveIntEnv("OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S", 2700),
        ),
      "invalid OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S: 2700s",
    );
    expectFatalError(
      () =>
        withEnv({ OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S: "12.5" }, () =>
          readPositiveIntEnv("OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S", 7200),
        ),
      "invalid OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S: 12.5",
    );
    expectFatalError(
      () => parseNpmUpdateSmokeArgs(["--platform", "macos,macos"]),
      "duplicate --platform entry: macos",
    );

    expect(readFileSync(TS_PATHS.macos, "utf8")).toContain(
      'this.updateDevTimeoutSeconds = readPositiveIntEnv(\n      "OPENCLAW_PARALLELS_MACOS_UPDATE_DEV_TIMEOUT_S"',
    );
    expect(readFileSync(TS_PATHS.linux, "utf8")).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S"',
    );
    expect(readFileSync(TS_PATHS.windows, "utf8")).toContain(
      'readPositiveIntEnv(\n    "OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S"',
    );
    expect(readFileSync(TS_PATHS.packageArtifact, "utf8")).toContain(
      'readPositiveIntEnv("OPENCLAW_PARALLELS_PACKAGE_LOCK_TIMEOUT_MS", 30 * 60_000)',
    );
    expect(readFileSync(TS_PATHS.npmUpdate, "utf8")).toContain(
      'readPositiveIntEnv("OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S", 1200)',
    );
  });

  it("waits through transient Windows restoring state before VM operations", () => {
    const script = readFileSync(TS_PATHS.windows, "utf8");
    const transports = readFileSync(TS_PATHS.guestTransports, "utf8");

    expect(script).toContain("waitForVmNotRestoring");
    expect(script).toContain("snapshot-switch retry");
    expect(transports).toContain("launch retry");
  });

  it("keeps Windows update-only env flags scoped before verification", () => {
    const windows = readFileSync(TS_PATHS.windows, "utf8");
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");

    expect(powershell).toContain("windowsScopedEnvFunction");
    expect(windows).toContain(
      "Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
    );
    expect(windows).toContain("$script:OpenClawUpdateExit = $LASTEXITCODE");
    expect(windows).not.toContain("$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'");
  });

  it("writes Parallels phase timing artifacts", () => {
    const phaseRunner = readFileSync(TS_PATHS.phaseRunner, "utf8");
    const npmUpdate = readFileSync(TS_PATHS.npmUpdate, "utf8");

    expect(phaseRunner).toContain("phase-timings.json");
    expect(phaseRunner).toContain("slowest");
    expect(npmUpdate).toContain("timings: this.timings");
    expect(npmUpdate).toContain("recordTiming");
  });

  it("resolves Windows OpenClaw commands without assuming the npm shim path", () => {
    const powershell = readFileSync(TS_PATHS.powershell, "utf8");
    const windows = readFileSync(TS_PATHS.windows, "utf8");

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
