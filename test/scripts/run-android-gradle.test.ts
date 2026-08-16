import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linuxArmAndroidGradleSkipMessage,
  resolveAndroidSdkEnv,
  run,
  shouldSkipLinuxArmAndroidGradle,
  splitAndroidGradleArgs,
} from "../../scripts/run-android-gradle.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("run-android-gradle", () => {
  it("splits Gradle args from an optional post command", () => {
    expect(
      splitAndroidGradleArgs([":app:installPlayDebug", "--", "adb", "shell", "am", "start"]),
    ).toEqual({
      gradleArgs: [":app:installPlayDebug"],
      postArgs: ["adb", "shell", "am", "start"],
    });
  });

  it("skips Linux ARM hosts by default because AAPT2 is x86_64-only", () => {
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm64", platform: "linux" })).toBe(true);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm", platform: "linux" })).toBe(true);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "x64", platform: "linux" })).toBe(false);
    expect(shouldSkipLinuxArmAndroidGradle({ arch: "arm64", platform: "darwin" })).toBe(false);
  });

  it("allows an explicit Linux ARM override", () => {
    expect(
      shouldSkipLinuxArmAndroidGradle({
        arch: "arm64",
        env: { OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM: "1" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("explains the skip with the override escape hatch", () => {
    expect(linuxArmAndroidGradleSkipMessage("linux", "arm64")).toContain(
      "OPENCLAW_ANDROID_GRADLE_ALLOW_LINUX_ARM=1",
    );
  });

  describe("resolveAndroidSdkEnv", () => {
    const macSdk = path.join("/Users/dev", "Library", "Android", "sdk");
    const linuxSdk = path.join("/home/dev", "Android", "Sdk");

    it("keeps env untouched when ANDROID_HOME or ANDROID_SDK_ROOT is set", () => {
      const env = { ANDROID_HOME: "/opt/sdk" };
      expect(resolveAndroidSdkEnv({ env, existsSync: () => true })).toBe(env);
      const rootEnv = { ANDROID_SDK_ROOT: "/opt/sdk" };
      expect(resolveAndroidSdkEnv({ env: rootEnv, existsSync: () => true })).toBe(rootEnv);
    });

    it("keeps env untouched when local.properties exists", () => {
      const env = {};
      const result = resolveAndroidSdkEnv({
        env,
        existsSync: (p: string) => p.endsWith("local.properties"),
        homeDir: "/Users/dev",
        platform: "darwin",
      });
      expect(result).toBe(env);
    });

    it("falls back to the Android Studio default SDK path per platform", () => {
      const darwin = resolveAndroidSdkEnv({
        env: {},
        existsSync: (p: string) => p === macSdk,
        homeDir: "/Users/dev",
        platform: "darwin",
      });
      expect(darwin.ANDROID_HOME).toBe(macSdk);
      const linux = resolveAndroidSdkEnv({
        env: {},
        existsSync: (p: string) => p === linuxSdk,
        homeDir: "/home/dev",
        platform: "linux",
      });
      expect(linux.ANDROID_HOME).toBe(linuxSdk);
    });

    it("keeps env untouched when no default SDK install exists", () => {
      const env = {};
      const result = resolveAndroidSdkEnv({
        env,
        existsSync: () => false,
        homeDir: "/Users/dev",
        platform: "darwin",
      });
      expect(result).toBe(env);
    });
  });

  posixIt("terminates the active command tree when the wrapper is terminated", async () => {
    const dir = tempDirs.make("openclaw-android-gradle-process-");
    const processTreePath = path.join(dir, "process-tree.json");
    const moduleUrl = pathToFileURL(path.resolve("scripts/run-android-gradle.mts")).href;
    const childSource = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
], { stdio: "ignore" });
fs.writeFileSync(
  process.argv[1],
  JSON.stringify({ childPid: process.pid, descendantPid: descendant.pid }),
);
setInterval(() => {}, 1_000);
`;
    const runnerSource = `
import { run } from ${JSON.stringify(moduleUrl)};
process.exitCode = await run(
  process.execPath,
  ["-e", ${JSON.stringify(childSource)}, ${JSON.stringify(processTreePath)}],
  process.cwd(),
);
`;
    const runner = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", runnerSource],
      { stdio: "ignore" },
    );
    const runnerPid = expectPid(runner.pid);
    let childPid = 0;
    let descendantPid = 0;

    try {
      await waitFor(() => fs.existsSync(processTreePath));
      const processTree = JSON.parse(fs.readFileSync(processTreePath, "utf8")) as {
        childPid: number;
        descendantPid: number;
      };
      childPid = processTree.childPid;
      descendantPid = processTree.descendantPid;
      expect(Number.isInteger(childPid)).toBe(true);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);
      expect(isProcessAlive(descendantPid)).toBe(true);

      process.kill(runnerPid, "SIGTERM");
      const result = await waitForClose(runner);
      await waitFor(() => !isProcessAlive(childPid), 1_500);
      await waitFor(() => !isProcessAlive(descendantPid), 1_500);

      expect(isProcessAlive(childPid)).toBe(false);
      expect(isProcessAlive(descendantPid)).toBe(false);
      expect(result).toEqual({ code: 143, signal: null });
    } finally {
      if (isProcessAlive(runnerPid)) {
        process.kill(runnerPid, "SIGKILL");
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("reports spawn errors and returns a failure status", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const missingCommand = path.join(os.tmpdir(), `openclaw-missing-command-${process.pid}`);
    try {
      await expect(run(missingCommand, [], process.cwd(), {})).resolves.toBe(1);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]?.[0])).toContain("ENOENT");
    } finally {
      error.mockRestore();
    }
  });
});

function expectPid(pid: number | undefined): number {
  if (pid === undefined) {
    throw new Error("expected child process pid");
  }
  return pid;
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

async function waitForClose(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}
