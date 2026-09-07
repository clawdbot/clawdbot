// Restart helper tests cover update restart helper process selection and error handling.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getWindowsSystem32ExePath } from "../../infra/windows-install-roots.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS, spawnCommand } from "../../process/exec-spawn.js";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";

vi.mock("../../process/exec-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec-spawn.js")>()),
  spawnCommand: vi.fn(),
}));

describe("restart-helper", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const originalPlatform = process.platform;
  const originalGetUid = process.getuid;
  const originalGetEuid = process.geteuid;

  const mockLinuxUserBusSocket = () =>
    vi
      .spyOn(fs, "stat")
      .mockResolvedValue({ isSocket: () => true } as Awaited<ReturnType<typeof fs.stat>>);

  async function prepareAndReadScript(
    env: NodeJS.ProcessEnv,
    gatewayPort = 18789,
    windowsGatewayArgv: readonly string[] = [],
  ) {
    const scriptPath = await prepareRestartScript(env, gatewayPort, windowsGatewayArgv);
    if (scriptPath == null) {
      throw new Error("expected restart script path");
    }
    const wrapper = await fs.readFile(scriptPath, "utf-8");
    const content = scriptPath.endsWith(".cmd")
      ? `${wrapper}\n${await fs.readFile(scriptPath.replace(/\.cmd$/u, ".ps1"), "utf8")}`
      : wrapper;
    return { scriptPath, content };
  }

  async function cleanupScript(scriptPath: string) {
    if (scriptPath.endsWith(".cmd")) {
      await fs.unlink(scriptPath.replace(/\.cmd$/u, ".ps1"));
      await fs.unlink(`${scriptPath}.vbs`);
    }
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
    systemOwnership: "absent" | "loaded" = "absent",
  ) {
    const launchctlPath = path.join(fakeBinDir, "launchctl");
    const body = content.replace(/^#!\/bin\/sh\r?\n/, "");
    await fs.writeFile(
      launchctlPath,
      `#!/bin/sh
if [ "$1" = "print" ]; then
  case "$2" in
    system/*) ${systemOwnership === "loaded" ? "exit 0" : "printf 'Could not find service\\n' >&2; exit 113"} ;;
  esac
fi
${body}`,
      { mode: 0o755 },
    );
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
    const forceKillCommand = "$lease.Kill()";
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
    expect(content).not.toContain("netstat.exe -ano -p tcp | findstr");
    expect(content).not.toContain("netstat -ano |");
    expect(content).not.toContain("schtasks /End /TN");
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.getuid = originalGetUid;
    process.geteuid = originalGetEuid;
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
      process.getuid = () => 2000;
      process.geteuid = () => 1000;
      const statSpy = mockLinuxUserBusSocket();
      const tmpDir = tempDirs.make("openclaw-restart-helper-");
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

    it.each([
      ["an abstract bus", "unix:abstract=/openclaw-user-bus"],
      ["a genuinely absent bus", undefined],
      ["an explicitly empty bus", ""],
      ["a whitespace-only bus", "   "],
      ["a cross-user standard bus", "unix:path=/run/user/0/bus"],
      ["a fallback bus", "unix:path=/run/user/0/bus;unix:abstract=/openclaw-user-bus"],
    ])("does not rewrite a custom user runtime with %s", async (_name, busAddress) => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.geteuid = () => 1000;
      const statSpy = mockLinuxUserBusSocket();
      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "/srv/openclaw-runtime",
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      });

      const shouldClearBusAddress = busAddress !== undefined && !busAddress.trim();
      expect(statSpy.mock.calls).toEqual(
        shouldClearBusAddress ? [["/srv/openclaw-runtime/bus"]] : [],
      );
      expect(content.includes("unset DBUS_SESSION_BUS_ADDRESS")).toBe(shouldClearBusAddress);
      expect(content).not.toContain("export XDG_RUNTIME_DIR=");
      expect(content).not.toContain("export DBUS_SESSION_BUS_ADDRESS=");
      await cleanupScript(scriptPath);
    });

    it.each([
      ["abstract transport", "unix:abstract=/openclaw-user-bus"],
      ["path-looking abstract transport", "unix:abstract=/run/user/0/bus"],
      ["multi-address transport", "unix:path=/run/user/0/bus;unix:abstract=/custom-openclaw-bus"],
      ["malformed escaped path", "unix:path=%2Frun%2Fuser%2F0%2Fbus%ZZ"],
    ])("preserves a custom %s when the runtime directory is missing", async (_name, busAddress) => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.geteuid = () => 1000;
      mockLinuxUserBusSocket();

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: "",
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      });

      expect(content).toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
      expect(content).not.toContain("export DBUS_SESSION_BUS_ADDRESS=");
      await cleanupScript(scriptPath);
    });

    it.each([
      ["path first", "unix:path=/run/user/0/bus,guid=0123456789abcdef", "/run/user/0"],
      ["guid first", "unix:guid=0123456789abcdef,path=/run/user/0/bus", "/run/user/0"],
      ["escaped path", "unix:guid=0123456789abcdef,path=%2Frun%2Fuser%2F0%2Fbus", "/run/user/0"],
      ["trailing-slash runtime", "unix:path=/run/user/0/bus", "/run/user/0/"],
      ["missing runtime", "unix:path=/run/user/0/bus", ""],
    ])("repairs the canonical D-Bus bus (%s)", async (_name, address, runtimeDir) => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.geteuid = () => 1000;
      mockLinuxUserBusSocket();

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: address,
      });

      expect(content).toContain("export XDG_RUNTIME_DIR='/run/user/1000'");
      expect(content).toContain("export DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/1000/bus'");
      await cleanupScript(scriptPath);
    });

    it("repairs both missing standard user bus values", async () => {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.geteuid = () => 1000;
      mockLinuxUserBusSocket();
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
      process.geteuid = () => 1000;
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
      process.geteuid = () => 1000;
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
      const victimDir = tempDirs.make("openclaw-restart-helper-victim-");
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
      const tmpDir = tempDirs.make("openclaw-restart-helper-");
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
      const tmpDir = tempDirs.make("openclaw-restart-helper-");
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
      const tmpDir = tempDirs.make("openclaw-restart-helper-");
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

    it("rejects custom macOS launchd labels with shell metacharacters", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      await expect(
        prepareRestartScript({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.$(echo injected)" }),
      ).resolves.toBeNull();
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
      expect(content).toContain(
        'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command - < "%~dpn0.ps1"',
      );
      expect(content).not.toMatch(/Add-Type|Invoke-Expression|\biex\b|-EncodedCommand/iu);
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
      expect(content).not.toMatch(/Add-Type|Invoke-Expression|\biex\b/iu);
      expect(content).toContain("$creationTimeFileTime -= $creationTimeFileTime % 10");
      expect(content).toContain("$heldCreationTime -= $heldCreationTime % 10");
      expect(content).toContain("[void]$lease.Handle");
      expect(content).toContain("Get-OpenClawListenerKillDecision");
      expect(content).toContain("$recheckedListeners = & $ListenerQuery $Port");
      expect(content).toContain("$recheckedProcess = & $ProcessQuery $ProcessId");
      expect(content).toContain("$lease.Kill()");
      expect(content).toContain("$lease.Dispose()");
      expect(content).toContain('return "listener-query-unavailable"');
      expect(content).not.toContain("Stop-Process -Id");
      expect(content).not.toContain("openclaw-gateway(\\.exe)?");
      expect(content).not.toContain("Get-Content -LiteralPath $ScriptPath");
      await cleanupScript(scriptPath);
    });

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
      expect(content).not.toContain("netstat.exe -ano -p tcp | findstr");
      expectWindowsRestartWaitOrdering(content, customPort);
      await cleanupScript(scriptPath);
    });

    it.each([
      ["linux", "production", "openclaw-gateway-production.service"],
      ["darwin", "staging", "gui/502/ai.openclaw.staging"],
      ["win32", "production", "$taskName = 'OpenClaw Gateway (production)'"],
    ])("uses the %s service identity for profile %s", async (platform, profile, expected) => {
      Object.defineProperty(process, "platform", { value: platform });
      if (platform === "darwin") {
        process.getuid = () => 502;
      }
      const { scriptPath, content } = await prepareAndReadScript({ OPENCLAW_PROFILE: profile });
      expect(content).toContain(expected);
      if (platform === "win32") {
        expectWindowsRestartWaitOrdering(content);
      }
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

    it("rejects a launchd label that the lifecycle path cannot use", async () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      process.getuid = () => 501;

      await expect(
        prepareRestartScript({
          HOME: "/Users/testuser",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.it's-a-test",
        }),
      ).resolves.toBeNull();
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
    it.each([
      { platform: "linux", script: "/tmp/fake-script.sh" },
      { platform: "win32", script: "C:\\Temp\\fake-script.bat" },
      { platform: "win32", script: "C:\\Temp\\me&(ow)\\fake-script.bat" },
    ])("observes detached completion for $platform $script", async ({ platform, script }) => {
      Object.defineProperty(process, "platform", { value: platform });
      vi.mocked(spawnCommand).mockResolvedValue({ failed: false } as Awaited<
        ReturnType<typeof spawnCommand>
      >);

      await expect(runRestartScript(script, 1_000)).resolves.toBe(true);

      const argv =
        platform === "win32"
          ? [getWindowsSystem32ExePath("wscript.exe"), "//B", "//Nologo", `${script}.vbs`]
          : ["/bin/sh", script];
      expect(spawnCommand).toHaveBeenCalledWith(argv, {
        detached: true,
        stdio: "ignore",
        timeout: 1_000,
        forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
      });
    });

    it.each([false, true])(
      "does not grant activation on a spawn error (async=%s)",
      async (asyncError) => {
        const error = Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" });
        if (asyncError) {
          vi.mocked(spawnCommand).mockRejectedValue(error);
        } else {
          vi.mocked(spawnCommand).mockImplementation(() => {
            throw error;
          });
        }
        await expect(runRestartScript("/tmp/fake-script.sh", 1_000)).resolves.toBe(false);
      },
    );

    it.skipIf(process.platform === "win32").each([
      { name: "completed activation", body: "exit 0", accepted: true, timeout: 1_000 },
      { name: "native refusal", body: "exit 78", accepted: false, timeout: 1_000 },
      { name: "interrupted activation", body: "kill -TERM $$", accepted: false, timeout: 1_000 },
      { name: "activation timeout", body: "exec sleep 10", accepted: false, timeout: 100 },
    ])("uses the actual process result for $name", async ({ body, accepted, timeout }) => {
      const actual = await vi.importActual<typeof import("../../process/exec-spawn.js")>(
        "../../process/exec-spawn.js",
      );
      vi.mocked(spawnCommand).mockImplementation(actual.spawnCommand);
      const script = path.join(tempDirs.make("openclaw-restart-result-"), "restart.sh");
      await fs.writeFile(script, `#!/bin/sh\n${body}\n`);
      await expect(runRestartScript(script, timeout)).resolves.toBe(accepted);
    });
  });
});
