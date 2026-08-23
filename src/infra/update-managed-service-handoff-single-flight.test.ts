// Process-local handoff sharing complements the durable cross-process lease.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const tempRoots = new Set<string>();

function createReadyChild(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
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
  let pid = 24680;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => createReadyChild(pid++));
});

afterEach(async () => {
  const handoffDirs = spawnMock.mock.calls.flatMap((call) => {
    const args = call[1] as string[] | undefined;
    const scriptPath = args?.[0];
    return scriptPath ? [path.dirname(scriptPath)] : [];
  });
  await Promise.all(handoffDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  await Promise.all([...tempRoots].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempRoots.clear();
  vi.resetModules();
});

const baseParams = {
  restartDrainTimeoutMs: 300_000,
  parentPid: 12345,
  execPath: "/usr/local/bin/node",
  argv1: "/opt/openclaw/openclaw.mjs",
};

describe("managed service update handoff single-flight", () => {
  it("shares one same-root helper until its lifecycle ends", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const first = startManagedServiceUpdateHandoff({
      ...baseParams,
      root: "/tmp/openclaw",
      handoffId: "handoff-first",
      meta: { handoffId: "handoff-first" },
    });
    const second = startManagedServiceUpdateHandoff({
      ...baseParams,
      root: "/tmp/openclaw",
      handoffId: "handoff-second",
      meta: { handoffId: "handoff-second" },
    });

    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "started", handoffId: "handoff-first" }),
      expect.objectContaining({ status: "joined", handoffId: "handoff-first" }),
    ]);
    expect(outcomes[1]).not.toHaveProperty("installRoot");
    expect(spawnMock).toHaveBeenCalledOnce();

    const owner = spawnMock.mock.results[0]?.value as ReturnType<typeof createReadyChild>;
    owner.emit("exit", 0, null);
    const next = startManagedServiceUpdateHandoff({
      ...baseParams,
      root: "/tmp/openclaw",
      handoffId: "handoff-next",
      meta: { handoffId: "handoff-next" },
    });

    await expect(next).resolves.toMatchObject({
      status: "started",
      handoffId: "handoff-next",
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const nextOwner = spawnMock.mock.results[1]?.value as ReturnType<typeof createReadyChild>;
    nextOwner.emit("exit", 0, null);
  });

  it("joins canonical aliases while distinct install roots remain independent", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-root-"));
    tempRoots.add(tempDir);
    const root = path.join(tempDir, "install");
    const alias = path.join(tempDir, "install-alias");
    const otherRoot = path.join(tempDir, "other");
    await fs.mkdir(root);
    await fs.mkdir(otherRoot);
    await fs.symlink(root, alias, "dir");
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const owner = await startManagedServiceUpdateHandoff({
      ...baseParams,
      root,
      handoffId: "handoff-root",
      meta: {},
    });
    await expect(
      startManagedServiceUpdateHandoff({ ...baseParams, root: alias, meta: {} }),
    ).resolves.toMatchObject({ status: "joined", handoffId: "handoff-root" });
    const other = await startManagedServiceUpdateHandoff({
      ...baseParams,
      root: otherRoot,
      handoffId: "handoff-other",
      meta: {},
    });

    expect(owner).toMatchObject({
      status: "started",
      handoffId: "handoff-root",
      installRoot: await fs.realpath(root),
    });
    expect(other).toMatchObject({ status: "started", handoffId: "handoff-other" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const result of spawnMock.mock.results) {
      (result.value as ReturnType<typeof createReadyChild>).emit("exit", 0, null);
    }
  });

  it.each([
    ["releases the root for another owner", false, false],
    ["wins a concurrent parent exit without running the updater", true, false],
    ["refuses recovery when another owner replaces the completed helper", false, true],
  ])("cancellation %s", async (_label, exitParent, replaceOwner) => {
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { DatabaseSync } = await import("node:sqlite");
    spawnMock.mockImplementation(spawn);
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cancel-owner-")),
    );
    tempRoots.add(root);
    const markerPath = path.join(root, "updater-ran");
    const updaterPath = path.join(root, "updater.cjs");
    await fs.writeFile(
      updaterPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
    );
    const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const { cancelManagedServiceUpdateHandoff, startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const start = () =>
      startManagedServiceUpdateHandoff({
        root,
        restartDrainTimeoutMs: undefined,
        parentPid: parent.pid,
        execPath: process.execPath,
        argv1: updaterPath,
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        meta: {},
      });
    const started = await start();
    if (started.status !== "started") {
      throw new Error("expected handoff ownership");
    }
    const identity = { kind: "managed-update-handoff" as const, ...started };
    await expect(
      cancelManagedServiceUpdateHandoff({ ...identity, handoffId: "joined" }),
    ).resolves.toBe(false);
    const child = spawnMock.mock.results[0]?.value as import("node:child_process").ChildProcess;
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const helper = JSON.parse(await fs.readFile(args[1] ?? "", "utf8")) as {
      runnerGatePath: string;
      updateLeaseDatabasePath: string;
    };
    let joinedAfterExit: ReturnType<typeof start> | undefined;
    child.once("exit", () => {
      if (!exitParent) {
        joinedAfterExit = start();
      }
      if (replaceOwner) {
        const replacement = new DatabaseSync(helper.updateLeaseDatabasePath);
        replacement
          .prepare(
            "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            root,
            "replacement",
            JSON.stringify({ version: 1, pid: process.pid, startIdentity: null }),
            Date.now(),
          );
        replacement.close();
      }
    });
    const leaseLock = new DatabaseSync(helper.updateLeaseDatabasePath);
    leaseLock.exec("BEGIN IMMEDIATE;");
    const cancellation = cancelManagedServiceUpdateHandoff(identity);
    let completed = false;
    void cancellation.then(() => {
      completed = true;
    });
    await vi.waitFor(async () => {
      await expect(fs.readFile(helper.runnerGatePath, "utf8")).resolves.toBe("cancel");
    });
    if (exitParent) {
      parent.stdin?.end();
    }
    expect(completed).toBe(false);
    expect(child.exitCode).toBeNull();
    leaseLock.exec("COMMIT;");
    leaseLock.close();
    await expect(cancellation).resolves.toBe(!replaceOwner);
    if (joinedAfterExit) {
      await expect(joinedAfterExit).resolves.toMatchObject({
        status: "joined",
        handoffId: started.handoffId,
      });
      expect(spawnMock).toHaveBeenCalledOnce();
    }
    await expect(fs.access(markerPath)).rejects.toThrow();
    if (!replaceOwner && !exitParent) {
      const next = await start();
      if (next.status !== "started") {
        throw new Error("expected replacement ownership");
      }
      await expect(
        cancelManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...next }),
      ).resolves.toBe(true);
    }
    if (replaceOwner) {
      const replacement = new DatabaseSync(helper.updateLeaseDatabasePath);
      replacement.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(root);
      replacement.close();
    }
    parent.stdin?.end();
  });
});
