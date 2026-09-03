// Ui tests cover ui script behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isDirectScriptExecution,
  resolveUiBuildEnvironment,
  resolvePnpmSpawnCall,
  resolveSpawnCall,
  shouldUseCmdExeForCommand,
} from "../../scripts/ui.mts";
import { mergeProcessEnv } from "../../src/infra/process-env.js";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
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
  it("reuses the runtime identity for the documented standalone UI rebuild", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const firstBuild = normalizeControlUiBuildInfo({
      version: "2026.8.1",
      commit,
      builtAt: "2026-08-14T23:00:00.000Z",
    });

    const env = resolveUiBuildEnvironment({
      env: {},
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => firstBuild,
      readGitCommit: () => commit,
      readPackageVersion: () => "2026.8.1",
    });
    const rebuiltUi = normalizeControlUiBuildInfo({
      version: "2026.8.1",
      commit: env.GIT_COMMIT,
      builtAt: env.OPENCLAW_BUILD_TIMESTAMP,
      buildId: env.OPENCLAW_CONTROL_UI_BUILD_ID,
    });

    expect(rebuiltUi).toMatchObject({
      builtAt: firstBuild.builtAt,
      buildId: firstBuild.buildId,
      commit: firstBuild.commit,
      version: firstBuild.version,
    });
  });

  it("does not reuse build info from a different source revision", () => {
    const env = resolveUiBuildEnvironment({
      env: {},
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => ({
        version: "2026.8.1",
        commit: "a".repeat(40),
        builtAt: "2026-08-14T23:00:00.000Z",
      }),
      readGitCommit: () => "b".repeat(40),
      readPackageVersion: () => "2026.8.1",
    });

    expect(env).toMatchObject({
      GIT_COMMIT: "b".repeat(40),
      OPENCLAW_BUILD_TIMESTAMP: "2026-08-14T23:05:00.000Z",
    });
    expect(env.OPENCLAW_CONTROL_UI_BUILD_ID).toBeUndefined();
  });

  it("does not reuse non-release build info for a release UI build", () => {
    const commit = "a".repeat(40);
    const env = resolveUiBuildEnvironment({
      env: { OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1" },
      now: () => new Date("2026-08-14T23:05:00.000Z"),
      readBuildInfo: () => ({
        version: "2026.8.1",
        commit,
        builtAt: "2026-08-14T23:00:00.000Z",
        release: false,
      }),
      readGitCommit: () => commit,
      readPackageVersion: () => "2026.8.1",
    });

    expect(env).toMatchObject({
      GIT_COMMIT: commit,
      OPENCLAW_BUILD_TIMESTAMP: "2026-08-14T23:05:00.000Z",
    });
    expect(env.OPENCLAW_CONTROL_UI_BUILD_ID).toBeUndefined();
  });

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

  it.each(["--help", "-h"])("keeps no-pnpm build %s informational", (helpFlag) => {
    const result = spawnSync(process.execPath, ["scripts/ui.js", "build", helpFlag], {
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
    expect(output).not.toContain("Control UI performance");
  });

  it.each([
    { noPnpm: false, failValidator: null },
    { noPnpm: true, failValidator: null },
    { noPnpm: false, failValidator: "check-control-ui-precompressed-assets.mts" },
    { noPnpm: true, failValidator: "check-control-ui-performance.mts" },
  ])(
    "reports budgets and enforces asset validity off disk caches (noPnpm=$noPnpm, failure=$failValidator)",
    ({ noPnpm, failValidator }) => {
      const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-cache-")));
      const tempRoot = path.join(tempDir, "temp");
      const cacheRoots = ["tsx", `tsx-${process.geteuid?.() ?? os.userInfo().username}`].map(
        (name) => path.join(tempRoot, name),
      );
      const accessLog = path.join(tempDir, "cache-access.log");
      const guard = path.join(tempDir, "cache-guard.cjs");
      const capture = path.join(tempDir, "capture-ui-children.cjs");
      const fixture = path.join(tempDir, "validator.mts");
      const pnpm = path.join(tempDir, "pnpm.cjs");
      const validators = [
        "check-control-ui-precompressed-assets.mts",
        "check-control-ui-performance.mts",
      ];

      try {
        for (const cacheRoot of cacheRoots) {
          fs.mkdirSync(cacheRoot, { recursive: true });
          fs.writeFileSync(path.join(cacheRoot, "0-sentinel"), "keep");
        }
        // Record before throwing: tsx catches some cache errors, so exit status alone
        // cannot prove that the loader left the cache untouched.
        fs.writeFileSync(
          guard,
          `
const fs = require("node:fs");
const path = require("node:path");
const roots = ${JSON.stringify(cacheRoots)};
function guardAccess(target, operation) {
  const resolved = path.resolve(String(target));
  if (roots.some(root => resolved === root || resolved.startsWith(root + path.sep))) {
    fs.appendFileSync(${JSON.stringify(accessLog)}, operation + "\\n");
    throw new Error("Unexpected tsx disk cache access: " + operation);
  }
}
for (const operation of ["readdirSync", "readFileSync", "writeFileSync", "openSync"]) {
  const original = fs[operation];
  fs[operation] = function(target, ...args) {
    guardAccess(target, operation);
    return original.call(this, target, ...args);
  };
}
for (const operation of ["readdir", "readFile", "writeFile", "open", "unlink", "rm", "rmdir", "access"]) {
  const original = fs.promises[operation];
  fs.promises[operation] = async function(target, ...args) {
    guardAccess(target, operation);
    return original.call(this, target, ...args);
  };
}
require("node:module").syncBuiltinESMExports();
`,
        );
        fs.writeFileSync(pnpm, 'throw new Error("build must be intercepted");\n');
        fs.writeFileSync(
          fixture,
          `
enum Transformed { Value = "transformed" }
const validator = process.argv[2];
const reportOnly = process.argv.includes("--report-only");
console.log(JSON.stringify({ validator, transformed: Transformed.Value, reportOnly }));
process.exitCode = validator === ${JSON.stringify(failValidator)} ? 17
  : validator === "check-control-ui-performance.mts" && !reportOnly ? 1 : 0;
`,
        );
        // Run the native launcher, intercept only the build, then replay each real
        // validator command/environment with a tiny transform-required entrypoint.
        fs.writeFileSync(
          capture,
          `
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const spawnSync = childProcess.spawnSync;
const validators = ${JSON.stringify(validators)};
assert.equal(process.env.TSX_DISABLE_CACHE, undefined);
assert.equal(process.env.npm_execpath, ${JSON.stringify(pnpm)});
childProcess.spawnSync = function(command, args, options) {
  if (args[0] === ${JSON.stringify(noPnpm ? path.resolve("node_modules/vite/bin/vite.js") : pnpm)}) {
    assert.deepEqual(args.slice(1), ${JSON.stringify(noPnpm ? ["build"] : ["run", "build"])});
    return { status: 0 };
  }
  const validator = path.basename(args[2]);
  if (!validators.includes(validator)) throw new Error("Unexpected UI subprocess");
  assert.deepEqual(args.slice(3), validator === "check-control-ui-performance.mts" ? ["--report-only"] : []);
  assert.equal(options.env.TSX_DISABLE_CACHE, undefined);
  return spawnSync(command, [...args.slice(0, 2), ${JSON.stringify(fixture)}, validator, ...args.slice(3)], options);
};
require("node:module").syncBuiltinESMExports();
`,
        );
        // A spread can retain NPM_EXECPATH, which wins over npm_execpath on Windows.
        const env = mergeProcessEnv([
          process.env,
          {
            TMPDIR: tempRoot,
            TMP: tempRoot,
            TEMP: tempRoot,
            XDG_CACHE_HOME: path.join(tempDir, "xdg-cache"),
            NODE_COMPILE_CACHE: path.join(tempDir, "node-cache"),
            NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
            OPENCLAW_BUILD_ALL_NO_PNPM: noPnpm ? "1" : "0",
            OPENCLAW_BUILD_TIMESTAMP: "2026-08-27T00:00:00.000Z",
            GIT_COMMIT: "a".repeat(40),
            npm_execpath: pnpm,
            TSX_DISABLE_CACHE: undefined,
            TSX_TSCONFIG_PATH: undefined,
            PNPM_CONFIG_MODULES_DIR: undefined,
            npm_config_modules_dir: undefined,
          },
        ]);

        if (!noPnpm && failValidator === null) {
          const control = spawnSync(process.execPath, ["--import", "tsx", fixture, "control"], {
            cwd: path.resolve("."),
            encoding: "utf8",
            env,
            timeout: 10_000,
          });
          expect(control.error).toBeUndefined();
          expect(fs.readFileSync(accessLog, "utf8")).toContain("readdirSync");
          fs.unlinkSync(accessLog);
        }
        const result = spawnSync(
          process.execPath,
          ["--require", capture, "scripts/ui.js", "build"],
          {
            cwd: path.resolve("."),
            encoding: "utf8",
            env,
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(fs.existsSync(accessLog), result.stderr).toBe(false);
        expect(result.status, result.stderr).toBe(failValidator ? 17 : 0);
        const expectedValidators = failValidator
          ? validators.slice(0, validators.indexOf(failValidator) + 1)
          : validators;
        expect(
          result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toEqual(
          expectedValidators.map((validator) => ({
            validator,
            transformed: "transformed",
            reportOnly: validator === "check-control-ui-performance.mts",
          })),
        );
        for (const cacheRoot of cacheRoots) {
          expect(fs.readdirSync(cacheRoot)).toEqual(["0-sentinel"]);
          expect(fs.readFileSync(path.join(cacheRoot, "0-sentinel"), "utf8")).toBe("keep");
        }
      } finally {
        fs.rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it("keeps the package script on the canonical UI build wrapper", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["ui:build"]).toBe("node scripts/ui.js build");
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
