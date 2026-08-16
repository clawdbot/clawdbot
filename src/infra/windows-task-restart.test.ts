// Covers Windows scheduled-task gateway restart script generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { decodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));
const resolveTaskScriptPathMock = vi.hoisted(() =>
  vi.fn((env: Record<string, string | undefined>) => {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.join(home, ".openclaw", "gateway.cmd");
  }),
);
// Pin code page detection so hosts with CJK home paths cannot leak the real
// registry OEM probe into script-encoding assertions.
const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => resolvePreferredOpenClawTmpDirMock(),
}));
vi.mock("../daemon/schtasks.js", () => ({
  resolveTaskScriptPath: (env: Record<string, string | undefined>) =>
    resolveTaskScriptPathMock(env),
}));
vi.mock("./windows-encoding.js", async () => {
  const actual =
    await vi.importActual<typeof import("./windows-encoding.js")>("./windows-encoding.js");
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

type WindowsTaskRestartModule = typeof import("./windows-task-restart.js");

let relaunchGatewayScheduledTask: WindowsTaskRestartModule["relaunchGatewayScheduledTask"];

const envSnapshot = captureFullEnv();
const createdScriptPaths = new Set<string>();
const createdTmpDirs = new Set<string>();

function decodeCmdPathArg(value: string): string {
  const trimmed = value.trim();
  const withoutQuotes =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return withoutQuotes.replace(/\^!/g, "!").replace(/%%/g, "%");
}

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

afterEach(() => {
  envSnapshot.restore();
  for (const scriptPath of createdScriptPaths) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup for temp helper scripts created in tests.
    }
  }
  createdScriptPaths.clear();
  for (const tmpDir of createdTmpDirs) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for test temp roots.
    }
  }
  createdTmpDirs.clear();
});

