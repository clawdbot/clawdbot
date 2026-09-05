import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalSqliteSnapshotProvider } from "../../src/snapshot/local-repository.js";
import {
  assertSameCompactionPayload,
  formatReliabilityStderr,
  type CompactionPayloadProof,
  type ReliabilityReport,
  type ReliabilityStateProof,
} from "./sqlite-reliability-contract.js";

type RestoreCrashPoint = "after-publish" | "before-publish";
type RestoreExit =
  ReliabilityReport["maintenanceProof"]["restoreInterruption"]["beforePublish"]["exit"];
type RestoreCrashResult = {
  existingTargetPreserved: boolean;
  exit: RestoreExit;
  payloadAfterRecovery: CompactionPayloadProof;
  recoveryVerified: true;
  repositoryVerified: true;
  retryRestored: boolean;
  stagingEntries: number;
  stateAfterRecovery: ReliabilityStateProof;
  targetVerifiedAfterCrash: boolean;
  targetVisibleAfterCrash: boolean;
};

const RESTORE_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-restore-worker.ts", import.meta.url),
);
const RESTORE_TIMEOUT_MS = 120_000;
const MIN_STAGED_RESTORE_BYTES = 1024 * 1024;

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertSameState(
  actual: ReliabilityStateProof,
  expected: ReliabilityStateProof,
  label: string,
): void {
  if (
    actual.batches !== expected.batches ||
    actual.rows !== expected.rows ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      `${label} changed reliability state: expected batches=${expected.batches} rows=${expected.rows} sha256=${expected.sha256}, got batches=${actual.batches} rows=${actual.rows} sha256=${actual.sha256}`,
    );
  }
}

function assertNoSqliteSidecars(targetPath: string): void {
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    if (fs.existsSync(`${targetPath}${suffix}`)) {
      throw new Error(`restore crash left an unexpected SQLite sidecar: ${targetPath}${suffix}`);
    }
  }
}

function listRestoreStagingEntries(scratchPath: string): string[] {
  return fs
    .readdirSync(scratchPath)
    .filter((entry) => entry.startsWith(".sqlite-publish-") || entry.startsWith(".tmp-restore-"));
}

function listOuterRestoreStagingEntries(scratchPath: string): string[] {
  return listRestoreStagingEntries(scratchPath).filter((entry) =>
    entry.startsWith(".tmp-restore-"),
  );
}

function hasPublicationStaging(scratchPath: string): boolean {
  return listRestoreStagingEntries(scratchPath).some((entry) =>
    entry.startsWith(".sqlite-publish-"),
  );
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
          `SQLite restore worker did not become ready.${formatReliabilityStderr(params.readStderr())}`,
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
          `SQLite restore worker exited before ready: code=${String(code)} signal=${String(signal)}.${formatReliabilityStderr(params.readStderr())}`,
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

async function waitForChildExit(child: ChildProcess): Promise<RestoreExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<RestoreExit>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SQLite restore worker did not exit after forced termination."));
    }, 30_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function assertForcedExit(exit: RestoreExit): void {
  if (exit.code === 0) {
    throw new Error("SQLite restore worker exited cleanly before forced termination.");
  }
  if (process.platform === "win32") {
    if (exit.code === null && exit.signal === null) {
      throw new Error("SQLite restore worker reported no forced Windows exit.");
    }
    return;
  }
  if (exit.signal !== "SIGKILL") {
    throw new Error(
      `SQLite restore worker exited without SIGKILL: code=${String(exit.code)} signal=${String(exit.signal)}`,
    );
  }
}

async function waitForCrashPoint(params: {
  child: ChildProcess;
  crashPoint: RestoreCrashPoint;
  readStderr: () => string;
  scratchPath: string;
  targetPath: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `SQLite restore worker did not reach ${params.crashPoint}.${formatReliabilityStderr(params.readStderr())}`,
        ),
      );
    }, RESTORE_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      const event = message as { crashPoint?: unknown; kind?: unknown } | undefined;
      if (event?.kind === "crash-point" && event.crashPoint === params.crashPoint) {
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
          `SQLite restore worker exited before ${params.crashPoint}: code=${String(code)} signal=${String(signal)}.${formatReliabilityStderr(params.readStderr())}`,
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

  const outerStagingEntries = listOuterRestoreStagingEntries(params.scratchPath);
  const targetVisible = fs.existsSync(params.targetPath);
  const publicationStagingVisible = hasPublicationStaging(params.scratchPath);
  const barrierValid =
    outerStagingEntries.length > 0 &&
    (params.crashPoint === "before-publish"
      ? !targetVisible && publicationStagingVisible
      : targetVisible && !publicationStagingVisible);
  if (!barrierValid) {
    throw new Error(`SQLite restore worker reported an invalid ${params.crashPoint} barrier.`);
  }
}

