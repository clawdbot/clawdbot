/**
 * Tests managed-service update handoff behavior exposed by gateway methods.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISOR_HINT_ENV_VARS } from "./supervisor-markers.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  cleanupStaleManagedServiceUpdateHandoffs,
  MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX,
} from "./update-managed-service-handoff-cleanup.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({
    pid: 24680,
    unref: vi.fn(),
  })),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

const tempDirs = new Set<string>();

afterEach(async () => {
  spawnMock.mockClear();
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runHelperWithExistingSentinel(params: {
  handoffId?: string;
  metaHandoffId?: string;
  sentinel: unknown;
}) {
  const { execFile } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-helper-test-"));
  tempDirs.add(tmpDir);

  await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDelayMs: 500,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    ...(params.handoffId ? { handoffId: params.handoffId } : {}),
    env: {},
    meta: {
      ...(params.metaHandoffId ? { handoffId: params.metaHandoffId } : {}),
      sessionKey: "agent:test:webchat:dm:user-123",
      continuationMessage: "continue after restart",
    },
  });

  const [, args] = spawnMock.mock.calls.at(-1) as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
  ];
  const helperScriptPath = args[0] ?? "";
  tempDirs.add(path.dirname(helperScriptPath));
  const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as Record<
    string,
    unknown
  >;
  const sentinelPath = path.join(tmpDir, "restart-sentinel.json");
  await fs.writeFile(sentinelPath, `${JSON.stringify(params.sentinel, null, 2)}\n`);
  const helperParamsPath = path.join(tmpDir, "helper-params.json");
  await fs.writeFile(
    helperParamsPath,
    `${JSON.stringify(
      {
        ...helperParams,
        parentPid: process.pid,
        parentExitTimeoutMs: 1,
        sentinelPath,
        logPath: path.join(tmpDir, "handoff.log"),
        sensitivePaths: [],
      },
      null,
      2,
    )}\n`,
  );

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      execFile(process.execPath, [helperScriptPath, helperParamsPath], (err) => {
        const childError = err as (NodeJS.ErrnoException & { signal?: NodeJS.Signals }) | null;
        resolve({
          code: typeof childError?.code === "number" ? childError.code : 0,
          signal: childError?.signal ?? null,
        });
      });
    },
  );

  return { result, sentinelPath };
}

describe("managed service update handoff", () => {
  it("strips process supervisor hints while preserving service identity for the CLI handoff", async () => {
    const { startManagedServiceUpdateHandoff, stripSupervisorHintEnv } =
      await import("./update-managed-service-handoff.js");
    const serviceIdentityEnv = {
      OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-test.service",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Test Gateway",
    } satisfies NodeJS.ProcessEnv;
    const supervisorEnv = Object.fromEntries(
      SUPERVISOR_HINT_ENV_VARS.map((key) => [key, "supervised"]),
    ) as NodeJS.ProcessEnv;
    const stripped = stripSupervisorHintEnv({
      ...supervisorEnv,
      ...serviceIdentityEnv,
      KEEP_ME: "1",
    });
    expect(stripped).toEqual({
      ...serviceIdentityEnv,
      KEEP_ME: "1",
    });

    const result = await startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      timeoutMs: 1_800_000,
      restartDelayMs: 500,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      env: {
        ...supervisorEnv,
        ...serviceIdentityEnv,
        KEEP_ME: "1",
      },
      meta: {
        sessionKey: "agent:test:webchat:dm:user-123",
        continuationMessage: "continue after restart",
      },
    });

    expect(result.status).toBe("started");
    expect(result.command).toBe("openclaw update --yes --timeout 1800");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [execPath, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
    ];
    expect(execPath).toBe("/usr/local/bin/node");
    expect(args).toHaveLength(2);
    tempDirs.add(path.dirname(args[0] ?? result.logPath));
    const helperParams = JSON.parse(await fs.readFile(args[1] ?? "", "utf-8")) as {
      cwd?: string;
      metaPath?: string;
      sentinelPath?: string;
    };
    expect(helperParams.metaPath).toMatch(/sentinel-meta\.json$/u);
    expect(helperParams.sentinelPath).toMatch(/restart-sentinel\.json$/u);
    expect(options.cwd).toBe(os.homedir());
    expect(helperParams.cwd).toBe(os.homedir());
    expect(options.detached).toBe(true);
    expect(options.env.KEEP_ME).toBe("1");
    for (const [key, value] of Object.entries(serviceIdentityEnv)) {
      expect(options.env[key]).toBe(value);
    }
    for (const key of SUPERVISOR_HINT_ENV_VARS.filter(
      (envKey) => !(envKey in serviceIdentityEnv),
    )) {
      expect(options.env[key]).toBeUndefined();
    }
    expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
    expect(options.env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]).toMatch(/sentinel-meta\.json$/u);
  });

  it("launches systemd handoffs through a transient user scope", async () => {
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-run-bin-"));
    tempDirs.add(binDir);
    const systemdRunPath = path.join(binDir, "systemd-run");
    await fs.writeFile(systemdRunPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = await startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      timeoutMs: 1_800_000,
      restartDelayMs: 500,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      handoffId: "handoff-123",
      channel: "beta",
      supervisor: "systemd",
      env: {
        PATH: binDir,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
        INVOCATION_ID: "gateway-invocation",
        KEEP_ME: "1",
      },
      meta: {
        handoffId: "handoff-123",
        sessionKey: "agent:test:webchat:dm:user-123",
        continuationMessage: "continue after restart",
      },
    });

    expect(result.status).toBe("started");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
    ];
    expect(command).toBe(systemdRunPath);
    expect(args.slice(0, 4)).toEqual([
      "--user",
      "--scope",
      "--collect",
      "--unit=openclaw-update-handoff-123.scope",
    ]);
    expect(args.slice(4, 7)).toEqual([
      "/usr/local/bin/node",
      expect.stringMatching(/handoff\.cjs$/u),
      expect.stringMatching(/handoff\.json$/u),
    ]);
    tempDirs.add(path.dirname(args[5] ?? result.logPath));
    const helperParams = JSON.parse(await fs.readFile(args[6] ?? "", "utf-8")) as {
      commandArgv?: string[];
      handoffId?: string;
    };
    expect(helperParams.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--channel",
      "beta",
      "--timeout",
      "1800",
    ]);
    expect(helperParams.handoffId).toBe("handoff-123");
    expect(options.detached).toBe(true);
    expect(options.env.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(options.env.INVOCATION_ID).toBeUndefined();
    expect(options.env.KEEP_ME).toBe("1");
    expect(options.env.OPENCLAW_UPDATE_RUN_HANDOFF).toBe("1");
  });

  it("does not overwrite a restart sentinel owned by another startup task", async () => {
    const unrelatedSentinel = {
      version: 1,
      payload: {
        kind: "config",
        status: "skipped",
        message: "preserve this restart task",
        stats: { reason: "config-restart-pending" },
      },
    };
    const { result, sentinelPath } = await runHelperWithExistingSentinel({
      sentinel: unrelatedSentinel,
    });

    expect(result).toEqual({ code: 1, signal: null });
    await expect(fs.readFile(sentinelPath, "utf-8").then(JSON.parse)).resolves.toEqual(
      unrelatedSentinel,
    );
  });

  it("does not overwrite a newer pending update handoff sentinel", async () => {
    const newerSentinel = {
      version: 1,
      payload: {
        kind: "update",
        status: "skipped",
        message: "new handoff still pending",
        stats: {
          mode: "npm",
          handoffId: "newer-handoff",
          reason: "managed-service-handoff-started",
          steps: [],
          durationMs: 0,
        },
      },
    };
    const { result, sentinelPath } = await runHelperWithExistingSentinel({
      handoffId: "old-handoff",
      metaHandoffId: "old-handoff",
      sentinel: newerSentinel,
    });

    expect(result).toEqual({ code: 1, signal: null });
    await expect(fs.readFile(sentinelPath, "utf-8").then(JSON.parse)).resolves.toEqual(
      newerSentinel,
    );
  });

  it("sweeps stale handoff temp directories while keeping fresh handoff logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-handoff-cleanup-test-"));
    tempDirs.add(tmpDir);
    const staleDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}stale`);
    const freshDir = path.join(tmpDir, `${MANAGED_SERVICE_UPDATE_HANDOFF_TEMP_PREFIX}fresh`);
    const unrelatedDir = path.join(tmpDir, "openclaw-other-temp");
    await fs.mkdir(staleDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.mkdir(unrelatedDir, { recursive: true });
    const now = Date.now();
    const staleTime = new Date(now - 25 * 60 * 60_000);
    await fs.utimes(staleDir, staleTime, staleTime);

    await expect(
      cleanupStaleManagedServiceUpdateHandoffs({
        tmpDir,
        nowMs: now,
        ttlMs: 24 * 60 * 60_000,
      }),
    ).resolves.toBe(1);

    await expect(pathExists(staleDir)).resolves.toBe(false);
    await expect(pathExists(freshDir)).resolves.toBe(true);
    await expect(pathExists(unrelatedDir)).resolves.toBe(true);
  });
});
