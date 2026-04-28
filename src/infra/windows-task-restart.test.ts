import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));
const resolveTaskScriptPathMock = vi.hoisted(() =>
  vi.fn((env: Record<string, string | undefined>) => {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.join(home, ".openclaw", "gateway.cmd");
  }),
);

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
  });

  it("writes a detached schtasks relaunch helper", () => {
    const unref = vi.fn();
    let seenCommandArg = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenCommandArg = args[3];
      createdScriptPaths.add(decodeCmdPathArg(args[3]));
      return { unref };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result).toMatchObject({
      ok: true,
      method: "schtasks",
      tried: expect.arrayContaining(['schtasks /Run /TN "OpenClaw Gateway (work)"']),
    });
    expect(result.tried).toContain(`cmd.exe /d /s /c ${seenCommandArg}`);
    expect(spawnMock).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", expect.any(String)],
      expect.objectContaining({
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(unref).toHaveBeenCalledOnce();

    const scriptPath = [...createdScriptPaths][0];
    expect(scriptPath).toBeTruthy();
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain("timeout /t 1 /nobreak >nul");
    expect(script).toContain("gateway-restart.log");
    expect(script).toContain(
      'openclaw restart attempt source=windows-task-handoff target="OpenClaw Gateway (work)"',
    );
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (work)" >>');
    expect(script).toContain('del "%~f0" >nul 2>&1');
  });

  it("prefers OPENCLAW_WINDOWS_TASK_NAME overrides", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(args[3]));
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
    });

    const scriptPath = [...createdScriptPaths][0];
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain('schtasks /Run /TN "OpenClaw Gateway (custom)" >>');
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

    expect(spawnMock).toHaveBeenCalledWith(
      "cmd.exe",
      ["/d", "/s", "/c", expect.stringMatching(/^".*&.*"$/)],
      expect.any(Object),
    );
  });

  it("includes startup fallback", () => {
    const taskScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-"));
    createdTmpDirs.add(taskScriptDir);
    const taskScriptPath = path.join(taskScriptDir, "gateway.cmd");
    fs.writeFileSync(taskScriptPath, "@echo off\r\nrem placeholder\r\n", "utf8");
    resolveTaskScriptPathMock.mockReturnValue(taskScriptPath);

    spawnMock.mockImplementation((_file: string, args: string[]) => {
      createdScriptPaths.add(decodeCmdPathArg(args[3]));
      return { unref: vi.fn() };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(true);
    const scriptPath = [...createdScriptPaths][0];
    const script = fs.readFileSync(scriptPath, "utf8");
    expect(script).toContain(`schtasks /Query /TN`);
    expect(script).toContain(":fallback");
    expect(script).toContain(`start "" /min cmd.exe /d /c`);
    expect(script).toContain(taskScriptPath);
  });
});
