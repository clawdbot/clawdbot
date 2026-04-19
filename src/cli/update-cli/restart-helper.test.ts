import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("../../../test/helpers/node-builtin-mocks.js");
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

  async function prepareAndReadScript(env: Record<string, string>, gatewayPort = 18789) {
    const scriptPath = await prepareRestartScript(env, gatewayPort);
    expect(scriptPath).toBeTruthy();
    const content = await fs.readFile(scriptPath!, "utf-8");
    return { scriptPath: scriptPath!, content };
  }

  async function cleanupScript(scriptPath: string) {
    await fs.unlink(scriptPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
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
    const endCommand = 'schtasks /End /TN "';
    const pollAttemptsInit = "set /a attempts=0";
    const pollLabel = ":wait_for_port_release";
    const pollAttemptIncrement = "set /a attempts+=1";
    const pollNetstatCheck = `netstat -ano | findstr /R /C:":${port} .*LISTENING" >nul`;
    const forceKillLabel = ":force_kill_listener";
    const forceKillCommand = "taskkill /F /PID %%P >>";
    const portReleasedLabel = ":port_released";
    const runCommand = 'schtasks /Run /TN "';
    const endIndex = content.indexOf(endCommand);
    const attemptsInitIndex = content.indexOf(pollAttemptsInit, endIndex);
    const pollLabelIndex = content.indexOf(pollLabel, attemptsInitIndex);
    const pollAttemptIncrementIndex = content.indexOf(pollAttemptIncrement, pollLabelIndex);
    const pollNetstatCheckIndex = content.indexOf(pollNetstatCheck, pollAttemptIncrementIndex);
    const forceKillLabelIndex = content.indexOf(forceKillLabel, pollNetstatCheckIndex);
    const forceKillCommandIndex = content.indexOf(forceKillCommand, forceKillLabelIndex);
    const portReleasedLabelIndex = content.indexOf(portReleasedLabel, forceKillCommandIndex);
    const runIndex = content.indexOf(runCommand, portReleasedLabelIndex);

    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(attemptsInitIndex).toBeGreaterThan(endIndex);
    expect(pollLabelIndex).toBeGreaterThan(attemptsInitIndex);
    expect(pollAttemptIncrementIndex).toBeGreaterThan(pollLabelIndex);
    expect(pollNetstatCheckIndex).toBeGreaterThan(pollAttemptIncrementIndex);
    expect(forceKillLabelIndex).toBeGreaterThan(pollNetstatCheckIndex);
    expect(forceKillCommandIndex).toBeGreaterThan(forceKillLabelIndex);
    expect(portReleasedLabelIndex).toBeGreaterThan(forceKillCommandIndex);
    expect(runIndex).toBeGreaterThan(portReleasedLabelIndex);

    expect(content).not.toContain("timeout /t 3 /nobreak >nul");
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
      await cleanupScript(scriptPath);
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
      expect(content).toContain('rm -f "$0"');
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
      await writeFakeLaunchctl(
        fakeBinDir,
        `#!/bin/sh
echo "launchctl $*" >&2
case "$1" in
  kickstart) exit 42 ;;
  enable|bootstrap) exit 0 ;;
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

    it("creates a schtasks restart script on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
      });
      expect(scriptPath.endsWith(".bat")).toBe(true);
      expect(content).toContain("@echo off");
      expect(content).toContain("gateway-restart.log");
      expect(content).toContain("openclaw restart attempt source=update target=OpenClaw Gateway");
      expect(content).toContain('schtasks /End /TN "OpenClaw Gateway"');
      expect(content).toContain('schtasks /Run /TN "OpenClaw Gateway" >>');
      expectWindowsRestartWaitOrdering(content);
      // Batch self-cleanup
      expect(content).toContain('del "%~f0"');
      await cleanupScript(scriptPath);
    });

    it("uses OPENCLAW_WINDOWS_TASK_NAME override on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      const { scriptPath, content } = await prepareAndReadScript({
        OPENCLAW_PROFILE: "default",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
      });
      expect(content).toContain('schtasks /End /TN "OpenClaw Gateway (custom)"');
      expect(content).toContain('schtasks /Run /TN "OpenClaw Gateway (custom)"');
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
      expect(content).toContain(`netstat -ano | findstr /R /C:":${customPort} .*LISTENING" >nul`);
      expect(content).toContain(
        `for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":${customPort} .*LISTENING"') do (`,
      );
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
      expect(content).toContain('schtasks /End /TN "OpenClaw Gateway (production)"');
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
      const mockChild = { unref: vi.fn() };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript(scriptPath);

      expect(spawn).toHaveBeenCalledWith("/bin/sh", [scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it("uses cmd.exe on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const scriptPath = "C:\\Temp\\fake-script.bat";
      const mockChild = { unref: vi.fn() };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript(scriptPath);

      expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      expect(mockChild.unref).toHaveBeenCalled();
    });

    it("quotes cmd.exe /c paths with metacharacters on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const scriptPath = "C:\\Temp\\me&(ow)\\fake-script.bat";
      const mockChild = { unref: vi.fn() };
      vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcess);

      await runRestartScript(scriptPath);

      expect(spawn).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", `"${scriptPath}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    });
  });
});