async function assertRepositorySnapshotAvailable(params: {
  expectedSnapshotBytes: number;
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  snapshotPath: string;
}): Promise<void> {
  const verification = await params.provider.verify({ path: params.snapshotPath });
  if (verification.manifest.artifact.sizeBytes !== params.expectedSnapshotBytes) {
    throw new Error(
      `SQLite restore source changed: expected ${params.expectedSnapshotBytes} bytes, got ${verification.manifest.artifact.sizeBytes}`,
    );
  }
  const resolvedSnapshotPath = path.resolve(params.snapshotPath);
  const snapshots = await params.provider.list();
  if (!snapshots.some((snapshot) => path.resolve(snapshot.ref.path) === resolvedSnapshotPath)) {
    throw new Error(`SQLite restore source disappeared from repository: ${params.snapshotPath}`);
  }
}

async function runCrashPoint(params: {
  crashPoint: RestoreCrashPoint;
  expectedPayload: CompactionPayloadProof;
  expectedSnapshotBytes: number;
  expectedState: ReliabilityStateProof;
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  repositoryPath: string;
  scratchPath: string;
  snapshotPath: string;
  validationRootPath: string;
  verifyPayload: (databasePath: string) => CompactionPayloadProof;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}): Promise<RestoreCrashResult> {
  const targetPath = path.join(params.scratchPath, `${params.crashPoint}.sqlite`);
  let stderr = "";
  const child = fork(
    RESTORE_WORKER_PATH,
    [
      params.crashPoint,
      params.repositoryPath,
      params.validationRootPath,
      params.snapshotPath,
      targetPath,
    ],
    {
      cwd: process.cwd(),
      execArgv: ["--import", "tsx"],
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let crashStagingEntries: string[];
  try {
    await waitForWorkerReady({ child, readStderr: () => stderr });
    await waitForCrashPoint({
      child,
      crashPoint: params.crashPoint,
      readStderr: () => stderr,
      scratchPath: params.scratchPath,
      targetPath,
    });
    if (!child.kill("SIGKILL")) {
      throw new Error(
        `SQLite restore worker exited before the ${params.crashPoint} crash signal was delivered.`,
      );
    }
    const exit = await waitForChildExit(child);
    assertForcedExit(exit);

    crashStagingEntries = listRestoreStagingEntries(params.scratchPath);
    if (!crashStagingEntries.some((entry) => entry.startsWith(".tmp-restore-"))) {
      throw new Error(`SQLite restore worker left no owned staging at ${params.crashPoint}.`);
    }
    await assertRepositorySnapshotAvailable({
      expectedSnapshotBytes: params.expectedSnapshotBytes,
      provider: params.provider,
      snapshotPath: params.snapshotPath,
    });

    const targetVisibleAfterCrash = fs.existsSync(targetPath);
    let retryRestored = false;
    let existingTargetPreserved = false;
    if (params.crashPoint === "before-publish") {
      if (targetVisibleAfterCrash) {
        throw new Error("SQLite restore target became visible before publication.");
      }
      await params.provider.restoreFresh({ path: params.snapshotPath }, targetPath);
      retryRestored = true;
    } else {
      if (!targetVisibleAfterCrash) {
        throw new Error("SQLite restore target disappeared after durable publication.");
      }
      if (fs.statSync(targetPath).nlink !== 1) {
        throw new Error("SQLite restore target retained a publication hard link after commit.");
      }
      const targetHash = hashFile(targetPath);
      let retryError: unknown;
      try {
        await params.provider.restoreFresh({ path: params.snapshotPath }, targetPath);
      } catch (error) {
        retryError = error;
      }
      if (
        !(retryError instanceof Error) ||
        !/Fresh SQLite restore path already exists/iu.test(retryError.message)
      ) {
        throw new Error("SQLite restore retry did not preserve the published target.", {
          cause: retryError,
        });
      }
      if (hashFile(targetPath) !== targetHash) {
        throw new Error("SQLite restore retry changed the published target.");
      }
      existingTargetPreserved = true;
    }

    assertNoSqliteSidecars(targetPath);
    const stateAfterRecovery = params.verifyState(targetPath);
    assertSameState(stateAfterRecovery, params.expectedState, `${params.crashPoint} restore`);
    const payloadAfterRecovery = params.verifyPayload(targetPath);
    assertSameCompactionPayload(
      payloadAfterRecovery,
      params.expectedPayload,
      `${params.crashPoint} restore`,
    );
    await assertRepositorySnapshotAvailable({
      expectedSnapshotBytes: params.expectedSnapshotBytes,
      provider: params.provider,
      snapshotPath: params.snapshotPath,
    });
    for (const entry of crashStagingEntries) {
      if (!fs.existsSync(path.join(params.scratchPath, entry))) {
        throw new Error(`SQLite restore retry removed crash staging it did not own: ${entry}`);
      }
    }

    return {
      existingTargetPreserved,
      exit,
      payloadAfterRecovery,
      recoveryVerified: true,
      repositoryVerified: true,
      retryRestored,
      stagingEntries: crashStagingEntries.length,
      stateAfterRecovery,
      targetVerifiedAfterCrash: params.crashPoint === "after-publish",
      targetVisibleAfterCrash,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child).catch(() => undefined);
    }
    fs.rmSync(targetPath, { force: true });
    for (const entry of listRestoreStagingEntries(params.scratchPath)) {
      fs.rmSync(path.join(params.scratchPath, entry), { force: true, recursive: true });
    }
  }
}

export async function runRestoreInterruptionProof(params: {
  expectedPayload: CompactionPayloadProof;
  expectedSnapshotBytes: number;
  expectedState: ReliabilityStateProof;
  repositoryPath: string;
  scratchPath: string;
  snapshotPath: string;
  validationRootPath: string;
  verifyPayload: (databasePath: string) => CompactionPayloadProof;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}): Promise<ReliabilityReport["maintenanceProof"]["restoreInterruption"]> {
  if (params.expectedSnapshotBytes < MIN_STAGED_RESTORE_BYTES * 2) {
    throw new Error(
      `SQLite restore interruption snapshot is too small: ${params.expectedSnapshotBytes} bytes`,
    );
  }
  fs.mkdirSync(params.scratchPath, { recursive: true, mode: 0o700 });
  const provider = createLocalSqliteSnapshotProvider({
    repositoryPath: params.repositoryPath,
    validationRootPath: params.validationRootPath,
  });
  await assertRepositorySnapshotAvailable({
    expectedSnapshotBytes: params.expectedSnapshotBytes,
    provider,
    snapshotPath: params.snapshotPath,
  });

  const beforePublish = await runCrashPoint({
    ...params,
    crashPoint: "before-publish",
    provider,
  });
  if (
    beforePublish.targetVisibleAfterCrash ||
    beforePublish.targetVerifiedAfterCrash ||
    !beforePublish.retryRestored ||
    beforePublish.existingTargetPreserved
  ) {
    throw new Error("SQLite restore before-publication recovery reported an invalid outcome.");
  }

  const afterPublish = await runCrashPoint({
    ...params,
    crashPoint: "after-publish",
    provider,
  });
  if (
    !afterPublish.targetVisibleAfterCrash ||
    !afterPublish.targetVerifiedAfterCrash ||
    afterPublish.retryRestored ||
    !afterPublish.existingTargetPreserved
  ) {
    throw new Error("SQLite restore after-publication recovery reported an invalid outcome.");
  }

  return {
    afterPublish: {
      ...afterPublish,
      existingTargetPreserved: true,
      retryRestored: false,
      targetVerifiedAfterCrash: true,
      targetVisibleAfterCrash: true,
    },
    beforePublish: {
      ...beforePublish,
      existingTargetPreserved: false,
      retryRestored: true,
      targetVerifiedAfterCrash: false,
      targetVisibleAfterCrash: false,
    },
    snapshotBytes: params.expectedSnapshotBytes,
  };
}
