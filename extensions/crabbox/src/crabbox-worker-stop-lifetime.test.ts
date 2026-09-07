import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { stopCrabboxLease } from "./crabbox-worker-command.js";
import {
  commandResult,
  createWarmProvider,
  LEASE_ID,
  openWarmImageStore,
  PROFILE,
  provisionWarmProfile,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

// Only the parent clock is virtual: the real SDK owns a child that exits when released.
// Poll inside the child: filesystem notifications can miss the atomic release rename.
const HELD_STOP = `
  const fs = require("node:fs");
  const marker = process.argv[1];
  const watcher = setInterval(() => {
    if (fs.existsSync(marker)) {
      clearInterval(watcher);
      process.exit(Number(fs.readFileSync(marker, "utf8")));
    }
  }, 10);
  process.stdout.write("ready");
`;

describe("Crabbox stop lifetime", () => {
  it.each(["destroy", "dispose", "inspection loss"] as const)(
    "retains heartbeat custody through %s and later disposal",
    async (entrance) => {
      vi.useFakeTimers();
      const heartbeatStarted = createDeferred<void>();
      const finishHeartbeat = createDeferred<void>();
      let heartbeatSignal: AbortSignal | undefined;
      let recognized = true;
      const { provider, calls } = createWarmProvider(({ argv, options }) => {
        if (argv[1] === "heartbeat") {
          heartbeatSignal = options.signal;
          heartbeatStarted.resolve();
          // Abort requests termination; the command runner still owns child settlement.
          return finishHeartbeat.promise.then(() => commandResult());
        }
        if (argv[1] === "inspect" && !recognized) {
          return commandResult({ code: 4, stderr: `${LEASE_ID} was not found` });
        }
        return undefined;
      });
      const lease = { leaseId: LEASE_ID, profile: { ...PROFILE, warmImage: false } };
      const operations: Promise<unknown>[] = [];
      try {
        await provider.inspect(lease);
        await vi.advanceTimersByTimeAsync(0);
        await heartbeatStarted.promise;

        recognized = entrance !== "inspection loss";
        let closed = false;
        operations.push(
          (entrance === "destroy"
            ? provider.destroy(lease)
            : entrance === "dispose"
              ? provider.dispose()
              : provider.inspect(lease)
          ).finally(() => {
            closed = true;
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(heartbeatSignal?.aborted).toBe(true);

        recognized = true;
        await provider.inspect(lease);
        await vi.advanceTimersByTimeAsync(0);
        let disposed = false;
        operations.push(
          provider.dispose().finally(() => {
            disposed = true;
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(closed).toBe(false);
        expect(disposed).toBe(false);
        expect(calls.filter(({ argv }) => argv[1] === "heartbeat")).toHaveLength(1);
        expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);

        finishHeartbeat.resolve();
        await Promise.all(operations);
        expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(
          entrance === "destroy" ? 1 : 0,
        );
        await vi.advanceTimersByTimeAsync(180_000);
        expect(calls.filter(({ argv }) => argv[1] === "heartbeat")).toHaveLength(1);
      } finally {
        finishHeartbeat.resolve();
        await Promise.allSettled(operations);
        await provider.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { entrance: "destroy", exitCode: 0, elapsedMs: 6 * 60_000, outcome: "success" },
    { entrance: "direct stop", exitCode: 0, elapsedMs: 6 * 60_000, outcome: "success" },
    { entrance: "destroy", exitCode: 5, elapsedMs: 6 * 60_000, outcome: "failure" },
    { entrance: "destroy", exitCode: 0, elapsedMs: 18 * 60_000, outcome: "timeout" },
  ])(
    "preserves $entrance custody through late $outcome",
    async ({ entrance, exitCode, elapsedMs, outcome }) => {
      const marker = path.join(tempDirs.make("openclaw-crabbox-stop-"), "release");
      const started = createDeferred<void>();
      let childResult: SpawnResult | undefined;
      let armed = false;
      const runStop = async (
        _argv: string[],
        options: Parameters<typeof runCommandWithTimeout>[1],
      ) => {
        const result = await runCommandWithTimeout([process.execPath, "-e", HELD_STOP, marker], {
          ...(typeof options === "number" ? { timeoutMs: options } : options),
          onOutputChunk: (chunk, stream) => {
            if (stream === "stdout" && chunk.toString() === "ready") {
              started.resolve();
            }
          },
        });
        childResult = result;
        return result;
      };
      const { provider } = createWarmProvider(async ({ argv, options }) => {
        if (armed && argv[1] === "stop") {
          return await runStop(argv, options);
        }
        return undefined;
      });
      await provisionWarmProfile(provider);
      const store = openWarmImageStore();
      const owner = store.entries()[0]!;
      armed = true;
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      let settled = false;
      const operation = (
        entrance === "destroy"
          ? provider.destroy({ leaseId: LEASE_ID, profile: { ...PROFILE, warmImage: false } })
          : stopCrabboxLease({
              binary: "crabbox",
              id: LEASE_ID,
              provider: "aws",
              runCommand: runStop,
            })
      )
        .then(
          () => ({ success: true }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await Promise.race([
          started.promise,
          operation.then(() => {
            throw new Error("stop exited before readiness");
          }),
        ]);
        await vi.advanceTimersByTimeAsync(elapsedMs);
        expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeDefined();
        if (outcome !== "timeout") {
          expect(settled).toBe(false);
        }
      } finally {
        fs.writeFileSync(`${marker}.tmp`, String(exitCode));
        fs.renameSync(`${marker}.tmp`, marker);
        // Drain the SDK's process-tree settlement even when the baseline killed the child.
        await vi.advanceTimersByTimeAsync(10_000);
        await operation;
        vi.useRealTimers();
      }
      if (outcome === "success") {
        expect(await operation).toEqual({ success: true });
        expect(childResult).toMatchObject({ termination: "exit", code: 0 });
        if (entrance === "destroy") {
          expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeUndefined();
        }
      } else {
        expect(await operation).toMatchObject({
          error: {
            message:
              outcome === "failure"
                ? "Crabbox stop failed with exit code 5: ready"
                : "Crabbox stop did not exit normally (timeout): ready",
          },
        });
        expect(childResult).toMatchObject(
          outcome === "failure" ? { termination: "exit", code: 5 } : { termination: "timeout" },
        );
        expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeDefined();
      }
    },
  );
});
