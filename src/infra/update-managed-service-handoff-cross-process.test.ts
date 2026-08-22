// Cross-process managed update handoff lease behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const tempDirs = new Set<string>();

function createReadyChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 24680,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  process.nextTick(() => {
    child.stdout.write("OPENCLAW_UPDATE_HANDOFF_READY\n");
  });
  return child;
}

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(createReadyChild);
});

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function prepareConcurrentHandoffHelper(): Promise<{
  tmpDir: string;
  helperScriptPath: string;
  baseParams: Record<string, unknown>;
}> {
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-concurrent-test-"));
  tempDirs.add(tmpDir);

  await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    restartDelayMs: 0,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    env: { OPENCLAW_STATE_DIR: tmpDir },
    handoffId: "fixture-handoff",
    meta: { handoffId: "fixture-handoff" },
  });

  const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
  const helperScriptPath = args[0] ?? "";
  tempDirs.add(path.dirname(helperScriptPath));
  return {
    tmpDir,
    helperScriptPath,
    baseParams: JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<string, unknown>,
  };
}

async function writeConcurrentHandoffParams(params: {
  tmpDir: string;
  baseParams: Record<string, unknown>;
  name: string;
  owner: string;
  commandArgv: string[];
  stateDatabasePath?: string;
  leaseDatabasePath?: string;
}): Promise<string> {
  const paramsPath = path.join(params.tmpDir, `${params.name}.json`);
  await fs.writeFile(
    paramsPath,
    `${JSON.stringify(
      {
        ...params.baseParams,
        parentPid: 0,
        parentExitTimeoutMs: 5_000,
        handoffId: params.owner,
        updateLeaseOwner: params.owner,
        ...(params.stateDatabasePath === undefined
          ? {}
          : { stateDatabasePath: params.stateDatabasePath }),
        ...(params.leaseDatabasePath === undefined
          ? {}
          : { updateLeaseDatabasePath: params.leaseDatabasePath }),
        commandArgv: params.commandArgv,
        logPath: path.join(params.tmpDir, `${params.name}.log`),
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );
  return paramsPath;
}

async function runHelper(params: {
  execFile: typeof import("node:child_process").execFile;
  helperScriptPath: string;
  paramsPath: string;
  cwd: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    params.execFile(
      process.execPath,
      [params.helperScriptPath, params.paramsPath],
      { cwd: params.cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        const childError = error as NodeJS.ErrnoException | null;
        resolve({
          code: typeof childError?.code === "number" ? childError.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe("managed service update handoff cross-process lease", () => {
  it("joins the durable owner reported by a replacement helper", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 24681,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      unref: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(child);
    process.nextTick(() => {
      child.stdout.write("HANDOFF_BUSY active-handoff\n");
      setImmediate(() => child.emit("exit", 0, null));
    });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const result = await startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      handoffId: "replacement-handoff",
      meta: { handoffId: "replacement-handoff" },
    });
    tempDirs.add(path.dirname(result.logPath));

    expect(result).toMatchObject({
      status: "joined",
      handoffId: "active-handoff",
      command: "openclaw update --yes",
    });
    expect(result).not.toHaveProperty("pid");
  });

  it.runIf(process.platform === "win32")(
    "reclaims a reused Windows PID with a different creation identity",
    async () => {
      const { execFile } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const sqlite = await import("node:sqlite");
      const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
      const leaseDatabasePath = String(baseParams.updateLeaseDatabasePath);
      const leaseKey = String(baseParams.updateLeaseKey);
      const commandStartedPath = path.join(tmpDir, "windows-reused-pid-started");
      await fs.mkdir(path.dirname(leaseDatabasePath), { recursive: true });
      const db = new sqlite.DatabaseSync(leaseDatabasePath);
      try {
        db.exec(
          "CREATE TABLE IF NOT EXISTS managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
        );
        db.prepare(
          [
            "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at)",
            "VALUES (?, ?, ?, ?)",
            "ON CONFLICT(install_root) DO UPDATE SET owner = excluded.owner, payload_json = excluded.payload_json, updated_at = excluded.updated_at",
          ].join(" "),
        ).run(
          leaseKey,
          "stale-windows-owner",
          JSON.stringify({ version: 1, pid: process.pid, startIdentity: "0" }),
          Date.now(),
        );
      } finally {
        db.close();
      }
      const paramsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "windows-reused-pid",
        owner: "replacement-windows-owner",
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(commandStartedPath)},"started")`,
        ],
      });

      const result = await runHelper({
        execFile,
        helperScriptPath,
        paramsPath,
        cwd: tmpDir,
      });

      expect(result, result.stderr).toMatchObject({
        code: 0,
        stdout: expect.stringContaining("OPENCLAW_UPDATE_HANDOFF_READY"),
      });
      await expect(pathExists(commandStartedPath)).resolves.toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked coordinator directory before running the updater",
    async () => {
      const { execFile } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
      const leaseTarget = path.join(tmpDir, "lease-target");
      const leaseLink = path.join(tmpDir, "lease-link");
      const commandStartedPath = path.join(tmpDir, "unsafe-command-started");
      await fs.mkdir(leaseTarget);
      await fs.symlink(leaseTarget, leaseLink, "dir");
      const paramsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "unsafe-lease-path",
        owner: "unsafe-lease-owner",
        leaseDatabasePath: path.join(leaseLink, "managed-update-handoffs.sqlite"),
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(commandStartedPath)},"started")`,
        ],
      });

      const result = await runHelper({
        execFile,
        helperScriptPath,
        paramsPath,
        cwd: tmpDir,
      });

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("OPENCLAW_UPDATE_HANDOFF_READY");
      await expect(pathExists(commandStartedPath)).resolves.toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a surviving updater owned across helper loss and profiles",
    async () => {
      const { execFile, spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
      const orphanPidPath = path.join(tmpDir, "orphan-pid");
      const secondStartedPath = path.join(tmpDir, "second-started");
      const thirdStartedPath = path.join(tmpDir, "third-started");
      const releaseOrphanPath = path.join(tmpDir, "release-orphan");
      const secondProfileStatePath = path.join(tmpDir, "profile-b", "openclaw.sqlite");
      const firstParamsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "orphan-first",
        owner: "handoff-orphan-first",
        commandArgv: [
          process.execPath,
          "-e",
          `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(orphanPidPath)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseOrphanPath)})){clearInterval(timer);process.exit(0)}},10);`,
        ],
      });
      const secondParamsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "orphan-second",
        owner: "handoff-orphan-second",
        stateDatabasePath: secondProfileStatePath,
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(secondStartedPath)},"started")`,
        ],
      });
      const thirdParamsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "orphan-third",
        owner: "handoff-orphan-third",
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(thirdStartedPath)},"started")`,
        ],
      });

      const first = spawn(process.execPath, [helperScriptPath, firstParamsPath], {
        cwd: tmpDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let firstStdout = "";
      first.stdout.on("data", (chunk) => (firstStdout += chunk));
      let orphanPid = 0;
      try {
        await vi.waitFor(
          async () => {
            expect(firstStdout).toContain("OPENCLAW_UPDATE_HANDOFF_READY");
            await expect(pathExists(orphanPidPath)).resolves.toBe(true);
          },
          { interval: 10, timeout: 5_000 },
        );
        orphanPid = Number(await fs.readFile(orphanPidPath, "utf8"));
        expect(processIsAlive(orphanPid)).toBe(true);
        first.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          first.once("close", () => resolve());
        });

        const second = await runHelper({
          execFile,
          helperScriptPath,
          paramsPath: secondParamsPath,
          cwd: tmpDir,
        });
        expect(second, second.stderr).toMatchObject({
          code: 0,
          stdout: expect.stringContaining("HANDOFF_BUSY handoff-orphan-first"),
        });
        await expect(pathExists(secondStartedPath)).resolves.toBe(false);

        await fs.writeFile(releaseOrphanPath, "release");
        await vi.waitFor(() => expect(processIsAlive(orphanPid)).toBe(false), {
          interval: 20,
          timeout: 5_000,
        });

        const third = await runHelper({
          execFile,
          helperScriptPath,
          paramsPath: thirdParamsPath,
          cwd: tmpDir,
        });
        expect(third, third.stderr).toMatchObject({
          code: 0,
          stdout: expect.stringContaining("OPENCLAW_UPDATE_HANDOFF_READY"),
        });
        await expect(pathExists(thirdStartedPath)).resolves.toBe(true);
      } finally {
        await fs.writeFile(releaseOrphanPath, "release").catch(() => undefined);
        if (first.exitCode === null) {
          first.kill("SIGKILL");
        }
        if (orphanPid > 0 && processIsAlive(orphanPid)) {
          process.kill(orphanPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "serializes detached helpers across Gateway process generations",
    async () => {
      const { execFile, spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
      const firstStartedPath = path.join(tmpDir, "first-started");
      const secondStartedPath = path.join(tmpDir, "second-started");
      const thirdStartedPath = path.join(tmpDir, "third-started");
      const releaseFirstPath = path.join(tmpDir, "release-first");
      const firstParamsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "first",
        owner: "handoff-first",
        commandArgv: [
          process.execPath,
          "-e",
          `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(firstStartedPath)},"started");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFirstPath)})){clearInterval(timer);process.exit(0)}},10);`,
        ],
      });
      const secondParamsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "second",
        owner: "handoff-second",
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(secondStartedPath)},"started")`,
        ],
      });
      const thirdParamsPath = await writeConcurrentHandoffParams({
        tmpDir,
        baseParams,
        name: "third",
        owner: "handoff-third",
        commandArgv: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(thirdStartedPath)},"started")`,
        ],
      });

      const first = spawn(process.execPath, [helperScriptPath, firstParamsPath], {
        cwd: tmpDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let firstStdout = "";
      let firstStderr = "";
      first.stdout.on("data", (chunk) => (firstStdout += chunk));
      first.stderr.on("data", (chunk) => (firstStderr += chunk));
      const firstExit = new Promise<number | null>((resolve) => {
        first.once("close", resolve);
      });

      try {
        await vi.waitFor(
          async () => {
            expect(firstStdout).toContain("OPENCLAW_UPDATE_HANDOFF_READY");
            await expect(pathExists(firstStartedPath)).resolves.toBe(true);
          },
          { interval: 10, timeout: 5_000 },
        );

        const second = await runHelper({
          execFile,
          helperScriptPath,
          paramsPath: secondParamsPath,
          cwd: tmpDir,
        });
        expect(second, second.stderr).toMatchObject({
          code: 0,
          stdout: expect.stringContaining("HANDOFF_BUSY handoff-first"),
        });
        await expect(pathExists(secondStartedPath)).resolves.toBe(false);

        await fs.writeFile(releaseFirstPath, "release");
        await expect(firstExit).resolves.toBe(0);

        const third = await runHelper({
          execFile,
          helperScriptPath,
          paramsPath: thirdParamsPath,
          cwd: tmpDir,
        });
        expect(third, third.stderr).toMatchObject({
          code: 0,
          stdout: expect.stringContaining("OPENCLAW_UPDATE_HANDOFF_READY"),
        });
        await expect(pathExists(thirdStartedPath)).resolves.toBe(true);
      } finally {
        await fs.writeFile(releaseFirstPath, "release").catch(() => undefined);
        if (first.exitCode === null) {
          first.kill("SIGKILL");
        }
      }
    },
  );
});
