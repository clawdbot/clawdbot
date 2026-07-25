/**
 * Tests process-local managed update handoff ownership and lifetime.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));
const FAST_WAIT_OPTS = { interval: 1 } as const;

function createSpawnMock() {
  return Object.assign(new EventEmitter(), {
    pid: 24680,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
}

function signalHandoffReady(child: ReturnType<typeof createSpawnMock>): void {
  child.stdout.write("OPENCLAW_UPDATE_HANDOFF_READY\n");
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
});

afterEach(async () => {
  const handoffDirs = spawnMock.mock.calls.flatMap((call) => {
    const args = call[1] as string[] | undefined;
    const scriptPath = args?.[0];
    return scriptPath ? [path.dirname(scriptPath)] : [];
  });
  await Promise.all(handoffDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.resetModules();
});

describe("managed service update handoff single-flight", () => {
  it("joins an active handoff instead of spawning a concurrent updater", async () => {
    const child = createSpawnMock();
    spawnMock.mockReturnValue(child);
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const first = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      supervisor: "launchd",
      env: { OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test" },
      handoffId: "handoff-first",
      meta: { handoffId: "handoff-first" },
    });
    const second = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      timeoutMs: 1_800_000,
      restartDrainTimeoutMs: 300_000,
      restartDelayMs: 500,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      supervisor: "launchd",
      env: { OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.test" },
      handoffId: "handoff-second",
      meta: { handoffId: "handoff-second" },
    });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled(), FAST_WAIT_OPTS);
    signalHandoffReady(child);

    await expect(first).resolves.toMatchObject({
      status: "started",
      handoffId: "handoff-first",
    });
    await expect(second).resolves.toMatchObject({
      status: "joined",
      handoffId: "handoff-first",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);

    child.emit("exit", 0, null);
    const nextChild = createSpawnMock();
    spawnMock.mockReturnValueOnce(nextChild);
    const next = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      handoffId: "handoff-next",
      meta: { handoffId: "handoff-next" },
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2), FAST_WAIT_OPTS);
    signalHandoffReady(nextChild);
    await expect(next).resolves.toMatchObject({
      status: "started",
      handoffId: "handoff-next",
    });
  });

  it("reports started only after the detached helper signals readiness", async () => {
    const child = createSpawnMock();
    spawnMock.mockReturnValueOnce(child);
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const resultPromise = startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: 12345,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      meta: {},
    });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1), FAST_WAIT_OPTS);

    const pending = Symbol("pending");
    await expect(
      Promise.race([
        resultPromise,
        new Promise((resolve) => {
          setImmediate(() => resolve(pending));
        }),
      ]),
    ).resolves.toBe(pending);

    signalHandoffReady(child);
    await expect(resultPromise).resolves.toMatchObject({ status: "started", pid: 24680 });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("exit")).toBe(1);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.stdout.destroyed).toBe(true);
  });
});
