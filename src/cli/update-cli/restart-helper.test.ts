// Restart helper tests cover update restart helper process selection and error handling.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";

const windowsKillPolicyStartMarker = "# OPENCLAW_RESTART_KILL_POLICY_BEGIN";
const windowsKillPolicyEndMarker = "# OPENCLAW_RESTART_KILL_POLICY_END";

function findPowerShell(): string | null {
  const executable = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  const candidates = [
    process.env.OPENCLAW_TEST_PWSH,
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, executable)),
  ];
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && existsSync(candidate)),
    ) ?? null
  );
}

const powerShellPath = findPowerShell();
const itWithPowerShell = powerShellPath ? it : it.skip;

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: vi.fn(),
    },
  );
});

describe("restart-helper", () => {
  const originalPlatform = process.platform;
  const originalGetUid = process.getuid;

  async function prepareAndReadScript(
    env: Record<string, string>,
    gatewayPort = 18789,
    windowsGatewayArgv: readonly string[] = [],
  ) {
    const scriptPath = await prepareRestartScript(env, gatewayPort, windowsGatewayArgv);
    if (scriptPath == null) {
      throw new Error("expected restart script path");
    }
    const content = await fs.readFile(scriptPath, "utf-8");
    return { scriptPath, content };
  }

  async function cleanupScript(scriptPath: string) {
    await fs.unlink(scriptPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
    await fs.rmdir(path.dirname(scriptPath)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
  }

  function extractWindowsKillPolicy(content: string): string {
    const start = content.indexOf(windowsKillPolicyStartMarker);
    const end = content.indexOf(windowsKillPolicyEndMarker, start);
    if (start < 0 || end < 0) {
      throw new Error("Windows restart kill-policy markers missing");
    }
    return content.slice(start + windowsKillPolicyStartMarker.length, end);
  }

  async function executeWindowsKillPolicy(content: string, testBody: string) {
    if (!powerShellPath) {
      throw new Error("PowerShell is unavailable");
    }
    const scriptDir = await makeTempDir("openclaw-restart-policy-");
    const scriptPath = path.join(scriptDir, "policy-test.ps1");
    const policy = extractWindowsKillPolicy(content);
    await fs.writeFile(
      scriptPath,
      [
        '$ErrorActionPreference = "Stop"',
        "$script:RestartLogs = [Collections.Generic.List[string]]::new()",
        "function Write-RestartLog { param([string]$Message) $script:RestartLogs.Add($Message) | Out-Null }",
        policy,
        testBody,
      ].join("\n"),
      "utf8",
    );
    try {
      return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          powerShellPath,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath],
          { env: process.env },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                new Error(`PowerShell policy test failed: ${stderr || stdout}`, { cause: error }),
              );
              return;
            }
            resolve({ stdout, stderr });
          },
        );
      });
    } finally {
      await fs.rm(scriptDir, { recursive: true, force: true });
    }
  }

  async function makeTempDir(prefix: string) {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async function writeFakeLaunchctl(
    fakeBinDir: string,
    content = `#!/bin/sh
echo "launchctl $*" >&2
case "$1" in
  kickstart) exit 0 ;;
  enable|bootstrap) exit 0 ;;
esac
exit 0
`,
  ) {
    const launchctlPath = path.join(fakeBinDir, "launchctl");
    await fs.writeFile(launchctlPath, content, { mode: 0o755 });
  }

  async function writeFakeSleep(fakeBinDir: string) {
    await fs.writeFile(path.join(fakeBinDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  async function executeScript(scriptPath: string, env: Record<string, string>) {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(
        "/bin/sh",
        [scriptPath],
        { env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          const execError = error as (Error & { code?: number | string }) | null;
          const code = typeof execError?.code === "number" ? execError.code : null;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  function expectWindowsRestartWaitOrdering(content: string, port = 18789) {
    const stateCheck = "$taskState = Get-OpenClawScheduledTaskState -TaskName $taskName";
    const runningGuard = 'if ($taskState -eq "Running")';
    const endCommand =
      'Invoke-OpenClawSchtasksWithTimeout -Arguments @("/End", "/TN", $taskName) -TimeoutSeconds 10';
    const skipEndLog = "openclaw restart skipped schtasks end";
    const pollLoop = "for ($attempt = 1; $attempt -le 10; $attempt++)";
    const pollCall = `Get-OpenClawListenerSnapshot -Port $port`;
    const forceKillBranch = "if ($attempt -eq 10)";
    const ownerCheckFunction = "function Invoke-OpenClawVerifiedListenerKill";
    const ownerCheckCall = "Invoke-OpenClawVerifiedListenerKill -ProcessId $listenerPid";
    const forceKillCommand = "if ($lease.Terminate())";
    const runCommand =
      'Invoke-OpenClawSchtasksWithTimeout -Arguments @("/Run", "/TN", $taskName) -TimeoutSeconds 30';
    const portAssignment = `$port = ${port}`;
    const stateCheckIndex = content.indexOf(stateCheck);
    const runningGuardIndex = content.indexOf(runningGuard, stateCheckIndex);
    const endIndex = content.indexOf(endCommand, runningGuardIndex);
    const skipEndLogIndex = content.indexOf(skipEndLog, endIndex);
    const portAssignmentIndex = content.indexOf(portAssignment);
    const pollLoopIndex = content.indexOf(pollLoop, skipEndLogIndex);
    const pollCallIndex = content.indexOf(pollCall, pollLoopIndex);
    const forceKillBranchIndex = content.indexOf(forceKillBranch, pollCallIndex);
    const ownerCheckFunctionIndex = content.indexOf(ownerCheckFunction);
    const forceKillCommandIndex = content.indexOf(forceKillCommand, ownerCheckFunctionIndex);
    const ownerCheckCallIndex = content.indexOf(ownerCheckCall, forceKillBranchIndex);
    const runIndex = content.indexOf(runCommand, ownerCheckCallIndex);

    expect(stateCheckIndex).toBeGreaterThanOrEqual(0);
    expect(runningGuardIndex).toBeGreaterThan(stateCheckIndex);
    expect(endIndex).toBeGreaterThan(runningGuardIndex);
    expect(skipEndLogIndex).toBeGreaterThan(endIndex);
    expect(portAssignmentIndex).toBeGreaterThanOrEqual(0);
    expect(pollLoopIndex).toBeGreaterThan(skipEndLogIndex);
    expect(pollCallIndex).toBeGreaterThan(pollLoopIndex);
    expect(forceKillBranchIndex).toBeGreaterThan(pollCallIndex);
    expect(ownerCheckFunctionIndex).toBeGreaterThanOrEqual(0);
    expect(forceKillCommandIndex).toBeGreaterThan(ownerCheckFunctionIndex);
    expect(ownerCheckCallIndex).toBeGreaterThan(forceKillBranchIndex);
    expect(runIndex).toBeGreaterThan(ownerCheckCallIndex);

    expect(content).not.toContain("timeout /t 3 /nobreak >nul");
    expect(content).not.toContain("findstr");
    expect(content).not.toContain("netstat -ano |");
    expect(content).not.toContain("schtasks /End /TN");
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.getuid = originalGetUid;
  });

  describe("prepareRestartScript", () => {
    it("creates a systemd restart script on Linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
      });
      expect(scriptPath.endsWith(".sh")).toBe(true);
      expect(content).toContain("#!/bin/sh");
      expect(content).toContain("systemctl --user restart 'openclaw-gateway.service'");
      // Script should self-cleanup
      expect(content).toContain('rm -f "$0"');
      expect(content).toContain('rmdir "$script_dir" 2>/dev/null || true');
      await cleanupScript(scriptPath);
    });

    it("repairs a mismatched inherited user bus before running systemctl --user", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.getuid = () => 1000;
      const statSpy = vi.spyOn(fs, "stat").mockResolvedValue({
        isSocket: () => true,
      } as Awaited<ReturnType<typeof fs.stat>>);
      const tmpDir = await makeTempDir("openclaw-restart-helper-");
      const fakeBinDir = path.join(tmpDir, "bin");
      const callsPath = path.join(tmpDir, "systemctl-calls.log");
      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeSleep(fakeBinDir);
      await fs.writeFile(
        path.join(fakeBinDir, "systemctl"),
        `#!/bin/sh
printf 'runtime=%s bus=%s args=%s\n' "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "$*" >> "$OPENCLAW_SYSTEMCTL_CALLS"
case "$2" in
  is-active|restart) exit 0 ;;
esac
exit 1
`,
        { mode: 0o755 },
      );

      const { scriptPath } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        HOME: path.join(tmpDir, "home"),
        OPENCLAW_STATE_DIR: path.join(tmpDir, "state"),
        XDG_RUNTIME_DIR: "/run/user/0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
      });
      const result = await executeScript(scriptPath, {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_SYSTEMCTL_CALLS: callsPath,
        XDG_RUNTIME_DIR: "/run/user/0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
      });
      const calls = await fs.readFile(callsPath, "utf-8");

      expect(result.code).toBeNull();
      expect(statSpy).toHaveBeenCalledWith("/run/user/1000/bus");
      expect(calls).toContain(
        "runtime=/run/user/1000 bus=unix:path=/run/user/1000/bus args=--user is-active --quiet openclaw-gateway.service",
      );
      expect(calls).toContain(
        "runtime=/run/user/1000 bus=unix:path=/run/user/1000/bus args=--user restart openclaw-gateway.service",
      );
      expect(calls).not.toContain("runtime=/run/user/0");
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("does not rewrite a custom user bus environment", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.getuid = () => 1000;
      const statSpy = vi.spyOn(fs, "stat");
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "/srv/openclaw-runtime",
        DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/openclaw-user-bus",
      });

      expect(statSpy).not.toHaveBeenCalled();
      expect(content).not.toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
      await cleanupScript(scriptPath);
    });

    it("preserves a custom user bus when the runtime directory is missing", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.getuid = () => 1000;
      vi.spyOn(fs, "stat").mockResolvedValue({
        isSocket: () => true,
      } as Awaited<ReturnType<typeof fs.stat>>);
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "",
        DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/openclaw-user-bus",
      });

      expect(content).toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
      expect(content).not.toContain("export DBUS_SESSION_BUS_ADDRESS=");
      await cleanupScript(scriptPath);
    });

    it("repairs both missing standard user bus values", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.getuid = () => 1000;
      vi.spyOn(fs, "stat").mockResolvedValue({
        isSocket: () => true,
      } as Awaited<ReturnType<typeof fs.stat>>);
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "",
        DBUS_SESSION_BUS_ADDRESS: "",
      });

      expect(content).toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
      expect(content).toContain("export DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus'");
      await cleanupScript(scriptPath);
    });

    it("keeps a valid standard user bus environment", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.getuid = () => 1000;
      const statSpy = vi.spyOn(fs, "stat");
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      });

      expect(statSpy).not.toHaveBeenCalled();
      expect(content).not.toContain("export XDG_RUNTIME_DIR=");
      expect(content).not.toContain("export DBUS_SESSION_BUS_ADDRESS=");
      await cleanupScript(scriptPath);
    });

    it("keeps the inherited environment when the effective user bus is unavailable", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.getuid = () => 1000;
      vi.spyOn(fs, "stat").mockRejectedValue(
        Object.assign(new Error("missing bus"), { code: "ENOENT" }),
      );
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "/run/user/0",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
      });

      expect(content).not.toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
      await cleanupScript(scriptPath);
    });

    it("creates restart scripts in a private temp directory with exclusive creation", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const timestamp = 1_727_201_234_567;
      const oldCandidatePath = path.join(os.tmpdir(), `openclaw-restart-${timestamp}.sh`);
      const victimDir = await makeTempDir("openclaw-restart-helper-victim-");
      const victimPath = path.join(victimDir, "restart.sh");
      await fs.rm(oldCandidatePath, { force: true });
      await fs.writeFile(victimPath, "preexisting script\n", "utf-8");

      let candidateIsSymlink = false;
      try {
        await fs.symlink(victimPath, oldCandidatePath);
        candidateIsSymlink = true;
      } catch {
        await fs.writeFile(oldCandidatePath, "preexisting script\n", { flag: "wx" });
      }

      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(timestamp);
      const writeFileSpy = vi.spyOn(fs, "writeFile");

      try {
        const { scriptPath } = await prepareAndReadScript({
          OPENCLAW_PROFILE: "default",
        });
        const scriptDir = path.dirname(scriptPath);
        const relativeScriptDir = path.relative(os.tmpdir(), scriptDir);

        expect(scriptPath).not.toBe(oldCandidatePath);
        expect(scriptDir).not.toBe(os.tmpdir());
        expect(relativeScriptDir).not.toBe("");
        expect(relativeScriptDir.startsWith("..")).toBe(false);
        expect(path.isAbsolute(relativeScriptDir)).toBe(false);
        expect(path.basename(scriptDir)).toMatch(/^openclaw-restart-/);
        expect(writeFileSpy).toHaveBeenLastCalledWith(
          scriptPath,
          expect.any(String),
          expect.objectContaining({ flag: "wx", mode: 0o755 }),
        );
        await expect(fs.readFile(victimPath, "utf-8")).resolves.toBe("preexisting script\n");
        if (!candidateIsSymlink) {
          await expect(fs.readFile(oldCandidatePath, "utf-8")).resolves.toBe(
            "preexisting script\n",
          );
        }
        await cleanupScript(scriptPath);
      } finally {
        dateSpy.mockRestore();
        writeFileSpy.mockRestore();
        await fs.rm(oldCandidatePath, { force: true });
        await fs.rm(victimDir, { recursive: true, force: true });
      }
    });

    it("uses OPENCLAW_SYSTEMD_UNIT override for systemd scripts", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        OPENCLAW_SYSTEMD_UNIT: "custom-gateway",
      });
      expect(content).toContain("systemctl --user restart 'custom-gateway.service'");
      await cleanupScript(scriptPath);
    });

    it("fails with sudo systemd guidance when the gateway unit is system-scoped", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const tmpDir = await makeTempDir("openclaw-restart-helper-");
      const fakeBinDir = path.join(tmpDir, "bin");
      const callsPath = path.join(tmpDir, "systemctl-calls.log");
      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeSleep(fakeBinDir);
      await fs.writeFile(
        path.join(fakeBinDir, "systemctl"),
        `#!/bin/sh
printf '%s\\n' "$*" >> "$OPENCLAW_SYSTEMCTL_CALLS"
if [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then exit 3; fi
if [ "$1" = "--user" ] && [ "$2" = "is-enabled" ]; then exit 1; fi
if [ "$1" = "is-active" ] && [ "$2" = "--quiet" ]; then exit 0; fi
if [ "$1" = "is-enabled" ] && [ "$2" = "--quiet" ]; then exit 0; fi
if [ "$1" = "--user" ] && [ "$2" = "restart" ]; then exit 99; fi
exit 1
`,
        { mode: 0o755 },
      );

      const { scriptPath } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        HOME: path.join(tmpDir, "home"),
        OPENCLAW_STATE_DIR: path.join(tmpDir, "state"),
      });
      const result = await executeScript(scriptPath, {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        OPENCLAW_SYSTEMCTL_CALLS: callsPath,
      });
      const calls = await fs.readFile(callsPath, "utf-8");

      expect(result.code).toBe(78);
      expect(result.stderr).toContain("system-scoped openclaw gateway unit detected");
      expect(result.stderr).toContain("sudo systemctl restart openclaw-gateway.service");
      expect(calls).toContain("--user is-active --quiet openclaw-gateway.service");
      expect(calls).toContain("is-active --quiet openclaw-gateway.service");
      expect(calls).not.toContain("--user restart openclaw-gateway.service");
    });

    it("creates a launchd restart script on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
      });
      expect(scriptPath.endsWith(".sh")).toBe(true);
      expect(content).toContain("#!/bin/sh");
      expect(content).toContain("launchctl kickstart -k 'gui/501/ai.openclaw.gateway'");
      // Should clear disabled state and fall back to bootstrap when kickstart fails.
      expect(content).toContain("launchctl enable 'gui/501/ai.openclaw.gateway'");
      expect(content).toContain("launchctl bootstrap 'gui/501'");
      expect(content).toContain("Bootstrap loads RunAtLoad agents");
      expect(content).toContain('rm -f "$0"');
      expect(content).toContain('rmdir "$script_dir" 2>/dev/null || true');
      await cleanupScript(scriptPath);
    });

    it("captures macOS launchctl stderr to ~/.openclaw/logs/gateway-restart.log (#68486)", async () => {
      // Silent failure in macOS update restart helper: previously every
      // launchctl call redirected stderr to /dev/null and the final kickstart
      // was chained with `|| true`, so bootstrap/kickstart failures were
      // invisible and the gateway stayed offline while the updater reported
      // success. The script should now route stderr to a durable log file and
      // stop swallowing the final exit code.
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        HOME: "/Users/testuser",
      });
      expect(content).toContain("exec >>'/Users/testuser/.openclaw/logs/gateway-restart.log' 2>&1");
      // Every launchctl call should allow output through now (no `2>/dev/null`)
      // and the final kickstart must not swallow its exit code.
      expect(content).not.toMatch(/launchctl[^\n]*2>\/dev\/null/);
      expect(content).not.toMatch(/launchctl kickstart[^\n]*\|\| true/);
      await cleanupScript(scriptPath);
    });

    it("uses OPENCLAW_STATE_DIR for the macOS update restart log", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        HOME: "/Users/testuser",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
      });

      expect(content).toContain(
        "if mkdir -p '/tmp/openclaw-state/logs' 2>/dev/null && : >>'/tmp/openclaw-state/logs/gateway-restart.log' 2>/dev/null; then",
      );
      expect(content).toContain("exec >>'/tmp/openclaw-state/logs/gateway-restart.log' 2>&1");
      await cleanupScript(scriptPath);
    });

    it("returns the final macOS launchctl kickstart failure after logging cleanup", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;
      const tmpDir = await makeTempDir("openclaw-restart-helper-");
      const fakeBinDir = path.join(tmpDir, "bin");
      const stateDir = path.join(tmpDir, "state");
      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeSleep(fakeBinDir);
      await writeFakeLaunchctl(
        fakeBinDir,
        `#!/bin/sh
echo "launchctl $*" >&2
case "$1" in
  kickstart) exit 42 ;;
  enable) exit 0 ;;
  bootstrap) exit 1 ;;
esac
exit 0
`,
      );

      const { scriptPath } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        HOME: path.join(tmpDir, "home"),
        OPENCLAW_STATE_DIR: stateDir,
      });

      const result = await executeScript(scriptPath, {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      });
      const log = await fs.readFile(path.join(stateDir, "logs", "gateway-restart.log"), "utf-8");

      expect(result.code).toBe(42);
      expect(log).toContain("openclaw restart attempt source=update target=ai.openclaw.gateway");
      expect(log).toContain("launchctl kickstart -k gui/501/ai.openclaw.gateway");
      expect(log).toContain("openclaw restart failed source=update status=42");
      expect(log).not.toContain("openclaw restart done source=update");
    });

    it("continues the macOS restart path when log setup fails", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;
      const tmpDir = await makeTempDir("openclaw-restart-helper-");
      const fakeBinDir = path.join(tmpDir, "bin");
      const stateFile = path.join(tmpDir, "state-file");
      const markerPath = path.join(tmpDir, "launchctl-ran");
      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeSleep(fakeBinDir);
      await fs.writeFile(stateFile, "not a directory");
      await writeFakeLaunchctl(
        fakeBinDir,
        `#!/bin/sh
printf ran > "$LAUNCHCTL_MARKER"
exit 0
`,
      );

      const { scriptPath } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        HOME: path.join(tmpDir, "home"),
        OPENCLAW_STATE_DIR: stateFile,
      });

      const result = await executeScript(scriptPath, {
        LAUNCHCTL_MARKER: markerPath,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      });

      expect(result.code).toBeNull();
      await expect(fs.readFile(markerPath, "utf-8")).resolves.toBe("ran");
    });

    it("logs custom macOS launchd labels without shell expansion", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;
      const tmpDir = await makeTempDir("openclaw-restart-helper-");
      const fakeBinDir = path.join(tmpDir, "bin");
      const stateDir = path.join(tmpDir, "state");
      await fs.mkdir(fakeBinDir, { recursive: true });
      await writeFakeSleep(fakeBinDir);
      await writeFakeLaunchctl(fakeBinDir);

      const { scriptPath } = await prepareAndReadScript({
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.$(echo injected)",
        HOME: path.join(tmpDir, "home"),
        OPENCLAW_STATE_DIR: stateDir,
      });

      const result = await executeScript(scriptPath, {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      });
      const log = await fs.readFile(path.join(stateDir, "logs", "gateway-restart.log"), "utf-8");

      expect(result.code).toBeNull();
      expect(log).toContain("target=ai.openclaw.$(echo injected)");
      expect(log).not.toContain("target=ai.openclaw.injected");
    });

    it("uses OPENCLAW_LAUNCHD_LABEL override on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        OPENCLAW_LAUNCHD_LABEL: "com.custom.openclaw",
      });
      expect(content).toContain("launchctl kickstart -k 'gui/501/com.custom.openclaw'");
      await cleanupScript(scriptPath);
    });

    it("creates a guarded schtasks restart script on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
      });
      expect(scriptPath.endsWith(".cmd")).toBe(true);
      expect(content).toContain("@echo off");
      expect(content).toContain("powershell -NoProfile -ExecutionPolicy Bypass -Command");
      expect(content).not.toContain("powershell -NoProfile -ExecutionPolicy Bypass -File");
      expect(content).toContain('$ErrorActionPreference = "Continue"');
      expect(content).toContain("gateway-restart.log");
      expect(content).toContain("$taskName = 'OpenClaw Gateway'");
      expect(content).toContain("function Invoke-OpenClawSchtasksWithTimeout");
      expect(content).toContain("function Get-OpenClawScheduledTaskState");
      expect(content).toContain("function Get-OpenClawListenerKillDecision");
      expect(content).toContain("function Invoke-OpenClawVerifiedListenerKill");
      expect(content).toContain("function Invoke-OpenClawStartupLauncher");
      expect(content).toContain("Get-ScheduledTask -TaskName $TaskName");
      expect(content).toContain("openclaw restart skipped schtasks end");
      expect(content).toContain("$gatewayScriptPath = ");
      expect(content).toContain("$expectedGatewayArgv = @()");
      expect(content).toContain("openclaw restart launched startup fallback");
      expectWindowsRestartWaitOrdering(content);
      expect(content).toContain('del "%~f0" >nul 2>&1');
      expect(content).toContain('rmdir "%OPENCLAW_RESTART_SCRIPT_DIR%" >nul 2>&1');
      await cleanupScript(scriptPath);
    });

    it("holds and rechecks the exact installed gateway process before killing on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const expectedArgv = [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Users\\O'Brien\\openclaw\\dist\\entry.js",
        "gateway",
        "--port",
        "18789",
      ];
      const { scriptPath, content } = await prepareAndReadScript(
        { OPENCLAW_PROFILE: "default" },
        18789,
        expectedArgv,
      );

      expect(content).toContain(
        "$expectedGatewayArgv = @('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\O''Brien\\openclaw\\dist\\entry.js', 'gateway', '--port', '18789')",
      );
      expect(content).toContain("CommandLineToArgvW");
      expect(content).toContain("PROCESS_QUERY_LIMITED_INFORMATION");
      expect(content).toContain("GetProcessTimes");
      expect(content).toContain("creationTime - (creationTime % 10)");
      expect(content).toContain("$creationTimeFileTime -= $creationTimeFileTime % 10");
      expect(content).toContain("TryOpenProcess($QueryPid)");
      expect(content).toContain("Get-OpenClawListenerKillDecision");
      expect(content).toContain("$recheckedListeners = & $ListenerQuery $Port");
      expect(content).toContain("$recheckedProcess = & $ProcessQuery $ProcessId");
      expect(content).toContain("if ($lease.Terminate())");
      expect(content).toContain("$lease.Dispose()");
      expect(content).toContain('return "listener-query-unavailable"');
      expect(content).not.toContain("Stop-Process -Id");
      expect(content).not.toContain("openclaw-gateway(\\.exe)?");
      expect(content).not.toContain("Get-Content -LiteralPath $ScriptPath");
      await cleanupScript(scriptPath);
    });

    itWithPowerShell(
      "executes the shipped PowerShell kill policy with mocked Windows facts",
      async () => {
        Object.defineProperty(process, "platform", { value: "win32" });
        const { scriptPath, content } = await prepareAndReadScript(
          { OPENCLAW_PROFILE: "default" },
          18789,
          ["node", "C:\\openclaw\\dist\\entry.js", "gateway", "--port", "18789"],
        );
        try {
          const result = await executeWindowsKillPolicy(
            content,
            String.raw`
function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-DecisionLog {
  param([string]$Decision)
  $match = @($script:RestartLogs | Where-Object { $_ -like "*decision=$Decision*" })
  Assert-True ($match.Count -gt 0) "missing decision log: $Decision"
}

function New-ProcessFacts {
  param([int]$ProcessId, [string]$CreationTime, [string[]]$Argv)
  return [pscustomobject]@{
    ProcessId = $ProcessId
    CreationTimeFileTime = $CreationTime
    Argv = $Argv
  }
}

function New-TestLease {
  param([string]$CreationTime)
  $lease = [pscustomobject]@{
    CreationTimeFileTime = $CreationTime
    Terminated = $false
    Disposed = $false
  }
  $lease | Add-Member -MemberType ScriptMethod -Name Terminate -Value {
    $this.Terminated = $true
    return $true
  }
  $lease | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
    $this.Disposed = $true
  }
  return $lease
}

function Invoke-MockedKill {
  param($Observed, $Rechecked, $Listeners, $Lease, [string[]]$ExpectedArgv)
  $script:MockObserved = $Observed
  $script:MockRechecked = $Rechecked
  $script:MockListeners = $Listeners
  $script:MockLease = $Lease
  $script:ProcessQueryCalls = 0
  $script:ListenerQueryCalls = 0
  $script:ProcessOpenCalls = 0
  $processQuery = {
    param([int]$IgnoredPid)
    $script:ProcessQueryCalls += 1
    if ($script:ProcessQueryCalls -eq 1) { return $script:MockObserved }
    return $script:MockRechecked
  }
  $listenerQuery = {
    param([int]$IgnoredPort)
    $script:ListenerQueryCalls += 1
    return $script:MockListeners
  }
  $processOpen = {
    param([int]$IgnoredPid)
    $script:ProcessOpenCalls += 1
    return $script:MockLease
  }
  Invoke-OpenClawVerifiedListenerKill -ProcessId 4242 -Port 18789 -ExpectedArgv $ExpectedArgv -ProcessQuery $processQuery -ListenerQuery $listenerQuery -ProcessOpen $processOpen
}

# Get-NetTCPConnection exposes object properties, including duplicate IPv4/IPv6 rows.
function Get-NetTCPConnection {
  param($State, $ErrorAction)
  @(
    [pscustomobject]@{ LocalPort = 18789; OwningProcess = 4242 },
    [pscustomobject]@{ LocalPort = 18789; OwningProcess = 4242 },
    [pscustomobject]@{ LocalPort = 443; OwningProcess = 5252 }
  )
}
$snapshot = Get-OpenClawListenerSnapshot -Port 18789
Assert-True $snapshot.Known "Get-NetTCPConnection snapshot should be known"
Assert-True (@($snapshot.Pids).Count -eq 1) "duplicate listener PIDs should collapse"
Assert-True (@($snapshot.Pids)[0] -eq 4242) "wrong Get-NetTCPConnection PID"

# Force the locale-independent netstat fallback. Localized state text is ignored.
function Get-NetTCPConnection { param($State, $ErrorAction) throw "unavailable" }
function netstat.exe {
  $script:LASTEXITCODE = 0
  @(
    "  TCP    0.0.0.0:18789      0.0.0.0:0       LISTENING      4242",
    "  TCP    [::]:18789         [::]:0          ABHÖREN        4242",
    "  TCP    127.0.0.1:18789    127.0.0.1:61234 HERGESTELLT     5252"
  )
}
$snapshot = Get-OpenClawListenerSnapshot -Port 18789
Assert-True $snapshot.Known "netstat snapshot should be known"
Assert-True (@($snapshot.Pids).Count -eq 1) "netstat IPv4/IPv6 PIDs should collapse"
Assert-True (@($snapshot.Pids)[0] -eq 4242) "wrong netstat PID"

function netstat.exe { $script:LASTEXITCODE = 1 }
$snapshot = Get-OpenClawListenerSnapshot -Port 18789
Assert-True (-not $snapshot.Known) "failed listener queries must remain unknown"

$creation = "133987654321000000"
$expected = @("node", "C:\openclaw\dist\entry.js", "gateway", "--port", "18789")
$managed = New-ProcessFacts 4242 $creation @("node.exe", "C:\openclaw\dist\entry.js", "gateway", "--port", "18789")
$knownListener = [pscustomobject]@{ Known = $true; Pids = @(4242) }

$script:RestartLogs.Clear()
$lease = New-TestLease $creation
Invoke-MockedKill $managed $managed $knownListener $lease $expected
Assert-True $lease.Terminated "managed stale listener was not killed"
Assert-True $lease.Disposed "managed listener handle was not disposed"
Assert-True ($script:ProcessQueryCalls -eq 2) "managed process was not rechecked"
Assert-True ($script:ListenerQueryCalls -eq 1) "managed listener was not rechecked"

$script:RestartLogs.Clear()
$foreign = New-ProcessFacts 4242 $creation @("python.exe", "foreign-listener.py")
$lease = New-TestLease $creation
Invoke-MockedKill $foreign $foreign $knownListener $lease $expected
Assert-True (-not $lease.Terminated) "foreign listener was killed"
Assert-True ($script:ProcessOpenCalls -eq 0) "foreign listener opened a terminate handle"
Assert-DecisionLog "command-mismatch"

$script:RestartLogs.Clear()
$lease = New-TestLease $creation
Invoke-MockedKill $null $null $knownListener $lease $expected
Assert-True (-not $lease.Terminated) "unknown owner was killed"
Assert-True ($script:ProcessOpenCalls -eq 0) "unknown owner opened a terminate handle"
Assert-DecisionLog "process-unavailable"

$script:RestartLogs.Clear()
$lease = New-TestLease $creation
$unknownListeners = [pscustomobject]@{ Known = $false; Pids = @() }
Invoke-MockedKill $managed $managed $unknownListeners $lease $expected
Assert-True (-not $lease.Terminated) "unknown listener state was killed"
Assert-True $lease.Disposed "unknown listener handle was not disposed"
Assert-DecisionLog "listener-query-unavailable"

$script:RestartLogs.Clear()
$recycledLease = New-TestLease "133987654399000000"
Invoke-MockedKill $managed $managed $knownListener $recycledLease $expected
Assert-True (-not $recycledLease.Terminated) "recycled PID target was killed"
Assert-True $recycledLease.Disposed "recycled PID handle was not disposed"
Assert-DecisionLog "process-replaced"

Write-Output "OPENCLAW_RESTART_POLICY_OK"
`,
          );

          expect(result.stderr).toBe("");
          expect(result.stdout).toContain("OPENCLAW_RESTART_POLICY_OK");
        } finally {
          await cleanupScript(scriptPath);
        }
      },
    );

    it("uses OPENCLAW_WINDOWS_TASK_NAME override on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
      });
      expect(content).toContain("$taskName = 'OpenClaw Gateway (custom)'");
      expect(content).toContain("Get-OpenClawScheduledTaskState -TaskName $taskName");
      expect(content).toContain(
        'Invoke-OpenClawSchtasksWithTimeout -Arguments @("/End", "/TN", $taskName) -TimeoutSeconds 10',
      );
      expect(content).toContain(
        "$status = Invoke-OpenClawStartupLauncher -LauncherPath $gatewayScriptPath",
      );
      expectWindowsRestartWaitOrdering(content);
      await cleanupScript(scriptPath);
    });

    it("uses passed gateway port for port polling on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const customPort = 9999;

      const { scriptPath, content } = await prepareAndReadScript(
        {
          OPENCLAW_PROFILE: "default",
        },
        customPort,
      );
      expect(content).toContain(`$port = ${customPort}`);
      expect(content).toContain("Get-NetTCPConnection -State Listen -ErrorAction Stop");
      expect(content).toContain("& netstat.exe -ano -p tcp");
      expect(content).not.toContain("findstr");
      expectWindowsRestartWaitOrdering(content, customPort);
      await cleanupScript(scriptPath);
    });

    it("uses custom profile in service names", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "production",
      });
      expect(content).toContain("openclaw-gateway-production.service");
      await cleanupScript(scriptPath);
    });

    it("uses custom profile in macOS launchd label", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 502;

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "staging",
      });
      expect(content).toContain("gui/502/ai.openclaw.staging");
      await cleanupScript(scriptPath);
    });

    it("uses custom profile in Windows task name", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "production",
      });
      expect(content).toContain("$taskName = 'OpenClaw Gateway (production)'");
      expectWindowsRestartWaitOrdering(content);
      await cleanupScript(scriptPath);
    });

    it("returns null for unsupported platforms", async () => {
      Object.defineProperty(process, "platform", { value: "aix" });
      const scriptPath = await prepareRestartScript({});
      expect(scriptPath).toBeNull();
    });

    it("returns null when script creation fails", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const writeFileSpy = vi
        .spyOn(fs, "writeFile")
        .mockRejectedValueOnce(new Error("simulated write failure"));

      const scriptPath = await prepareRestartScript({
        OPENCLAW_PROFILE: "default",
      });

      expect(scriptPath).toBeNull();
      writeFileSpy.mockRestore();
    });

    it("escapes single quotes in profile names for shell scripts", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "it's-a-test",
      });
      // Single quotes should be escaped with '\'' pattern
      expect(content).not.toContain("it's");
      expect(content).toContain("it'\\''s");
      await cleanupScript(scriptPath);
    });

    it("expands HOME in plist path instead of leaving literal $HOME", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      const { scriptPath, content } = await prepareAndReadScript({
        HOME: "/Users/testuser",
        OPENCLAW_PROFILE: "default",
      });
      // The plist path must contain the resolved home dir, not literal $HOME
      expect(content).toMatch(/[\\/]Users[\\/]testuser[\\/]Library[\\/]LaunchAgents[\\/]/);
      expect(content).not.toContain("$HOME");
      await cleanupScript(scriptPath);
    });

    it("prefers env parameter HOME over process.env.HOME for plist path", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 502;

      const { scriptPath, content } = await prepareAndReadScript({
        HOME: "/Users/envhome",
        OPENCLAW_PROFILE: "default",
      });
      expect(content).toMatch(/[\\/]Users[\\/]envhome[\\/]Library[\\/]LaunchAgents[\\/]/);
      await cleanupScript(scriptPath);
    });

    it("shell-escapes the label in the plist path on macOS", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      const { scriptPath, content } = await prepareAndReadScript({
        HOME: "/Users/testuser",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.it's-a-test",
      });
      // The plist path must also shell-escape the label to prevent injection
      expect(content).toContain("ai.openclaw.it'\\''s-a-test.plist");
      await cleanupScript(scriptPath);
    });

    it("rejects unsafe batch profile names on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const scriptPath = await prepareRestartScript({
        OPENCLAW_PROFILE: "test&whoami",
      });

      expect(scriptPath).toBeNull();
    });
  });

  describe("runRestartScript", () => {
    it("spawns the script as a detached process on Linux", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      const scriptPath = "/tmp/fake-script.sh";
      const mockChild = { on: vi.fn(), unref: vi.fn() };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript(scriptPath);

      expect(spawn).toHaveBeenCalledWith("/bin/sh", [scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      expect(mockChild.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mockChild.unref).toHaveBeenCalledTimes(1);
    });

    it("uses cmd.exe on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const scriptPath = "C:\\Temp\\fake-script.bat";
      const mockChild = { on: vi.fn(), unref: vi.fn() };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript(scriptPath);

      expect(spawn).toHaveBeenCalledWith(getWindowsCmdExePath(), ["/d", "/s", "/c", scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      expect(mockChild.on).toHaveBeenCalledWith("error", expect.any(Function));
      expect(mockChild.unref).toHaveBeenCalledTimes(1);
    });

    it("quotes cmd.exe /c paths with metacharacters on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const scriptPath = "C:\\Temp\\me&(ow)\\fake-script.bat";
      const mockChild = { on: vi.fn(), unref: vi.fn() };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript(scriptPath);

      expect(spawn).toHaveBeenCalledWith(
        getWindowsCmdExePath(),
        ["/d", "/s", "/c", `"${scriptPath}"`],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    });

    it("does not throw when spawn fails synchronously", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      vi.mocked(spawn).mockImplementation(() => {
        throw Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" });
      });

      await expect(runRestartScript("/tmp/fake-script.sh")).resolves.toBeUndefined();
    });

    it("handles child process spawn errors after the detached handoff", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      let errorHandler: ((error: Error) => void) | undefined;
      const mockChild = {
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          if (event === "error") {
            errorHandler = handler;
          }
          return mockChild;
        }),
        unref: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript("/tmp/fake-script.sh");
      expect(errorHandler).toBeDefined();
      expect(() => errorHandler?.(new Error("spawn /bin/sh ENOENT"))).not.toThrow();
    });
  });
});