describe("relaunchGatewayScheduledTask", () => {
  beforeAll(async () => {
    ({ relaunchGatewayScheduledTask } = await import("./windows-task-restart.js"));
  });

  beforeEach(() => {
    spawnMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(os.tmpdir());
    resolveTaskScriptPathMock.mockReset();
    resolveTaskScriptPathMock.mockImplementation((env: Record<string, string | undefined>) => {
      const home = env.USERPROFILE || env.HOME || os.homedir();
      return path.join(home, ".openclaw", "gateway.cmd");
    });
    resolveWindowsOemEncodingMock.mockReset();
    resolveWindowsOemEncodingMock.mockReturnValue(null);
  });

  it("writes a detached schtasks relaunch helper", () => {
    const unref = vi.fn();
    let seenCommandArg = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenCommandArg = expectDefined(args[3], "scheduled-task command argument");
      createdScriptPaths.add(decodeCmdPathArg(seenCommandArg));
      return { unref };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });
    const cmdExePath = getWindowsCmdExePath();

    expect(result.ok).toBe(true);
    expect(result.method).toBe("schtasks");
    expect(result.tried).toContain('schtasks /Run /TN "OpenClaw Gateway (work)"');
    expect(result.tried).toContain(`${cmdExePath} /d /s /c ${seenCommandArg}`);
    const spawnCall = requireFirstMockCall(spawnMock, "restart helper spawn");
    expect(spawnCall[0]).toBe(cmdExePath);
    expect(spawnCall[1]).toStrictEqual(["/d", "/s", "/c", seenCommandArg]);
    expect(spawnCall[2]).toStrictEqual({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalledOnce();

    const scriptPath = [...createdScriptPaths][0];
    if (scriptPath === undefined) {
      throw new Error("expected restart helper script path");
    }
    expect(fs.statSync(scriptPath).isFile()).toBe(true);
    const script = fs.readFileSync(scriptPath, "utf8");
    // ASCII helper scripts stay marker-free UTF-8 bytes.
    expect(script.startsWith("@echo off\r\n")).toBe(true);
    expect(script).toContain("timeout /t 1 /nobreak >nul");
    expect(script).toContain("gateway-restart.log");
    expect(script).toContain(
      'openclaw restart attempt source=windows-task-handoff target="OpenClaw Gateway (work)"',
    );
    expect(script).toContain(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$task = Get-ScheduledTask -TaskName 'OpenClaw Gateway (work)' -ErrorAction SilentlyContinue; if ($null -ne $task -and $task.State -eq 'Running') { exit 0 }; exit 1" >nul 2>&1`,
    );
    expect(script).not.toContain("findstr");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (work)" >>');
    expect(script.indexOf("powershell.exe -NoProfile")).toBeLessThan(
      script.indexOf('schtasks /Run /TN "OpenClaw Gateway (work)"'),
    );
    expect(script).toContain('del "%~f0" >nul 2>&1');
  });

  it("prefers OPENCLAW_WINDOWS_TASK_NAME overrides", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
    });

    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (custom)" >>');
  });

  it("escapes custom task names in the PowerShell running-task probe", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (Bob's work)",
    });

    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain(
      `-Command "$task = Get-ScheduledTask -TaskName 'OpenClaw Gateway (Bob''s work)' -ErrorAction SilentlyContinue; if ($null -ne $task -and $task.State -eq 'Running') { exit 0 }; exit 1"`,
    );
    expect(script).not.toContain("findstr");
  });

  it("returns failed when the helper cannot be spawned", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(false);
    expect(result.method).toBe("schtasks");
    expect(result.detail).toContain("spawn failed");
  });

  it("quotes the cmd /c script path when temp paths contain metacharacters", () => {
    const unref = vi.fn();
    const metacharTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw&(restart)-"));
    createdTmpDirs.add(metacharTmpDir);
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(metacharTmpDir);
    spawnMock.mockReturnValue({ unref });

    relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(spawnMock).toHaveBeenCalledOnce();
    const spawnCall = requireFirstMockCall(spawnMock, "restart helper spawn");
    const commandArgs = spawnCall[1];
    if (!Array.isArray(commandArgs)) {
      throw new Error("expected cmd.exe argument array");
    }
    const commandArg = commandArgs[3];
    if (typeof commandArg !== "string") {
      throw new Error("expected quoted restart helper path");
    }
    expect(spawnCall[0]).toBe(getWindowsCmdExePath());
    expect(commandArgs).toStrictEqual(["/d", "/s", "/c", commandArg]);
    expect(commandArg.startsWith('"')).toBe(true);
    expect(commandArg.endsWith('"')).toBe(true);
    expect(commandArg).toContain("&");
    expect(spawnCall[2]).toStrictEqual({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  });

  it("includes startup fallback", () => {
    const taskScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    createdTmpDirs.add(taskScriptDir);
    const taskScriptPath = path.join(taskScriptDir, "gateway.cmd");
    fs.writeFileSync(taskScriptPath, "@echo off\r\nrem placeholder\r\n", "utf8");
    resolveTaskScriptPathMock.mockReturnValue(taskScriptPath);

    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(true);
    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain(`schtasks /Query /TN`);
    expect(script).toContain(":fallback");
    expect(script).toContain(`start "" /min ${getWindowsCmdExePath()} /d /c`);
    expect(script).toContain(taskScriptPath);
  });

  // Pin the host home/state paths embedded in the script to ASCII so the only
  // code-page-sensitive content in the gbk tests is the task name under test;
  // otherwise a non-GBK Windows username (Hangul/Thai/...) fails the encode.
  const asciiPathEnv = {
    HOME: "C:\\ocw-test",
    USERPROFILE: "C:\\ocw-test",
    OPENCLAW_STATE_DIR: "C:\\ocw-test\\state",
  };

  it("writes marked code-page bytes for CJK task names that decode back exactly", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(expectDefined(args[3], "args[3] test invariant")));
      return { unref: vi.fn() };
    });

    const result = relaunchGatewayScheduledTask({
      ...asciiPathEnv,
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (隆)",
    });

    expect(result.ok).toBe(true);
    const scriptPath = expectDefined(
      [...createdScriptPaths][0],
      "[...createdScriptPaths][0] test invariant",
    );
    const raw = fs.readFileSync(scriptPath);
    expect(
      raw
        .toString("latin1")
        .startsWith("@chcp 936 >nul\r\n@rem openclaw-launcher-encoding=gbk\r\n"),
    ).toBe(true);
    // The old raw-UTF-8 writer would have kept the task name readable here.
    expect(raw.toString("utf8")).not.toContain("隆");
    const script = decodeWindowsLauncherScript({ buffer: raw });
    expect(script.startsWith("@echo off\r\n")).toBe(true);
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (隆)" >>');
    expect(script).toContain('del "%~f0" >nul 2>&1');
  });

  it("returns failed instead of writing an unrepresentable helper script", () => {
    resolveWindowsOemEncodingMock.mockReturnValue("gbk");
    spawnMock.mockImplementation(() => {
      throw new Error("spawn should not be reached");
    });

    const result = relaunchGatewayScheduledTask({
      ...asciiPathEnv,
      OPENCLAW_WINDOWS_TASK_NAME: "🚀",
    });

    expect(result.ok).toBe(false);
    expect(result.method).toBe("schtasks");
    expect(result.detail).toMatch(/cannot be represented/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
