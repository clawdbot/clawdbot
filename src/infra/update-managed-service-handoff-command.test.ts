// Managed-service handoff command tests cover immutable update target serialization.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDevUpdateTargetEnv, type DevUpdateTarget } from "./update-dev-target.js";

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

async function startHandoffAndReadCommand(params: {
  channel: "beta" | "extended-stable";
  tag?: string;
  devTarget?: DevUpdateTarget;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  command: string;
  commandArgv: string[] | undefined;
  spawnEnv: NodeJS.ProcessEnv | undefined;
}> {
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const result = await startManagedServiceUpdateHandoff({
    root: "/tmp/openclaw",
    restartDrainTimeoutMs: 300_000,
    channel: params.channel,
    ...(params.tag ? { tag: params.tag } : {}),
    parentPid: 12345,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    meta: {},
    ...(params.devTarget ? { devTarget: params.devTarget } : {}),
    ...(params.env ? { env: params.env } : {}),
  });
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
  };
  const metaPath = path.join(path.dirname(paramsPath), "sentinel-meta.json");
  const metaFile = JSON.parse(await fs.readFile(metaPath, "utf-8")) as {
    meta?: { root?: string };
  };
  expect(metaFile.meta?.root).toBe(
    await fs.realpath("/tmp/openclaw").catch(() => path.resolve("/tmp/openclaw")),
  );
  return {
    command: result.command,
    commandArgv: helperParams.commandArgv,
    spawnEnv: spawnCall?.[2]?.env,
  };
}

describe("managed service update handoff command", () => {
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
    });

    expect(result.commandArgv).toEqual([
      "/usr/local/bin/node",
      "/opt/openclaw/openclaw.mjs",
      "update",
      "--yes",
      "--json",
      "--channel",
      "beta",
      "--tag",
      "2.0.0-beta.1",
    ]);
    expect(result.command).toContain("--tag 2.0.0-beta.1");
    expect(result.command).toContain("--channel beta");
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
