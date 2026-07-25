// Ui tests cover ui script behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDirectScriptExecution,
  resolvePnpmSpawnCall,
  resolveSpawnCall,
  shouldUseCmdExeForCommand,
} from "../../scripts/ui.js";

// writeFileSync creates the file before its content lands, so an existence
// poll can observe an empty file on loaded runners; wait for bytes instead.
function readNonEmpty(file: string): string | null {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 3_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("scripts/ui windows spawn behavior", () => {
  it("wraps Windows command launchers with cmd.exe without enabling shell mode", () => {
    expect(
      shouldUseCmdExeForCommand("C:\\Users\\dev\\AppData\\Local\\pnpm\\pnpm.CMD", "win32"),
    ).toBe(true);

    expect(
      resolveSpawnCall(
        "C:\\Program Files\\nodejs\\pnpm.cmd",
        ["run", "build", "-t", "path with spaces"],
        { PATH: "C:\\bin" },
        { comSpec: "C:\\Windows\\System32\\cmd.exe", cwd: "C:\\repo\\ui", platform: "win32" },
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\nodejs\\pnpm.cmd" run build -t "path with spaces""',
      ],
      options: {
        cwd: "C:\\repo\\ui",
        stdio: "inherit",
        env: { PATH: "C:\\bin" },
        shell: false,
        windowsVerbatimArguments: true,
      },
    });
  });

  it("does not use cmd.exe for non-command launchers", () => {
    expect(shouldUseCmdExeForCommand("C:\\Program Files\\nodejs\\node.exe", "win32")).toBe(false);
    expect(shouldUseCmdExeForCommand("C:\\tools\\pnpm.com", "win32")).toBe(false);
    expect(shouldUseCmdExeForCommand("/usr/local/bin/pnpm", "linux")).toBe(false);

    expect(
      resolveSpawnCall(
        "C:\\Program Files\\nodejs\\pnpm.exe",
        ["run", "build"],
        { PATH: "C:\\bin" },
        { cwd: "C:\\repo\\ui", platform: "win32" },
      ),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\pnpm.exe",
      args: ["run", "build"],
      options: {
        cwd: "C:\\repo\\ui",
        stdio: "inherit",
        env: { PATH: "C:\\bin" },
        shell: false,
      },
    });
  });

  it("rejects unsafe cmd.exe arguments before launch", () => {
    expect(() =>
      resolveSpawnCall("C:\\tools\\pnpm.cmd", ["run", "build", "evil&calc"], undefined, {
        platform: "win32",
      }),
    ).toThrow(/unsafe windows cmd\.exe argument/i);
    expect(() =>
      resolveSpawnCall("C:\\tools\\pnpm.cmd", ["run", "build", "%PATH%"], undefined, {
        platform: "win32",
      }),
    ).toThrow(/unsafe windows cmd\.exe argument/i);
  });

  it("uses a trusted cmd.exe path when no explicit Windows launcher is injected", () => {
    expect(
      resolveSpawnCall(
        "C:\\tools\\pnpm.cmd",
        ["run", "build"],
        {
          ComSpec: "C:\\Users\\test\\bin\\cmd.exe",
          SystemRoot: "D:\\Windows",
        },
        { cwd: "C:\\repo\\ui", platform: "win32" },
      ).command,
    ).toBe("D:\\Windows\\System32\\cmd.exe");
  });

  it("routes Windows Corepack pnpm entrypoints through node", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pnpm-runner-"));
    const npmExecPath = path.join(tempDir, "pnpm.mjs");
    fs.writeFileSync(npmExecPath, "console.log('pnpm');\n");

    try {
      expect(
        resolvePnpmSpawnCall(
          ["run", "build"],
          {
            npm_execpath: npmExecPath,
            ComSpec: "C:\\Windows\\System32\\cmd.exe",
          },
          {
            cwd: "C:\\repo\\ui",
            nodeExecPath: "C:\\Program Files\\nodejs\\node.exe",
            platform: "win32",
          },
        ),
      ).toEqual({
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [npmExecPath, "run", "build"],
        options: {
          cwd: "C:\\repo\\ui",
          stdio: "inherit",
          env: {
            npm_execpath: npmExecPath,
            ComSpec: "C:\\Windows\\System32\\cmd.exe",
          },
          shell: false,
          windowsVerbatimArguments: undefined,
        },
      });
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("keeps non-Windows launches direct even with shell metacharacters", () => {
    expect(
      resolveSpawnCall(
        "/usr/local/bin/pnpm",
        ["run", "build", "contains&metacharacters"],
        { PATH: "/bin" },
        { cwd: "/repo/ui", platform: "linux" },
      ),
    ).toEqual({
      command: "/usr/local/bin/pnpm",
      args: ["run", "build", "contains&metacharacters"],
      options: {
        cwd: "/repo/ui",
        stdio: "inherit",
        env: { PATH: "/bin" },
        shell: false,
      },
    });
  });

  it("detects direct execution through a junctioned script path", () => {
    const realScriptPath = path.resolve("repo/openclaw/scripts/ui.js");
    const junctionScriptPath = path.resolve("linked/openclaw/scripts/ui.js");
    const realpath = (entry: string) => (entry === junctionScriptPath ? realScriptPath : entry);

    expect(isDirectScriptExecution(junctionScriptPath, realScriptPath, realpath)).toBe(true);
  });

  it("honors build-all no-pnpm mode before requiring a pnpm runner", () => {
    const result = spawnSync(process.execPath, ["scripts/ui.js", "build", "--help"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BUILD_ALL_NO_PNPM: "1",
        PATH: "",
      },
    });

    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toContain("Missing UI runner");
    expect(output).toContain("vite");
  });

  it.runIf(process.platform !== "win32").each(["SIGTERM", "SIGHUP"] as const)(
    "terminates the pnpm child on wrapper %s",
    async (signal) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-wrapper-signals-"));
      const runnerPath = path.join(tempDir, "pnpm.mjs");
      const readyFile = path.join(tempDir, "ready");
      const signaledFile = path.join(tempDir, "signaled");
      const handlerLines = ["SIGTERM", "SIGHUP"].flatMap((handledSignal) => [
        `process.on('${handledSignal}', () => {`,
        `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
        "  setTimeout(() => process.exit(0), 25);",
        "});",
      ]);

      fs.writeFileSync(
        runnerPath,
        [
          "import fs from 'node:fs';",
          ...handlerLines,
          "fs.writeFileSync(process.env.READY_FILE, process.argv.slice(2).join(' '));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const wrapper = spawn(process.execPath, ["scripts/ui.js", "install"], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          npm_execpath: runnerPath,
          READY_FILE: readyFile,
          SIGNALED_FILE: signaledFile,
        },
        stdio: "ignore",
      });

      try {
        await waitFor(() => readNonEmpty(readyFile) !== null, "UI runner readiness");
        expect(fs.readFileSync(readyFile, "utf8")).toBe("install");
        wrapper.kill(signal);

        const exit = await waitForExit(wrapper);
        expect(exit).toEqual({ code: null, signal });
        expect(fs.readFileSync(signaledFile, "utf8")).toBe(signal);
      } finally {
        wrapper.kill("SIGKILL");
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans pnpm descendants before forwarding wrapper SIGTERM",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-wrapper-tree-"));
      const runnerPath = path.join(tempDir, "pnpm.mjs");
      const readyFile = path.join(tempDir, "ready");
      const descendantPidFile = path.join(tempDir, "descendant.pid");
      let descendantPid: number | undefined;

      fs.writeFileSync(
        runnerPath,
        [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          "fs.writeFileSync(process.env.READY_FILE, 'ready');",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
          "child.unref();",
          "fs.writeFileSync(process.env.DESCENDANT_PID_FILE, String(child.pid));",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const wrapper = spawn(process.execPath, ["scripts/ui.js", "install"], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          DESCENDANT_PID_FILE: descendantPidFile,
          npm_execpath: runnerPath,
          READY_FILE: readyFile,
        },
        stdio: "ignore",
      });

      try {
        await waitFor(
          () => readNonEmpty(descendantPidFile) !== null,
          "UI runner descendant readiness",
        );
        descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });

        wrapper.kill("SIGTERM");
        const exit = await waitForExit(wrapper, 8_000);

        expect(exit).toEqual({ code: null, signal: "SIGTERM" });
        await waitFor(
          () => !descendantPid || !pidAlive(descendantPid),
          "UI runner descendant exit",
        );
      } finally {
        wrapper.kill("SIGKILL");
        if (descendantPid && pidAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
