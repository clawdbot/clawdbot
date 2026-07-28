// Plugin Lifecycle Probe tests cover QA Lab plugin lifecycle evidence.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWindowsTaskkillPath } from "../../../../scripts/lib/windows-taskkill.mjs";
import { createTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  assertInspectLoaded,
  assertUninstalled,
  parseDurationMs,
  testing as probeTesting,
} from "./plugin-lifecycle-probe-runtime.js";

const tempDirs = createTempDirTracker();

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function makeTempDir(): string {
  return tempDirs.make("openclaw-plugin-lifecycle-probe-");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForFile(pathToCheck: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pathToCheck)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`Timed out waiting for ${pathToCheck}`);
}

class FakeCommandChild extends EventEmitter {
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    if (signal === "SIGTERM") {
      queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }
}

afterEach(tempDirs.cleanup);

describe("plugin lifecycle matrix probe", () => {
  it("accepts inspect JSON for an enabled loaded plugin", async () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "loaded" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).not.toThrow();
  });

  it("rejects inspect JSON that does not prove the runtime loaded", async () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "inspect.json");
    writeFileSync(
      inspectPath,
      `${JSON.stringify({ plugin: { enabled: true, id: "lifecycle-claw", status: "pending" } })}\n`,
      "utf8",
    );

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).toThrow(
      "expected lifecycle-claw inspect status loaded, got pending",
    );
  });

  it("rejects missing inspect JSON instead of treating it as an empty object", async () => {
    const dir = makeTempDir();
    const inspectPath = path.join(dir, "missing.json");

    expect(() => assertInspectLoaded("lifecycle-claw", inspectPath)).toThrow(
      `failed to read JSON from ${inspectPath}`,
    );
  });

  it("rejects unreadable config during uninstall proof", async () => {
    const dir = makeTempDir();
    const configFile = path.join(dir, ".openclaw", "openclaw.json");
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, "{ malformed\n", "utf8");

    expect(() =>
      assertUninstalled("lifecycle-claw", {
        HOME: dir,
        OPENCLAW_CONFIG_PATH: configFile,
      }),
    ).toThrow(`failed to read JSON from ${configFile}`);
  });

  it("preserves disabled npm install timeout semantics", () => {
    expect(parseDurationMs("0", "600s")).toBeUndefined();
  });

  it("rejects timed commands that exit cleanly during kill grace", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeCommandChild();
      const runPromise = probeTesting.runCommand("fake-command", ["install"], {
        spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
        timeoutKillGraceMs: 100,
        timeoutMs: 10,
      });
      const runError = runPromise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      const error = await runError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("fake-command install timed out after 10ms");
      expect(child.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(100);
      expect(child.signals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-kills timed Windows commands with taskkill when graceful taskkill fails", async () => {
    vi.useFakeTimers();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const child = Object.assign(new FakeCommandChild(), { pid: 12345 });
      const taskkillImpl = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockImplementationOnce(() => {
          queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
          return { status: 0 };
        });
      const runPromise = probeTesting.runCommand("fake-command", ["install"], {
        spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
        taskkillImpl,
        timeoutKillGraceMs: 100,
        timeoutMs: 10,
      });
      const runError = runPromise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(10);

      expect(taskkillImpl).toHaveBeenNthCalledWith(
        1,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      expect(taskkillImpl).toHaveBeenNthCalledWith(
        2,
        expectedTaskkillPath(),
        ["/PID", "12345", "/T", "/F"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      expect(child.signals).toEqual([]);

      const error = await runError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("fake-command install timed out after 10ms");
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      vi.useRealTimers();
    }
  });

  it("keeps fallback SIGKILL armed for ignored-stdio descendants", async () => {
    if (process.platform === "win32") {
      return;
    }

    const dir = makeTempDir();
    const descendantPidPath = path.join(dir, "descendant.pid");
    let descendantPid: number | undefined;
    try {
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const parentScript = [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        "child.unref();",
        "writeFileSync(process.env.OPENCLAW_TEST_DESCENDANT_PID, String(child.pid));",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const run = probeTesting.runCommand(
        process.execPath,
        ["--input-type=module", "-e", parentScript],
        {
          env: { ...process.env, OPENCLAW_TEST_DESCENDANT_PID: descendantPidPath },
          timeoutKillGraceMs: 100,
          timeoutMs: 500,
        },
      );
      await waitForFile(descendantPidPath, 2_000);

      await expect(run).rejects.toThrow(/timed out after 500ms/u);

      descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
      expect(isProcessRunning(descendantPid)).toBe(false);
    } finally {
      if (descendantPid && isProcessRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });
});
