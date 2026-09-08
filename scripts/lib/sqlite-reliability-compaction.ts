import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SnapshotDatabaseIdentity } from "../../src/snapshot/snapshot-provider.js";
import {
  assertSameCompactionPayload,
  assertSameReliabilityState,
  formatReliabilityStderr,
  type CompactionPayloadProof,
  type ReliabilityReport,
  type ReliabilityStateProof,
} from "./sqlite-reliability-contract.js";
import {
  assertReliabilityForcedExit,
  waitForReliabilityWorkerExit,
} from "./sqlite-reliability-process.js";

type CompactionTarget = {
  identity: SnapshotDatabaseIdentity;
  path: string;
};

const COMPACTION_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-compaction-worker.ts", import.meta.url),
);
const COMPACTION_TIMEOUT_MS = 120_000;
const MIN_ACTIVE_SIDECAR_BYTES = 1024 * 1024;
const WORKER_EXIT_TIMEOUT_MESSAGE =
  "SQLite compaction worker did not exit after forced termination.";

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function workerArgs(target: CompactionTarget): string[] {
  if (target.identity.role === "global") {
    return ["global", target.path, ""];
  }
  if (target.identity.role === "agent") {
    return ["agent", target.path, target.identity.agentId];
  }
  throw new Error(`unsupported reliability target role: ${target.identity.role}`);
}

async function waitForWorkerReady(params: {
  child: ChildProcess;
  readStderr: () => string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `SQLite compaction worker did not become ready.${formatReliabilityStderr(params.readStderr())}`,
        ),
      );
    }, 30_000);
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { kind?: unknown }).kind === "ready"
      ) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `SQLite compaction worker exited before ready: code=${String(code)} signal=${String(signal)}.${formatReliabilityStderr(params.readStderr())}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      params.child.off("message", onMessage);
      params.child.off("error", onError);
      params.child.off("exit", onExit);
    };
    params.child.on("message", onMessage);
    params.child.on("error", onError);
    params.child.on("exit", onExit);
  });
}

async function waitForActiveVacuum(params: {
  child: ChildProcess;
  databasePath: string;
  readStderr: () => string;
}): Promise<{ journalBytes: number; walBytes: number }> {
  const deadline = Date.now() + COMPACTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const journalBytes = fileSize(`${params.databasePath}-journal`);
    const walBytes = fileSize(`${params.databasePath}-wal`);
    if (journalBytes >= MIN_ACTIVE_SIDECAR_BYTES || walBytes >= MIN_ACTIVE_SIDECAR_BYTES) {
      return { journalBytes, walBytes };
    }
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
        `SQLite compaction completed before interruption evidence was observed.${formatReliabilityStderr(params.readStderr())}`,
      );
    }
    await delay(2);
  }
  throw new Error(
    `SQLite compaction did not produce ${MIN_ACTIVE_SIDECAR_BYTES} bytes of active journal evidence within 120 seconds.`,
  );
}

export async function runVacuumInterruptionProof(params: {
  env: NodeJS.ProcessEnv;
  expectedAutoVacuum: number;
  expectedPayload: CompactionPayloadProof;
  expectedState: ReliabilityStateProof;
  readAutoVacuum: () => number;
  readPayload: () => CompactionPayloadProof;
  recoverAndVerifyDatabase: () => ReliabilityStateProof;
  target: CompactionTarget;
}): Promise<ReliabilityReport["maintenanceProof"]["vacuumInterruption"]> {
  let stderr = "";
  const child = fork(COMPACTION_WORKER_PATH, workerArgs(params.target), {
    env: params.env,
    execArgv: ["--import", "tsx"],
    serialization: "json",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    await waitForWorkerReady({ child, readStderr: () => stderr });
    const observed = await waitForActiveVacuum({
      child,
      databasePath: params.target.path,
      readStderr: () => stderr,
    });
    if (!child.kill("SIGKILL")) {
      throw new Error("SQLite compaction worker exited before the crash signal was delivered.");
    }
    const exit = await waitForReliabilityWorkerExit(child, WORKER_EXIT_TIMEOUT_MESSAGE);
    assertReliabilityForcedExit(exit, "SQLite compaction worker");

    const stateAfterRecovery = params.recoverAndVerifyDatabase();
    assertSameReliabilityState(stateAfterRecovery, params.expectedState, "vacuum crash recovery");
    const autoVacuumAfterRecovery = params.readAutoVacuum();
    if (autoVacuumAfterRecovery !== params.expectedAutoVacuum) {
      throw new Error(
        `SQLite VACUUM committed before forced termination: expected auto_vacuum=${params.expectedAutoVacuum}, got ${autoVacuumAfterRecovery}`,
      );
    }
    const payloadAfterRecovery = params.readPayload();
    assertSameCompactionPayload(
      payloadAfterRecovery,
      params.expectedPayload,
      "vacuum crash recovery",
    );
    const journalBytesAfterRecovery = fileSize(`${params.target.path}-journal`);
    const walBytesAfterRecovery = fileSize(`${params.target.path}-wal`);
    if (journalBytesAfterRecovery !== 0 || walBytesAfterRecovery !== 0) {
      throw new Error(
        `SQLite recovery left active compaction sidecars: journal=${journalBytesAfterRecovery} wal=${walBytesAfterRecovery}`,
      );
    }

    return {
      autoVacuumAfterRecovery,
      autoVacuumBeforeKill: params.expectedAutoVacuum,
      exit,
      journalBytesObserved: observed.journalBytes,
      payloadAfterRecovery,
      payloadBeforeKill: params.expectedPayload,
      recoveryVerified: true,
      stateAfterRecovery,
      stateBeforeKill: params.expectedState,
      walBytesObserved: observed.walBytes,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForReliabilityWorkerExit(child, WORKER_EXIT_TIMEOUT_MESSAGE).catch(() => undefined);
    }
  }
}
