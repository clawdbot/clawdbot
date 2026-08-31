// Owns the live trajectory fixture environment and resource teardown.
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { listRunningSessions, waitForExecScope } from "../agents/bash-process-registry.js";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { GatewayClient } from "./client.js";
import { restoreLiveEnv, snapshotLiveEnv } from "./live-env-test-helpers.js";
import type { GatewayServer } from "./server-public.js";

export async function createTrajectoryExportFixture() {
  const previousEnv = snapshotLiveEnv(["OPENCLAW_TRAJECTORY", "OPENCLAW_TRAJECTORY_DIR"]);
  const tempDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-openclaw-trajectory-live-"));
  const fixture: {
    tempDir: string;
    server?: Pick<GatewayServer, "close">;
    client?: Pick<GatewayClient, "stopAndWait">;
    settleOwnedWork?: () => Promise<void>;
    cleanup: () => Promise<void>;
  } = {
    tempDir,
    async cleanup() {
      let ownersStopped = false;
      await runQaGatewayFixture(
        async () => {
          await runQaGatewayFixture(
            async () => {
              await fixture.settleOwnedWork?.();
            },
            async () => {
              await fixture.client?.stopAndWait({ timeoutMs: 5_000 });
            },
            async () => {
              await fixture.server?.close();
            },
          );
          ownersStopped = true;
        },
        () => restoreLiveEnv(previousEnv),
        clearRuntimeConfigSnapshot,
        async () => {
          // Closing the Gateway is not proof that timed-out work settled. Keep its
          // state and evidence unless every owned cleanup phase completed.
          if (!ownersStopped) {
            throw new Error(
              `trajectory fixture state retained at ${tempDir}: cleanup did not settle`,
            );
          }
          await removeLiveTempDir(tempDir);
        },
      );
    },
  };
  return fixture;
}

async function removeLiveTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  void lastError;
}

export function remainingCompletionMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("trajectory completion deadline exceeded");
  }
  return remaining;
}

export async function joinBeforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("trajectory completion deadline exceeded")),
          remainingCompletionMs(deadline),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function settleTrajectoryExportWork(params: {
  client: Pick<GatewayClient, "request">;
  deadline: number;
  execScope: string;
  workspaceDir: string;
  command?: string;
  runIds: Iterable<string>;
  sessionKey: string;
}): Promise<void> {
  const processes = listRunningSessions().filter(
    (process) =>
      process.scopeKey === params.execScope &&
      process.cwd === params.workspaceDir &&
      process.command === params.command,
  );
  await runQaGatewayFixture(
    async () => {
      const errors: unknown[] = [];
      for (const process of processes) {
        try {
          getProcessSupervisor().cancel(process.id);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const runId of params.runIds) {
        try {
          await params.client.request(
            "chat.abort",
            { runId, sessionKey: params.sessionKey },
            { timeoutMs: Math.max(1, Math.min(5_000, params.deadline - Date.now())) },
          );
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "trajectory failure cleanup cancellation failed");
      }
    },
    async () => {
      await joinBeforeDeadline(waitForExecScope(params.execScope), params.deadline);
      const drained = await waitForGatewayActiveWork(remainingCompletionMs(params.deadline));
      expect(drained.drained).toBe(true);
    },
  );
}
