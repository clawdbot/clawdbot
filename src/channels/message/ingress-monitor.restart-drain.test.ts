import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  beginGatewayRestartSignalAdmission,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

type RestartDrainProof = {
  restart: string;
  committed: boolean;
  idleMs: number;
  finalActivity: boolean;
  exitCode: number;
};
type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetGatewayWorkAdmission();
  closeOpenClawStateDatabaseForTest();
});

async function withQueue(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<void>,
): Promise<void> {
  const stateDir = tempDirs.make("openclaw-ingress-restart-lifecycle-");
  await run(createChannelIngressQueue({ channelId: "test", accountId: "a", stateDir }));
}

function createMonitor(
  queue: ChannelIngressQueue<StoredEvent>,
  deliver: (raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => Promise<void>,
  onActivityChange?: (active: boolean) => void,
  runPumpTask?: (work: () => Promise<void>) => Promise<void>,
) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new Error(kind),
    },
    deliver,
    pollIntervalMs: 60_000,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
      resolveNonRetryableFailure: () => null,
    },
    ...(onActivityChange ? { onActivityChange } : {}),
    ...(runPumpTask ? { runPumpTask } : {}),
  });
}

function runRestartDrainFixture(stateDir: string): Promise<RestartDrainProof> {
  return new Promise((resolve, reject) => {
    const fixture = fileURLToPath(
      new URL("../../../test/fixtures/channel-ingress-gateway-restart.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["--import", "tsx", fixture, stateDir], {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: stateDir },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const childStderr = child.stderr;
    if (!childStderr) {
      child.kill();
      reject(new Error("Gateway restart fixture stderr pipe was not created"));
      return;
    }
    let proof: RestartDrainProof | undefined;
    let failure: Error | undefined;
    let stderr = "";
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => {
      failure = new Error("Gateway restart fixture did not commit drain within 30 seconds");
      child.kill();
    }, 30_000);
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      if (message.type === "ingress-restart-drain-committed") {
        clearTimeout(startupTimer);
        idleTimer = setTimeout(() => {
          failure = new Error("Ingress did not become idle within 3 seconds of restart drain");
          child.kill();
        }, 3_000);
        return;
      }
      if (message.type === "ingress-restart-proof" && "proof" in message) {
        proof = message.proof as RestartDrainProof;
      }
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(startupTimer);
      clearTimeout(idleTimer);
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 || !proof) {
        reject(
          new Error(
            `Gateway restart fixture failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
          ),
        );
        return;
      }
      resolve(proof);
    });
  });
}

it("reaches ingress idle after the Gateway commits restart drain", async () => {
  const stateDir = tempDirs.make("openclaw-ingress-gateway-restart-");
  const proof = await runRestartDrainFixture(stateDir);
  expect(proof).toMatchObject({
    restart: "emitted",
    committed: true,
    finalActivity: false,
    exitCode: 0,
  });
  expect(proof.idleMs).toBeLessThan(1_000);
}, 40_000);

it("rearms queued ingress after a restart signal rolls back without an idle observer", async () => {
  await withQueue(async (queue) => {
    const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
      await lifecycle.onAdopted();
    });
    const monitor = createMonitor(queue, deliver);
    let signal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
    try {
      monitor.start();
      await monitor.waitForIdle();
      signal = beginGatewayRestartSignalAdmission();
      expect(signal).not.toBeNull();
      await monitor.admit({ id: "event-signal-rollback", lane: "a", text: "deliver me" });
      expect(deliver).not.toHaveBeenCalled();

      expect(signal?.rollback()).toBe(true);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    } finally {
      signal?.rollback();
      await monitor.stop();
    }
  });
});

it("clears activity when a restart signal commits to one-way drain", async () => {
  await withQueue(async (queue) => {
    const activity: boolean[] = [];
    const monitor = createMonitor(
      queue,
      async () => {},
      (active) => activity.push(active),
    );
    try {
      monitor.start();
      await monitor.waitForIdle();
      activity.length = 0;

      expect(beginGatewayRestartSignalAdmission()).not.toBeNull();
      monitor.requestDrain();
      expect(activity.at(-1)).toBe(true);

      markGatewayRestartDraining();
      await monitor.waitForIdle();
      expect(activity.at(-1)).toBe(false);
    } finally {
      await monitor.stop();
    }
  });
});

it.each(["pause", "stop"] as const)(
  "releases idle waiters when %s ends a restart fence wait",
  async (action) => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, async () => {});
      let signal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
      try {
        monitor.start();
        await monitor.waitForIdle();
        signal = beginGatewayRestartSignalAdmission();
        expect(signal).not.toBeNull();
        monitor.requestDrain();
        const idle = monitor.waitForIdle();

        await monitor[action]();
        await expect(idle).resolves.toBeUndefined();
      } finally {
        signal?.rollback();
        await monitor.stop();
      }
    });
  },
);

it("propagates a rejected pump wrapper without spinning idle or stop waits", async () => {
  await withQueue(async (queue) => {
    const rejection = new Error("pump wrapper rejected");
    const monitor = createMonitor(
      queue,
      async () => {},
      undefined,
      async () => {
        throw rejection;
      },
    );
    monitor.start();

    await expect(monitor.waitForIdle()).rejects.toBe(rejection);
    await expect(monitor.stop()).rejects.toBe(rejection);
  });
});
