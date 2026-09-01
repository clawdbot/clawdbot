// Cross-process managed update handoff lease behavior.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const tempDirs = new Set<string>();
const handoffParents = new Map<string, import("node:child_process").ChildProcess>();
const mockedHandoffLeaseCleanups = new Set<() => void>();

function createReadyChild(_command: string, args: string[]) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  process.nextTick(signalMockManagedUpdateHandoffReady, {
    child,
    paramsPath: args.at(-1) ?? "",
    cleanups: mockedHandoffLeaseCleanups,
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

vi.mock("../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: vi.fn(async () => null),
}));

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(createReadyChild);
});

afterEach(async () => {
  for (const parent of handoffParents.values()) {
    parent.stdin?.end();
  }
  handoffParents.clear();
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
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

async function prepareConcurrentHandoffHelper(): Promise<{
  tmpDir: string;
  helperScriptPath: string;
  baseParams: Record<string, unknown>;
}> {
  const { DatabaseSync } = await import("node:sqlite");
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
  const baseParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<
    string,
    unknown
  >;
  const database = new DatabaseSync(String(baseParams.updateLeaseDatabasePath));
  try {
    database
      .prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?")
      .run(String(baseParams.updateLeaseKey), String(baseParams.updateLeaseOwner));
  } finally {
    database.close();
  }
  tempDirs.add(path.dirname(helperScriptPath));
  return { tmpDir, helperScriptPath, baseParams };
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
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
  const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  const parentPid = parent.pid;
  const startIdentity = parentPid ? getFileLockProcessStartTime(parentPid) : null;
  if (!parentPid || startIdentity === null) {
    parent.kill("SIGKILL");
    throw new Error("expected a parent process with a stable start identity");
  }
  const paramsPath = path.join(params.tmpDir, `${params.name}.json`);
  handoffParents.set(paramsPath, parent);
  await fs.writeFile(
    paramsPath,
    `${JSON.stringify(
      {
        ...params.baseParams,
        parentPid,
        parentStartIdentity: String(startIdentity),
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

function driveHandoffProtocol(
  child: import("node:child_process").ChildProcess,
  paramsPath: string,
): void {
  let buffered = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line === "OPENCLAW_UPDATE_HANDOFF_READY") {
        child.stdin?.write("park\n");
      } else if (line === "parked") {
        child.stdin?.write("commit\n");
      } else if (line === "committed") {
        handoffParents.get(paramsPath)?.stdin?.end();
      }
    }
  });
}

async function runHelper(params: {
  execFile: typeof import("node:child_process").execFile;
  helperScriptPath: string;
  paramsPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = params.execFile(
      process.execPath,
      [params.helperScriptPath, params.paramsPath],
      { cwd: params.cwd, encoding: "utf8", ...(params.env ? { env: params.env } : {}) },
      (error, stdout, stderr) => {
        handoffParents.get(params.paramsPath)?.stdin?.end();
        const childError = error as NodeJS.ErrnoException | null;
        resolve({
          code: typeof childError?.code === "number" ? childError.code : 0,
          stdout,
          stderr,
        });
      },
    );
    driveHandoffProtocol(child, params.paramsPath);
  });
}

describe("managed service update handoff cross-process lease", () => {
  it("joins the durable owner reported by a replacement helper", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
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
      parentPid: process.pid,
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

  it.runIf(process.platform !== "win32").each([
    { label: "its exact dead helper", replacement: "exact", reclaimed: true },
    { label: "a mismatched owner", replacement: "owner", reclaimed: false },
    { label: "a mismatched helper identity", replacement: "identity", reclaimed: false },
    { label: "another live process", replacement: "live", reclaimed: false },
    { label: "an unknown malformed process identity", replacement: "unknown", reclaimed: false },
  ] as const)(
    "claims a separate systemd scope helper and fences cancellation against $label",
    async ({ replacement, reclaimed }) => {
      const { DatabaseSync } = await import("node:sqlite");
      const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const {
        cancelManagedServiceUpdateHandoff,
        claimManagedServiceUpdateHandoff,
        startManagedServiceUpdateHandoff,
      } = await import("./update-managed-service-handoff.js");
      const tmpDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-scope-wrapper-")),
      );
      tempDirs.add(tmpDir);
      const helperExitPath = path.join(tmpDir, "nested-helper-exited");
      const launcherPath = path.join(tmpDir, "systemd-run");
      await fs.writeFile(
        launcherPath,
        `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [command, scriptPath, paramsPath] = process.argv.slice(-3);
const helper = spawn(command, [scriptPath, paramsPath], { stdio: ["pipe", "pipe", "ignore"] });
let helperAlive = true;
helper.stdin.on("error", () => {});
helper.stdout.pipe(process.stdout, { end: false });
helper.once("exit", () => {
  helperAlive = false;
  fs.writeFileSync(${JSON.stringify(helperExitPath)}, String(helper.pid));
});
process.stdin.on("data", (chunk) => {
  if (helperAlive) {
    helper.stdin.write(chunk);
  } else if (chunk.toString().includes("cancel\\n")) {
    process.stdout.write("cancelled\\n", () => process.exit(0));
  }
});
`,
        { mode: 0o700 },
      );
      spawnMock.mockImplementationOnce(spawn);

      const handoffId = `scope-wrapper-${replacement}-${path.basename(tmpDir)}`;
      let launcher: import("node:child_process").ChildProcess | undefined;
      let helperPid = 0;
      let leaseDatabasePath: string | undefined;
      let leaseOwner = handoffId;
      try {
        const started = await startManagedServiceUpdateHandoff({
          root: tmpDir,
          restartDrainTimeoutMs: 5_000,
          restartDelayMs: 0,
          parentPid: process.pid,
          execPath: process.execPath,
          argv1: "/opt/openclaw/openclaw.mjs",
          supervisor: "systemd",
          handoffId,
          meta: { handoffId },
          env: {
            OPENCLAW_STATE_DIR: tmpDir,
            PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        });
        if (started.status !== "started" || !started.pid) {
          throw new Error("expected the systemd scope wrapper to start a real handoff");
        }
        launcher = spawnMock.mock.results.at(-1)?.value as
          | import("node:child_process").ChildProcess
          | undefined;
        tempDirs.add(path.dirname(started.logPath));
        const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
        const helperParams = JSON.parse(await fs.readFile(args.at(-1) ?? "", "utf8")) as {
          updateLeaseDatabasePath: string;
          updateLeaseKey: string;
        };
        leaseDatabasePath = helperParams.updateLeaseDatabasePath;
        const identity = {
          kind: "managed-update-handoff" as const,
          handoffId,
          installRoot: started.installRoot,
        };
        const leaseDatabase = new DatabaseSync(leaseDatabasePath);
        let originalRow: { owner: string; payload_json: string };
        try {
          const current = leaseDatabase
            .prepare(
              "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
            )
            .get(helperParams.updateLeaseKey) as
            | { owner: string; payload_json: string }
            | undefined;
          if (!current) {
            throw new Error("expected the nested handoff helper to own its durable lease");
          }
          originalRow = current;
          const helperIdentity = JSON.parse(current.payload_json) as {
            pid: number;
            startIdentity: string;
          };
          helperPid = helperIdentity.pid;

          expect(helperPid).not.toBe(started.pid);
          expect(launcher?.pid).toBe(started.pid);
          expect(isPidAlive(helperPid)).toBe(true);
          expect(claimManagedServiceUpdateHandoff(identity)).toBe(true);

          process.kill(helperPid, "SIGKILL");
          await vi.waitFor(
            async () => {
              await expect(fs.readFile(helperExitPath, "utf8")).resolves.toBe(String(helperPid));
              expect(isPidAlive(helperPid)).toBe(false);
              expect(isPidAlive(started.pid!)).toBe(true);
            },
            { interval: 10, timeout: 5_000 },
          );
          expect(claimManagedServiceUpdateHandoff(identity)).toBe(false);

          let payload = current.payload_json;
          if (replacement === "owner") {
            leaseOwner = `${handoffId}-foreign`;
          } else if (replacement === "identity") {
            payload = JSON.stringify({
              version: 1,
              pid: helperPid,
              startIdentity: `${helperIdentity.startIdentity}-mismatched`,
            });
          } else if (replacement === "live") {
            const liveStartIdentity = getFileLockProcessStartTime(process.pid);
            if (liveStartIdentity === null) {
              throw new Error("expected the live replacement to have a stable process identity");
            }
            payload = JSON.stringify({
              version: 1,
              pid: process.pid,
              startIdentity: String(liveStartIdentity),
            });
          } else if (replacement === "unknown") {
            payload = JSON.stringify({ version: 1, pid: helperPid, startIdentity: null });
          }
          if (replacement !== "exact") {
            leaseDatabase
              .prepare(
                "UPDATE managed_update_handoffs SET owner = ?, payload_json = ? WHERE install_root = ? AND owner = ?",
              )
              .run(leaseOwner, payload, helperParams.updateLeaseKey, handoffId);
            originalRow = { owner: leaseOwner, payload_json: payload };
          }
        } finally {
          leaseDatabase.close();
        }

        await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(
          reclaimed ? "restored-in-process" : false,
        );
        const retained = new DatabaseSync(leaseDatabasePath, { readOnly: true });
        try {
          expect(
            retained
              .prepare(
                "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
              )
              .get(helperParams.updateLeaseKey),
          ).toEqual(reclaimed ? undefined : originalRow!);
        } finally {
          retained.close();
        }
      } finally {
        if (helperPid > 0 && isPidAlive(helperPid)) {
          process.kill(helperPid, "SIGKILL");
        }
        if (launcher?.pid && isPidAlive(launcher.pid)) {
          launcher.kill("SIGKILL");
        }
        if (leaseDatabasePath) {
          const cleanup = new DatabaseSync(leaseDatabasePath);
          try {
            cleanup
              .prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?")
              .run(tmpDir, leaseOwner);
          } finally {
            cleanup.close();
          }
        }
      }
    },
  );

  it.each([
    ["an unavailable parent start identity", null, false],
    ["a reused parent start identity", "0", false],
    ["an existing live owner with a null start identity", "current", true],
  ])("rejects %s before announcing ownership", async (_label, identity, invalidOwner) => {
    const { execFile } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    const { DatabaseSync } = await import("node:sqlite");
    const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
    const markerPath = path.join(tmpDir, "invalid-parent-update-ran");
    const paramsPath = await writeConcurrentHandoffParams({
      tmpDir,
      baseParams,
      name: "invalid-parent",
      owner: "invalid-parent-owner",
      commandArgv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
      ],
    });
    const params = JSON.parse(await fs.readFile(paramsPath, "utf8")) as Record<string, unknown>;
    const currentStartIdentity = getFileLockProcessStartTime(process.pid);
    if (currentStartIdentity === null) {
      throw new Error("expected the live parent to have a stable start identity");
    }
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        ...params,
        parentPid: process.pid,
        parentStartIdentity: identity === "current" ? String(currentStartIdentity) : identity,
      }),
    );
    const leaseDatabasePath = String(params.updateLeaseDatabasePath);
    const leaseKey = String(params.updateLeaseKey);
    const invalidPayload = JSON.stringify({
      version: 1,
      pid: process.pid,
      startIdentity: null,
    });
    const invalidUpdatedAt = Date.now();
    if (invalidOwner) {
      await fs.mkdir(path.dirname(leaseDatabasePath), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(leaseDatabasePath);
      try {
        db.exec(
          "CREATE TABLE IF NOT EXISTS managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
        );
        db.prepare(
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
        ).run(leaseKey, "unverifiable-owner", invalidPayload, invalidUpdatedAt);
      } finally {
        db.close();
      }
      if (process.platform !== "win32") {
        await fs.chmod(leaseDatabasePath, 0o600);
      }
    }
    try {
      const result = await runHelper({ execFile, helperScriptPath, paramsPath, cwd: tmpDir });

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("OPENCLAW_UPDATE_HANDOFF_READY");
      await expect(pathExists(markerPath)).resolves.toBe(false);
      if (await pathExists(leaseDatabasePath)) {
        const db = new DatabaseSync(leaseDatabasePath, { readOnly: true });
        try {
          const row = db
            .prepare(
              "SELECT owner, payload_json, updated_at FROM managed_update_handoffs WHERE install_root = ?",
            )
            .get(leaseKey);
          expect(row).toEqual(
            invalidOwner
              ? {
                  owner: "unverifiable-owner",
                  payload_json: invalidPayload,
                  updated_at: invalidUpdatedAt,
                }
              : undefined,
          );
        } finally {
          db.close();
        }
      }
    } finally {
      if (invalidOwner) {
        const db = new DatabaseSync(leaseDatabasePath);
        db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(leaseKey);
        db.close();
      }
    }
  });

  it("preserves a live durable owner when its current start identity cannot be observed", async () => {
    const { execFile } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { DatabaseSync } = await import("node:sqlite");
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
    const ownerStartIdentity = getFileLockProcessStartTime(process.pid);
    if (ownerStartIdentity === null) {
      throw new Error("expected the live lease owner to have a stable process identity");
    }
    const leaseDatabasePath = String(baseParams.updateLeaseDatabasePath);
    const leaseKey = String(baseParams.updateLeaseKey);
    const owner = "identity-probe-unavailable-owner";
    const payload = JSON.stringify({
      version: 1,
      pid: process.pid,
      startIdentity: String(ownerStartIdentity),
    });
    await fs.mkdir(path.dirname(leaseDatabasePath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(leaseDatabasePath);
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
      );
      database
        .prepare(
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(leaseKey, owner, payload, Date.now());
    } finally {
      database.close();
    }
    if (process.platform !== "win32") {
      await fs.chmod(leaseDatabasePath, 0o600);
    }
    const preloadPath = path.join(tmpDir, "unavailable-owner-identity.cjs");
    await fs.writeFile(
      preloadPath,
      `const fs = require("node:fs");
const childProcess = require("node:child_process");
const ownerPid = ${process.pid};
const readFileSync = fs.readFileSync;
fs.readFileSync = function(filePath, ...args) {
  if (filePath === "/proc/" + ownerPid + "/stat") {
    throw Object.assign(new Error("identity probe unavailable"), { code: "EIO" });
  }
  return readFileSync.call(this, filePath, ...args);
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (args.some((argument) => String(argument).includes(String(ownerPid)))) {
    return { status: null, stdout: "", error: new Error("identity probe unavailable") };
  }
  return spawnSync.call(this, command, args, options);
};
`,
    );
    const markerPath = path.join(tmpDir, "identity-probe-unavailable-updater-ran");
    const paramsPath = await writeConcurrentHandoffParams({
      tmpDir,
      baseParams,
      name: "identity-probe-unavailable",
      owner: "competing-owner",
      commandArgv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
      ],
    });
    try {
      const result = await runHelper({
        execFile,
        helperScriptPath,
        paramsPath,
        cwd: tmpDir,
        env: { ...process.env, NODE_OPTIONS: `--require ${preloadPath}` },
      });

      expect(result, result.stderr).toMatchObject({
        code: 0,
        stdout: expect.stringContaining(`HANDOFF_BUSY ${owner}`),
      });
      const retained = new DatabaseSync(leaseDatabasePath, { readOnly: true });
      try {
        expect(
          retained
            .prepare(
              "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
            )
            .get(leaseKey),
        ).toEqual({ owner, payload_json: payload });
      } finally {
        retained.close();
      }
      await expect(pathExists(markerPath)).resolves.toBe(false);
    } finally {
      const cleanup = new DatabaseSync(leaseDatabasePath);
      cleanup
        .prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?")
        .run(leaseKey, owner);
      cleanup.close();
    }
  });

  it("releases exact helper ownership when cancellation cannot record its terminal sentinel", async () => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { DatabaseSync } = await import("node:sqlite");
    const { tmpDir, helperScriptPath, baseParams } = await prepareConcurrentHandoffHelper();
    const markerPath = path.join(tmpDir, "sentinel-failure-updater-ran");
    const owner = "sentinel-failure-owner";
    const paramsPath = await writeConcurrentHandoffParams({
      tmpDir,
      baseParams,
      name: "sentinel-failure",
      owner,
      commandArgv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
      ],
    });
    const stateDatabasePath = String(baseParams.stateDatabasePath);
    await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
    const stateDb = new DatabaseSync(stateDatabasePath);
    try {
      stateDb.exec(
        [
          "CREATE TABLE gateway_restart_sentinel (",
          "sentinel_key TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL,",
          "kind TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL,",
          "session_key TEXT, thread_id TEXT, delivery_channel TEXT, delivery_to TEXT,",
          "delivery_account_id TEXT, message TEXT, continuation_json TEXT, doctor_hint TEXT,",
          "stats_json TEXT, payload_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL",
          ") STRICT;",
          "CREATE TRIGGER reject_update_sentinel_write",
          "BEFORE INSERT ON gateway_restart_sentinel",
          "WHEN NEW.sentinel_key = 'current'",
          "BEGIN SELECT RAISE(ABORT, 'sentinel write rejected'); END;",
        ].join(" "),
      );
    } finally {
      stateDb.close();
    }
    const leaseDatabasePath = String(baseParams.updateLeaseDatabasePath);
    const leaseKey = String(baseParams.updateLeaseKey);
    const helper = spawn(process.execPath, [helperScriptPath, paramsPath], {
      cwd: tmpDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    helper.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("OPENCLAW_UPDATE_HANDOFF_READY") && !output.includes("cancelled")) {
        helper.stdin.write("cancel\n");
      }
    });
    const exited = new Promise<number | null>((resolve) => {
      helper.once("close", resolve);
    });

    try {
      await expect(exited).resolves.toBe(0);
      expect(output).toContain("cancelled");
      const db = new DatabaseSync(leaseDatabasePath, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root = ?")
            .get(leaseKey),
        ).toBeUndefined();
      } finally {
        db.close();
      }
      const log = await fs.readFile(path.join(tmpDir, "sentinel-failure.log"), "utf8");
      expect(log).toContain("failed to write update sentinel failure");
      expect(log).toContain("sentinel write rejected");
      await expect(pathExists(markerPath)).resolves.toBe(false);
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        helper.kill("SIGKILL");
      }
      const db = new DatabaseSync(leaseDatabasePath);
      db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?").run(
        leaseKey,
        owner,
      );
      db.close();
    }
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
          [
            'const fs = require("node:fs");',
            `const pidPath = ${JSON.stringify(orphanPidPath)};`,
            // File existence signals readiness; never expose an empty PID as a dead updater.
            'fs.writeFileSync(pidPath + ".tmp", String(process.pid));',
            'fs.renameSync(pidPath + ".tmp", pidPath);',
            `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseOrphanPath)})){clearInterval(timer);process.exit(0)}},10);`,
          ].join("\n"),
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
        stdio: ["pipe", "pipe", "pipe"],
      });
      driveHandoffProtocol(first, firstParamsPath);
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
        const orphanPidContents = await fs.readFile(orphanPidPath, "utf8");
        orphanPid = Number(orphanPidContents);
        expect(
          isPidAlive(orphanPid),
          `updater PID bytes: ${JSON.stringify(orphanPidContents)}`,
        ).toBe(true);
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
        await vi.waitFor(() => expect(isPidAlive(orphanPid)).toBe(false), {
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
        if (orphanPid > 0 && isPidAlive(orphanPid)) {
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
        stdio: ["pipe", "pipe", "pipe"],
      });
      driveHandoffProtocol(first, firstParamsPath);
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
