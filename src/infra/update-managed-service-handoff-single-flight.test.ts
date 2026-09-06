// Process-local handoff sharing complements the durable cross-process lease.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  signalMockManagedUpdateHandoffReady,
  type MockManagedUpdateHandoffLeaseFailure,
} from "./update-managed-service-handoff.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());
const forceKillChildProcessTreeMock = vi.hoisted(() => vi.fn());
const findInstalledSystemdGatewayScopeMock = vi.hoisted(() =>
  vi.fn(
    async (_env: NodeJS.ProcessEnv) =>
      null as {
        scope: "user" | "system";
        unitName: string;
        unitPath: string;
      } | null,
  ),
);
// The coordinator must outlive mocked lease cleanup in afterEach.
const tempRoots = createTempDirTracker();
const mockedHandoffLeaseCleanups = new Set<() => void>();
const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-single-flight-${process.pid}`);

function createReadyChild(
  pid: number,
  paramsPath: string,
  failure?: MockManagedUpdateHandoffLeaseFailure,
) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  process.nextTick(() => {
    signalMockManagedUpdateHandoffReady({
      child,
      paramsPath,
      cleanups: mockedHandoffLeaseCleanups,
      ...(child.pid === process.pid ? {} : { startIdentity: 17 }),
      failure,
    });
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
  findInstalledSystemdGatewayScope: findInstalledSystemdGatewayScopeMock,
}));

vi.mock("../process/child-process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: forceKillChildProcessTreeMock,
}));

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

beforeEach(async () => {
  // Competing helpers share this fixture's coordinator, never the operator's database.
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(
    tempRoots.make("openclaw-handoff-coordinator-"),
  );
  let pid = 24680;
  const liveChildren = new Set<number>();
  const processIdentity = await import("../shared/pid-alive.js");
  const parentStartIdentity = processIdentity.getFileLockProcessStartTime(process.pid);
  vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((targetPid) =>
    targetPid === process.pid ? parentStartIdentity : liveChildren.has(targetPid) ? 17 : null,
  );
  vi.spyOn(processIdentity, "isPidAlive").mockImplementation(
    (targetPid) => targetPid === process.pid || liveChildren.has(targetPid),
  );
  forceKillChildProcessTreeMock.mockReset();
  forceKillChildProcessTreeMock.mockImplementation((child: ReturnType<typeof createReadyChild>) => {
    child.stdout.destroy();
  });
  findInstalledSystemdGatewayScopeMock.mockReset();
  findInstalledSystemdGatewayScopeMock.mockResolvedValue(null);
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = createReadyChild(pid++, args.at(-1) ?? "");
    liveChildren.add(child.pid);
    child.once("exit", () => liveChildren.delete(child.pid));
    return child;
  });
});

afterEach(async () => {
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  const handoffDirs = spawnMock.mock.calls.flatMap((call) => {
    const args = call[1] as string[] | undefined;
    const scriptPath = args?.[0];
    return scriptPath ? [path.dirname(scriptPath)] : [];
  });
  await Promise.all(handoffDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempRoots.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

const baseParams = {
  restartDrainTimeoutMs: 300_000,
  parentPid: process.pid,
  execPath: "/usr/local/bin/node",
  argv1: "/opt/openclaw/openclaw.mjs",
};

describe("managed service update handoff single-flight", () => {
  it.each([false, true])(
    "awaits the pre-park notice and rechecks helper ownership (lost: %s)",
    async (lost) => {
      const { requestManagedServiceUpdateHandoffPark, startManagedServiceUpdateHandoff } =
        await import("./update-managed-service-handoff.js");
      const entered = createDeferredCore();
      const delivered = createDeferredCore();
      const started = await startManagedServiceUpdateHandoff({
        ...baseParams,
        root: `${MOCK_INSTALL_ROOT}-notice-${lost}`,
        meta: {},
        beforePark: async () => {
          entered.resolve();
          await delivered.promise;
        },
      });
      if (started.status !== "started") {
        throw new Error("expected helper ownership");
      }
      const child = spawnMock.mock.results[0]?.value as ReturnType<typeof createReadyChild>;
      const commands: string[] = [];
      child.stdin.on("data", (chunk: Buffer) => {
        commands.push(chunk.toString());
        child.stdout.write("parked\n");
      });
      const park = requestManagedServiceUpdateHandoffPark({
        kind: "managed-update-handoff",
        ...started,
      });
      await entered.promise;
      expect(commands).toEqual([]);
      if (lost) {
        child.emit("exit", 0, null);
      }
      delivered.resolve();
      await expect(park).resolves.toBe(!lost);
      expect(commands).toEqual(lost ? [] : ["park\n"]);
      if (!lost) {
        child.emit("exit", 0, null);
      }
    },
  );
  it.each([
    ["does not exist", "absent"],
    ["has malformed helper identity", "malformed"],
    ["belongs to a different owner", "wrong-owner"],
    ["identifies a dead helper", "dead-helper"],
  ] as const)("rejects READY when the durable helper lease %s", async (_label, failure) => {
    spawnMock.mockImplementationOnce((_command: string, args: string[]) =>
      createReadyChild(process.pid, args.at(-1) ?? "", failure),
    );
    const { claimManagedServiceUpdateHandoff, startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const identity = {
      kind: "managed-update-handoff" as const,
      handoffId: `invalid-ready-${failure}`,
      installRoot: `${MOCK_INSTALL_ROOT}-${failure}`,
    };

    await expect(
      startManagedServiceUpdateHandoff({
        ...baseParams,
        root: identity.installRoot,
        handoffId: identity.handoffId,
        meta: {},
      }),
    ).rejects.toThrow(/lease|helper|identity/u);

    const child = spawnMock.mock.results[0]?.value as ReturnType<typeof createReadyChild>;
    expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    expect(child.unref).not.toHaveBeenCalled();
    expect(claimManagedServiceUpdateHandoff(identity)).toBe(false);
  });

  it("rejects system-scope systemd before spawning or reserving handoff ownership", async () => {
    findInstalledSystemdGatewayScopeMock.mockResolvedValueOnce({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
    const { claimManagedServiceUpdateHandoff, startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const root = `${MOCK_INSTALL_ROOT}-system-scope`;

    await expect(
      startManagedServiceUpdateHandoff({
        ...baseParams,
        root,
        handoffId: "system-handoff",
        supervisor: "systemd",
        env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
        meta: {},
      }),
    ).rejects.toThrow(/user-scope systemd unit.*manual system-service update/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(
      claimManagedServiceUpdateHandoff({
        kind: "managed-update-handoff",
        handoffId: "system-handoff",
        installRoot: root,
      }),
    ).toBe(false);

    await expect(
      startManagedServiceUpdateHandoff({ ...baseParams, root, meta: {} }),
    ).resolves.toMatchObject({ status: "started" });
    expect(spawnMock).toHaveBeenCalledOnce();
    const owner = spawnMock.mock.results[0]?.value as ReturnType<typeof createReadyChild>;
    owner.emit("exit", 0, null);
  });

  it("shares one same-root helper until its lifecycle ends", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const first = startManagedServiceUpdateHandoff({
      ...baseParams,
      root: MOCK_INSTALL_ROOT,
      handoffId: "handoff-first",
      meta: { handoffId: "handoff-first" },
    });
    const second = startManagedServiceUpdateHandoff({
      ...baseParams,
      root: MOCK_INSTALL_ROOT,
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
      root: MOCK_INSTALL_ROOT,
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

  it.each([
    ["has exited before its ChildProcess notification", "dead"],
    ["reuses its PID for another process", "reused"],
    ["no longer exposes its process start identity", "unknown"],
  ])("rejects a helper claim when its operating-system process %s", async (_label, failure) => {
    vi.restoreAllMocks();
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementation(spawn);
    const processIdentity = await import("../shared/pid-alive.js");
    const root = await fs.realpath(tempRoots.make("openclaw-helper-process-identity-"));
    const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    try {
      const {
        cancelManagedServiceUpdateHandoff,
        claimManagedServiceUpdateHandoff,
        startManagedServiceUpdateHandoff,
        transferManagedServiceUpdateHandoff,
      } = await import("./update-managed-service-handoff.js");
      const started = await startManagedServiceUpdateHandoff({
        root,
        restartDrainTimeoutMs: 300_000,
        parentPid: parent.pid,
        execPath: process.execPath,
        argv1: process.argv[1],
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        meta: {},
      });
      if (started.status !== "started" || !started.pid) {
        throw new Error("expected real detached handoff ownership");
      }
      const identity = { kind: "managed-update-handoff" as const, ...started };
      expect(claimManagedServiceUpdateHandoff(identity)).toBe(true);
      await expect(transferManagedServiceUpdateHandoff(identity)).resolves.toBe(true);
      if (failure === "dead") {
        vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(false);
      } else {
        const helperStartIdentity = processIdentity.getFileLockProcessStartTime(started.pid);
        if (helperStartIdentity === null) {
          throw new Error("expected the real detached helper to have a process identity");
        }
        vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(
          failure === "reused" ? helperStartIdentity + 1 : null,
        );
      }
      expect(claimManagedServiceUpdateHandoff(identity)).toBe(false);
      vi.restoreAllMocks();
      await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(
        "restored-in-process",
      );
    } finally {
      vi.restoreAllMocks();
      parent.stdin?.end();
    }
  });

  it("terminates the exact helper when its initial start identity is unavailable", async () => {
    const processIdentity = await import("../shared/pid-alive.js");
    vi.mocked(processIdentity.getFileLockProcessStartTime)
      .mockReturnValueOnce(17)
      .mockReturnValueOnce(null);
    const { claimManagedServiceUpdateHandoff, startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const identity = {
      kind: "managed-update-handoff" as const,
      handoffId: "identity-unavailable",
      installRoot: `${MOCK_INSTALL_ROOT}-identity-unavailable`,
    };

    await expect(
      startManagedServiceUpdateHandoff({
        ...baseParams,
        root: identity.installRoot,
        handoffId: identity.handoffId,
        meta: {},
      }),
    ).rejects.toThrow("process start identity is unavailable");

    const child = spawnMock.mock.results[0]?.value as ReturnType<typeof createReadyChild>;
    expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    expect(child.unref).not.toHaveBeenCalled();
    expect(claimManagedServiceUpdateHandoff(identity)).toBe(false);
  });

  it("reclaims only its exact dead detached helper before reopening the install root", async () => {
    vi.restoreAllMocks();
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { DatabaseSync } = await import("node:sqlite");
    const processIdentity = await import("../shared/pid-alive.js");
    const { getFileLockProcessStartTime } = processIdentity;
    spawnMock.mockImplementation(spawn);
    const root = await fs.realpath(tempRoots.make("openclaw-dead-handoff-owner-"));
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
    let leaseDatabasePath: string | undefined;
    let deadOwner: string | undefined;
    let replacement: Awaited<ReturnType<typeof startManagedServiceUpdateHandoff>> | undefined;
    try {
      const start = () =>
        startManagedServiceUpdateHandoff({
          root,
          restartDrainTimeoutMs: 300_000,
          parentPid: parent.pid,
          execPath: process.execPath,
          argv1: updaterPath,
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
          meta: {},
        });
      const started = await start();
      if (started.status !== "started" || !started.pid) {
        throw new Error("expected real detached handoff ownership");
      }
      deadOwner = started.handoffId;
      const helperStartIdentity = getFileLockProcessStartTime(started.pid);
      if (helperStartIdentity === null) {
        throw new Error("expected the detached helper to have a stable process identity");
      }
      const helper = spawnMock.mock.results[0]?.value as import("node:child_process").ChildProcess;
      const [, args] = spawnMock.mock.calls[0] as [string, string[]];
      leaseDatabasePath = (
        JSON.parse(await fs.readFile(args[1] ?? "", "utf8")) as {
          updateLeaseDatabasePath: string;
        }
      ).updateLeaseDatabasePath;
      const readLease = () => {
        const db = new DatabaseSync(leaseDatabasePath!, { readOnly: true });
        try {
          return db
            .prepare(
              "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
            )
            .get(root) as { owner: string; payload_json: string } | undefined;
        } finally {
          db.close();
        }
      };
      const initialLease = readLease();
      expect(initialLease?.owner).toBe(started.handoffId);
      expect(JSON.parse(initialLease?.payload_json ?? "null")).toEqual({
        version: 1,
        pid: started.pid,
        startIdentity: String(helperStartIdentity),
      });

      const helperExited = new Promise<void>((resolve) => {
        helper.once("exit", () => resolve());
      });
      helper.kill("SIGKILL");
      await helperExited;
      expect(readLease()).toEqual(initialLease);

      const ownStartIdentity = getFileLockProcessStartTime(process.pid);
      if (ownStartIdentity === null || !initialLease) {
        throw new Error("expected complete live-parent and dead-helper lease identities");
      }
      const originalPayload = {
        version: 1,
        pid: started.pid,
        startIdentity: String(helperStartIdentity),
      };
      const rejectedOwners = [
        {
          label: "replacement owner",
          owner: "replacement-owner",
          payload: originalPayload,
        },
        {
          label: "different live process",
          owner: started.handoffId,
          payload: {
            ...originalPayload,
            pid: process.pid,
            startIdentity: String(ownStartIdentity),
          },
        },
        {
          label: "different recorded start identity",
          owner: started.handoffId,
          payload: { ...originalPayload, startIdentity: `${helperStartIdentity}-reused` },
        },
        {
          label: "malformed process identity",
          owner: started.handoffId,
          payload: { ...originalPayload, startIdentity: null },
        },
        {
          label: "noncanonical process identity",
          owner: started.handoffId,
          payload: { ...originalPayload, unexpected: true },
        },
      ];
      const writeLease = (owner: string, payload: unknown) => {
        if (!leaseDatabasePath) {
          throw new Error("expected the detached helper lease database path");
        }
        const db = new DatabaseSync(leaseDatabasePath);
        try {
          db.prepare(
            "UPDATE managed_update_handoffs SET owner = ?, payload_json = ? WHERE install_root = ?",
          ).run(owner, JSON.stringify(payload), root);
        } finally {
          db.close();
        }
      };
      const identity = { kind: "managed-update-handoff" as const, ...started };
      for (const rejected of rejectedOwners) {
        writeLease(rejected.owner, rejected.payload);
        await expect(cancelManagedServiceUpdateHandoff(identity), rejected.label).resolves.toBe(
          false,
        );
        expect(readLease(), rejected.label).toEqual({
          owner: rejected.owner,
          payload_json: JSON.stringify(rejected.payload),
        });
      }
      writeLease(started.handoffId, originalPayload);
      const unknownDeath = vi.spyOn(processIdentity, "isPidDefinitelyDead").mockReturnValue(false);
      await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(false);
      expect(readLease()).toEqual(initialLease);
      unknownDeath.mockRestore();

      await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(
        "restored-in-process",
      );
      expect(readLease()).toBeUndefined();
      await expect(fs.access(markerPath)).rejects.toThrow();

      replacement = await start();
      if (replacement.status !== "started") {
        throw new Error("expected cancellation to reopen the install root");
      }
      expect(replacement.installRoot).toBe(root);
      expect(replacement.handoffId).not.toBe(started.handoffId);
      await expect(
        cancelManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...replacement }),
      ).resolves.toBe("restored-in-process");
      replacement = undefined;
      expect(readLease()).toBeUndefined();
      await expect(fs.access(markerPath)).rejects.toThrow();
    } finally {
      if (replacement?.status === "started") {
        await cancelManagedServiceUpdateHandoff({
          kind: "managed-update-handoff",
          ...replacement,
        });
      }
      if (leaseDatabasePath && deadOwner) {
        const db = new DatabaseSync(leaseDatabasePath);
        db.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?").run(
          root,
          deadOwner,
        );
        db.close();
      }
      parent.stdin?.end();
    }
  });

  it("admits another update after a transferred no-op leaves the Gateway serving", async () => {
    vi.restoreAllMocks();
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementation(spawn);
    const root = await fs.realpath(tempRoots.make("openclaw-handoff-noop-"));
    const updaterPath = path.join(root, "updater.cjs");
    await fs.writeFile(
      updaterPath,
      `process.stdout.write(JSON.stringify({root:${JSON.stringify(root)},status:"skipped",mode:"npm",reason:"already-current"}));`,
    );
    const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const { startManagedServiceUpdateHandoff, transferManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const started = await startManagedServiceUpdateHandoff({
          root,
          restartDrainTimeoutMs: 300_000,
          parentPid: parent.pid,
          execPath: process.execPath,
          argv1: updaterPath,
          env: { ...process.env, OPENCLAW_STATE_DIR: root },
          meta: {},
        });
        expect(started.status).toBe("started");
        if (started.status !== "started") {
          throw new Error("completed no-op retained its owner");
        }
        const child = spawnMock.mock.results.at(-1)
          ?.value as import("node:child_process").ChildProcess;
        const exited = new Promise<number | null>((resolve) => {
          child.once("close", resolve);
        });
        await expect(
          transferManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...started }),
        ).resolves.toBe(true);
        expect(await exited).toBe(0);
        expect(parent.exitCode).toBeNull();
        expect(parent.signalCode).toBeNull();
      }
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      parent.stdin?.end();
    }
  });

  it("waits for the exact helper to release its lease after an immediate control-pipe EPIPE", async () => {
    vi.restoreAllMocks();
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { DatabaseSync } = await import("node:sqlite");
    spawnMock.mockImplementation(spawn);
    const root = await fs.realpath(tempRoots.make("openclaw-handoff-control-epipe-"));
    const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const {
      cancelManagedServiceUpdateHandoff,
      requestManagedServiceUpdateHandoffPark,
      startManagedServiceUpdateHandoff,
    } = await import("./update-managed-service-handoff.js");
    const started = await startManagedServiceUpdateHandoff({
      root,
      restartDrainTimeoutMs: 300_000,
      parentPid: parent.pid,
      execPath: process.execPath,
      argv1: process.argv[1],
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      meta: {},
    });
    if (started.status !== "started") {
      throw new Error("expected real detached helper ownership");
    }
    const identity = { kind: "managed-update-handoff" as const, ...started };
    const helper = spawnMock.mock.results[0]?.value as import("node:child_process").ChildProcess;
    const input = helper.stdin;
    if (!input) {
      throw new Error("expected the detached helper control pipe");
    }
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const { updateLeaseDatabasePath } = JSON.parse(await fs.readFile(args[1] ?? "", "utf8")) as {
      updateLeaseDatabasePath: string;
    };
    let controlDestroyed = false;
    const destroyed = vi
      .spyOn(input, "destroyed", "get")
      .mockImplementation(() => controlDestroyed);
    const write = vi.spyOn(input, "write").mockImplementation(((
      _chunk: unknown,
      callback: unknown,
    ) => {
      controlDestroyed = true;
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      if (typeof callback === "function") {
        callback(error);
      }
      input.emit("error", error);
      return false;
    }) as typeof input.write);

    try {
      await expect(requestManagedServiceUpdateHandoffPark(identity)).resolves.toBe(false);
      expect(helper.exitCode).toBeNull();
      let cancellationSettled = false;
      const cancellation = cancelManagedServiceUpdateHandoff(identity).then((result) => {
        cancellationSettled = true;
        return result;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(cancellationSettled).toBe(false);
      expect(helper.exitCode).toBeNull();
      write.mockRestore();
      destroyed.mockRestore();
      input.end();

      await expect(cancellation).resolves.toBe("restored-in-process");
      expect(helper.exitCode !== null || helper.signalCode !== null).toBe(true);
      const database = new DatabaseSync(updateLeaseDatabasePath, { readOnly: true });
      try {
        expect(
          database
            .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root = ?")
            .get(root),
        ).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      write.mockRestore();
      destroyed.mockRestore();
      input.end();
      parent.stdin?.end();
    }
  });

  it("joins canonical aliases while distinct install roots remain independent", async () => {
    const tempDir = tempRoots.make("openclaw-handoff-root-");
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
    ["releases the root for another owner", false, false, false, false],
    ["retains a claimed exited owner until release is confirmed", false, false, true, false],
    ["treats control-pipe disconnect as cancellation", false, false, true, true],
    ["wins a concurrent parent exit without running the updater", true, false, false, false],
    ["refuses recovery when another owner replaces the completed helper", false, true, true, false],
  ])("cancellation %s", async (_label, exitParent, replaceOwner, claimBeforeExit, disconnect) => {
    vi.restoreAllMocks();
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { DatabaseSync } = await import("node:sqlite");
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    const replacementStartIdentity = getFileLockProcessStartTime(process.pid);
    if (replacementStartIdentity === null) {
      throw new Error("expected the replacement owner to have a stable process identity");
    }
    spawnMock.mockImplementation(spawn);
    const root = await fs.realpath(tempRoots.make("openclaw-cancel-owner-"));
    const markerPath = path.join(root, "updater-ran");
    const updaterPath = path.join(root, "updater.cjs");
    await fs.writeFile(
      updaterPath,
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
    );
    const parent = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const {
      cancelManagedServiceUpdateHandoff,
      claimManagedServiceUpdateHandoff,
      startManagedServiceUpdateHandoff,
    } = await import("./update-managed-service-handoff.js");
    const start = () =>
      startManagedServiceUpdateHandoff({
        root,
        restartDrainTimeoutMs: 300_000,
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
    if (claimBeforeExit) {
      expect(claimManagedServiceUpdateHandoff(identity)).toBe(true);
      expect(claimManagedServiceUpdateHandoff(identity)).toBe(true);
    }
    await expect(
      cancelManagedServiceUpdateHandoff({ ...identity, handoffId: "joined" }),
    ).resolves.toBe(false);
    const child = spawnMock.mock.results[0]?.value as import("node:child_process").ChildProcess;
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const helper = JSON.parse(await fs.readFile(args[1] ?? "", "utf8")) as {
      updateLeaseDatabasePath: string;
      stateDatabasePath: string;
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
            JSON.stringify({
              version: 1,
              pid: process.pid,
              startIdentity: String(replacementStartIdentity),
            }),
            Date.now(),
          );
        replacement.close();
      }
    });
    let cancellation: ReturnType<typeof cancelManagedServiceUpdateHandoff>;
    if (claimBeforeExit) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      if (disconnect) {
        child.stdin?.end();
      } else {
        child.stdin?.write("cancel\n");
      }
      await exited;
      expect(claimManagedServiceUpdateHandoff(identity)).toBe(false);
      expect(joinedAfterExit).toBeDefined();
      cancellation = cancelManagedServiceUpdateHandoff(identity);
    } else {
      cancellation = cancelManagedServiceUpdateHandoff(identity);
      if (exitParent) {
        parent.stdin?.end();
      }
    }
    await expect(cancellation).resolves.toBe(replaceOwner ? false : "restored-in-process");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    const sentinel = new DatabaseSync(helper.stateDatabasePath, { readOnly: true });
    const terminal = sentinel
      .prepare("SELECT payload_json FROM gateway_restart_sentinel WHERE sentinel_key = 'current'")
      .get() as { payload_json: string };
    sentinel.close();
    expect(JSON.parse(terminal.payload_json)).toMatchObject({
      status: "skipped",
      stats: { reason: "managed-service-handoff-cancelled" },
    });
    if (joinedAfterExit) {
      await expect(joinedAfterExit).resolves.toMatchObject({
        status: "joined",
        handoffId: started.handoffId,
      });
      expect(spawnMock).toHaveBeenCalledOnce();
    }
    await expect(fs.access(markerPath)).rejects.toThrow();
    if (!replaceOwner && !exitParent) {
      const priorSentinel = new DatabaseSync(helper.stateDatabasePath);
      priorSentinel
        .prepare("DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'")
        .run();
      priorSentinel.close();
      const next = await start();
      if (next.status !== "started") {
        throw new Error("expected replacement ownership");
      }
      await expect(
        cancelManagedServiceUpdateHandoff({ kind: "managed-update-handoff", ...next }),
      ).resolves.toBe("restored-in-process");
    }
    if (replaceOwner) {
      const replacement = new DatabaseSync(helper.updateLeaseDatabasePath);
      replacement.prepare("DELETE FROM managed_update_handoffs WHERE install_root = ?").run(root);
      replacement.close();
    }
    parent.stdin?.end();
  });
});
