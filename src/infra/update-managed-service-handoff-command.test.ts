// Managed-service handoff command tests cover immutable update target serialization.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());
const forceKillChildProcessTreeMock = vi.hoisted(() => vi.fn());
const tempDirs = new Set<string>();
const mockedHandoffLeaseCleanups = new Set<() => void>();
const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-command-${process.pid}`);

function createReadyChild(_command: string, args: string[]) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  process.nextTick(() => {
    signalMockManagedUpdateHandoffReady({
      child,
      paramsPath: args.at(-1) ?? "",
      cleanups: mockedHandoffLeaseCleanups,
    });
  });
  return child;
}

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
    spawnSync: spawnSyncMock,
  });
});

vi.mock("../process/child-process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: forceKillChildProcessTreeMock,
}));

vi.mock("../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-scope.js")>()),
  findInstalledSystemdGatewayScope: vi.fn(async () => null),
}));

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

beforeEach(async () => {
  // Helpers in one fixture share a coordinator without touching the operator's database.
  const coordinatorDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-coordinator-")),
  );
  tempDirs.add(coordinatorDir);
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  forceKillChildProcessTreeMock.mockReset();
  spawnMock.mockReset();
  spawnSyncMock
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawnSync,
    );
  spawnMock.mockImplementation(createReadyChild);
});

afterEach(async () => {
  for (const cleanup of mockedHandoffLeaseCleanups) {
    mockedHandoffLeaseCleanups.delete(cleanup);
    cleanup();
  }
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

async function startHandoffAndReadCommand(params: {
  runId?: string;
  channel: "beta" | "extended-stable";
  tag?: string;
  acceptCapabilities?: boolean;
  devTarget?: DevUpdateTarget;
  env?: NodeJS.ProcessEnv;
  restartDelayMs?: number;
  restartDrainTimeoutMs?: number;
}): Promise<{
  command: string;
  commandArgv: string[] | undefined;
  parentExitTimeoutMs: number;
  parentExitDeadlineAt: number;
  spawnEnv: NodeJS.ProcessEnv | undefined;
}> {
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const result = await startManagedServiceUpdateHandoff({
    runId: params.runId,
    root: MOCK_INSTALL_ROOT,
    restartDrainTimeoutMs: params.restartDrainTimeoutMs ?? 300_000,
    ...(params.restartDelayMs === undefined ? {} : { restartDelayMs: params.restartDelayMs }),
    channel: params.channel,
    ...(params.tag ? { tag: params.tag } : {}),
    ...(params.acceptCapabilities ? { acceptCapabilities: true } : {}),
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    meta: {},
    ...(params.devTarget ? { devTarget: params.devTarget } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
  expect(forceKillChildProcessTreeMock).not.toHaveBeenCalled();
  const spawnCall = spawnMock.mock.calls[0] as unknown as
    | [string, string[], { env?: NodeJS.ProcessEnv }]
    | undefined;
  const paramsPath = spawnCall?.[1]?.[1];
  if (!paramsPath) {
    throw new Error("expected managed-service handoff params path");
  }
  tempDirs.add(path.dirname(paramsPath));
  const helperParams = JSON.parse(await fs.readFile(paramsPath, "utf-8")) as {
    commandArgv?: string[];
    parentExitTimeoutMs: number;
    parentExitDeadlineAt: number;
  };
  const metaPath = path.join(path.dirname(paramsPath), "sentinel-meta.json");
  const metaFile = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
    meta?: { root?: string; runId?: string };
  };
  expect(metaFile.meta?.root).toBe(
    await fs.realpath(MOCK_INSTALL_ROOT).catch(() => path.resolve(MOCK_INSTALL_ROOT)),
  );
  expect(metaFile.meta?.runId).toBe(params.runId);
  return {
    command: result.command,
    commandArgv: helperParams.commandArgv,
    parentExitTimeoutMs: helperParams.parentExitTimeoutMs,
    parentExitDeadlineAt: helperParams.parentExitDeadlineAt,
    spawnEnv: spawnCall?.[2]?.env,
  };
}

describe("managed service update handoff command", () => {
  it("stages automatic triage in a stop-linked scope with the installed entry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-triage-command-"));
    tempDirs.add(root);
    await fs.writeFile(path.join(root, "systemd-run"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    await startManagedServiceUpdateHandoff({
      root,
      restartDrainTimeoutMs: 0,
      supervisor: "systemd",
      env: {
        PATH: root,
        OPENCLAW_STATE_DIR: root,
      },
      handoffId: "triage-fixture",
      meta: {},
      action: {
        kind: "triage" as const,
        entrypoint: path.join(root, "dist/index.js"),
        nodeRunner: process.execPath,
        failure: {
          kind: "gateway-startup" as const,
          phase: "startup",
          error: "bad certificate",
          gateway: "verify-running" as const,
        },
      },
    });
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    tempDirs.add(path.dirname(args.at(-1)!));
    expect(args).toContain("--property=PartOf=openclaw-gateway.service");
    const staged = JSON.parse(await fs.readFile(args.at(-1)!, "utf8"));
    expect(staged.commandArgv).toEqual([
      process.execPath,
      path.join(root, "dist/index.js"),
      "triage",
    ]);
  });

  it.each([
    { drain: 300_000, expected: 330_000 },
    { drain: Number.MAX_SAFE_INTEGER, expected: 2_147_483_647 },
  ])(
    "serializes a bounded timer-safe restart deadline for drain $drain",
    async ({ drain, expected }) => {
      const startedAt = Date.now();
      const result = await startHandoffAndReadCommand({
        channel: "beta",
        restartDelayMs: 60_000,
        restartDrainTimeoutMs: drain,
      });

      expect(result.parentExitTimeoutMs).toBe(expected);
      expect(result.parentExitDeadlineAt).toBeGreaterThanOrEqual(startedAt + expected);
      expect(result.parentExitDeadlineAt).toBeLessThanOrEqual(Date.now() + expected);
    },
  );

  it("confirms native group cleanup after a scope is collected, without stopping a replaced scope", async () => {
    const { createManagedHandoffLeaseStore, resolveManagedUpdateLeaseDatabasePath } =
      await import("./update-managed-service-handoff-lease.js");
    const store = createManagedHandoffLeaseStore();
    const action = {
      kind: "triage" as const,
      phase: "closing" as const,
      lifetime: {
        kind: "native" as const,
        scope: "synthetic.scope",
        unit: "synthetic.service",
        placement: { kind: "attached" as const, invocation: "a".repeat(32) },
      },
    };
    const payload = JSON.stringify({
      version: 2,
      executor: { pid: 123, startIdentity: "17" },
      helper: { pid: 123, startIdentity: "17" },
      action,
    });
    const lease: ManagedHandoffLease = {
      key: MOCK_INSTALL_ROOT,
      owner: "synthetic",
      updatedAt: 1,
      payload,
      version: 2,
      executor: { pid: 123, startIdentity: "17" },
      helper: { pid: 123, startIdentity: "17" },
      action,
    };
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
    );
    db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, ?)").run(
      lease.key,
      lease.owner,
      payload,
      1,
    );
    db.close();
    if (process.platform !== "win32") {
      await fs.chmod(databasePath, 0o600);
    }
    mockedHandoffLeaseCleanups.add(() => {
      const cleanup = new DatabaseSync(databasePath);
      try {
        cleanup
          .prepare("DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?")
          .run(lease.key, lease.owner);
      } finally {
        cleanup.close();
      }
    });
    spawnSyncMock
      .mockReturnValueOnce({
        status: 0,
        stdout:
          "Id=synthetic.scope\nLoadState=loaded\nActiveState=active\nInvocationID=" +
          "a".repeat(32),
      })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({
        status: 1,
        stdout: "Id=synthetic.scope\nLoadState=not-found\nActiveState=inactive\nInvocationID=",
      });
    expect(store.stopNative(lease)).toBe(true);
    expect(spawnSyncMock.mock.calls.filter(([, args]) => args.includes("stop"))).toHaveLength(1);
    spawnSyncMock.mockReset().mockReturnValue({
      status: 0,
      stdout:
        "Id=synthetic.scope\nLoadState=loaded\nActiveState=active\nInvocationID=" + "b".repeat(32),
    });
    expect(store.stopNative(lease)).toBe(false);
    expect(spawnSyncMock.mock.calls.filter(([, args]) => args.includes("stop"))).toEqual([]);
    for (const state of ["inactive", "failed"]) {
      spawnSyncMock.mockReset().mockReturnValue({
        status: 0,
        stdout: `Id=synthetic.scope\nLoadState=loaded\nActiveState=${state}\nControlGroup=\nInvocationID=${"b".repeat(32)}`,
      });
      expect(store.stopNative(lease)).toBe(false);
      expect(spawnSyncMock.mock.calls.filter(([, args]) => args.includes("stop"))).toEqual([]);
    }
  });

  it("serializes extended-stable into the detached CLI command", async () => {
    const result = await startHandoffAndReadCommand({ channel: "extended-stable" });

    expect(result.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--channel",
      "extended-stable",
    ]);
    expect(result.command).toContain("--channel extended-stable");
  });

  it("serializes an immutable package target into the detached CLI command", async () => {
    const result = await startHandoffAndReadCommand({
      channel: "beta",
      tag: "2.0.0-beta.1",
      acceptCapabilities: true,
    });

    expect(result.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--accept-capabilities",
      "--channel",
      "beta",
      "--tag",
      "2.0.0-beta.1",
    ]);
    expect(result.command).toContain("--tag 2.0.0-beta.1");
    expect(result.command).toContain("--channel beta");
    expect(result.command).toContain("--accept-capabilities");
    expect(result.command).toContain("--yes");
    expect(result.command).not.toContain("--json");
  });

  it("merges a tracked target into the child environment without replacing caller fields", async () => {
    const runId = "970895bf-61e5-48e6-b0f6-468ce6f8e33a";
    const result = await startHandoffAndReadCommand({
      runId,
      channel: "beta",
      env: {
        KEEP: "value",
        OPENCLAW_UPDATE_DEV_TARGET_REF: "stale-ref",
      },
      devTarget: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: "frozen-sha",
      },
    });

    expect(result.spawnEnv?.KEEP).toBe("value");
    expect(result.spawnEnv?.OPENCLAW_UPDATE_RUN_ID).toBe(runId);
    expect(parseDevUpdateTargetEnv(result.spawnEnv ?? {})).toEqual({
      status: "valid",
      target: {
        mode: "tracked",
        upstreamRef: "origin/main",
        upstreamSha: "frozen-sha",
      },
    });
  });
});
