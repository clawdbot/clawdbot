// Managed-service handoff command tests cover immutable update target serialization.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const getFileLockProcessStartTimeMock = vi.hoisted(() => vi.fn((_pid: number) => 17));
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
  });
});

vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  getFileLockProcessStartTime: getFileLockProcessStartTimeMock,
}));

vi.mock("../process/child-process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: forceKillChildProcessTreeMock,
}));

beforeEach(() => {
  getFileLockProcessStartTimeMock.mockReset();
  getFileLockProcessStartTimeMock.mockReturnValue(17);
  forceKillChildProcessTreeMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(createReadyChild);
});

afterEach(async () => {
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
  vi.resetModules();
});

async function startHandoffAndReadCommand(params: {
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
    meta?: { root?: string };
  };
  expect(metaFile.meta?.root).toBe(
    await fs.realpath(MOCK_INSTALL_ROOT).catch(() => path.resolve(MOCK_INSTALL_ROOT)),
  );
  return {
    command: result.command,
    commandArgv: helperParams.commandArgv,
    parentExitTimeoutMs: helperParams.parentExitTimeoutMs,
    parentExitDeadlineAt: helperParams.parentExitDeadlineAt,
    spawnEnv: spawnCall?.[2]?.env,
  };
}

describe("managed service update handoff command", () => {
  it.each([
    { drain: 300_000, expected: 390_000 },
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
    const result = await startHandoffAndReadCommand({
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
