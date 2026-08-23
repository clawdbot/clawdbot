import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalSqliteSnapshotProvider } from "../../src/snapshot/local-repository.js";
import {
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotDatabaseIdentity,
  type SnapshotSummary,
} from "../../src/snapshot/snapshot-provider.js";
import type { ReliabilityReport, ReliabilityStateProof } from "./sqlite-reliability-contract.js";

type RepositoryCrashPoint = "after-commit" | "before-pending" | "pending";
type RepositoryExit =
  ReliabilityReport["maintenanceProof"]["repositoryInterruption"]["beforePending"]["exit"];
type RepositoryPayload =
  ReliabilityReport["maintenanceProof"]["repositoryInterruption"]["beforePending"]["payload"];
type CrashPointResult = {
  crashSnapshotVerifiedAfterCrash: boolean;
  crashSnapshotVisibleAfterCrash: boolean;
  exit: RepositoryExit;
  incompleteEntries: number;
  payload: RepositoryPayload;
  stagingEntries: number;
  state: ReliabilityStateProof;
  visibleSnapshotsAfterCrash: number;
};

const REPOSITORY_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-repository-worker.ts", import.meta.url),
);
const REPOSITORY_TIMEOUT_MS = 120_000;

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

function assertSamePayload(
  actual: RepositoryPayload,
  expected: RepositoryPayload,
  label: string,
): void {
  if (
    actual.bytes !== expected.bytes ||
    actual.idSum !== expected.idSum ||
    actual.rows !== expected.rows
  ) {
    throw new Error(
      `${label} changed compaction payload: expected rows=${expected.rows} bytes=${expected.bytes} idSum=${expected.idSum}, got rows=${actual.rows} bytes=${actual.bytes} idSum=${actual.idSum}`,
    );
  }
}

function formatWorkerStderr(stderr: string): string {
  const text = stderr.trim();
  return text ? ` stderr=${JSON.stringify(text)}` : "";
}

async function waitForCrashPoint(params: {
  child: ChildProcess;
  crashPoint: RepositoryCrashPoint;
  readStderr: () => string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `SQLite repository worker did not reach ${params.crashPoint}.${formatWorkerStderr(params.readStderr())}`,
        ),
      );
    }, REPOSITORY_TIMEOUT_MS);
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
          `SQLite repository worker exited before ${params.crashPoint}: code=${String(code)} signal=${String(signal)}.${formatWorkerStderr(params.readStderr())}`,
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

async function waitForChildExit(child: ChildProcess): Promise<RepositoryExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<RepositoryExit>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SQLite repository worker did not exit after forced termination."));
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

function assertForcedExit(exit: RepositoryExit): void {
  if (exit.code === 0) {
    throw new Error("SQLite repository worker exited cleanly before forced termination.");
  }
  if (process.platform === "win32") {
    if (exit.code === null && exit.signal === null) {
      throw new Error("SQLite repository worker reported no forced Windows exit.");
    }
    return;
  }
  if (exit.signal !== "SIGKILL") {
    throw new Error(
      `SQLite repository worker exited without SIGKILL: code=${String(exit.code)} signal=${String(exit.signal)}`,
    );
  }
}

async function verifySnapshot(params: {
  expectedPayload: RepositoryPayload;
  expectedState: ReliabilityStateProof;
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  snapshot: SnapshotSummary;
  verifyPayload: (databasePath: string) => RepositoryPayload;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}): Promise<void> {
  await params.provider.verify(params.snapshot.ref);
  const artifactPath = path.join(params.snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
  assertSameState(params.verifyState(artifactPath), params.expectedState, artifactPath);
  assertSamePayload(params.verifyPayload(artifactPath), params.expectedPayload, artifactPath);
}

function listRepositoryEntries(repositoryPath: string): string[] {
  return fs.existsSync(repositoryPath) ? fs.readdirSync(repositoryPath) : [];
}

async function runCrashPoint(params: {
  crashPoint: RepositoryCrashPoint;
  expectedPayload: RepositoryPayload;
  expectedState: ReliabilityStateProof;
  identity: SnapshotDatabaseIdentity;
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  repositoryPath: string;
  sourcePath: string;
  validationRootPath: string;
  verifyPayload: (databasePath: string) => RepositoryPayload;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}): Promise<CrashPointResult> {
  const visibleBefore = await params.provider.list();
  const visiblePathsBefore = new Set(
    visibleBefore.map((snapshot) => path.resolve(snapshot.ref.path)),
  );
  const entriesBefore = new Set(listRepositoryEntries(params.repositoryPath));
  let stderr = "";
  const child = fork(
    REPOSITORY_WORKER_PATH,
    [
      params.crashPoint,
      params.repositoryPath,
      params.validationRootPath,
      params.sourcePath,
      JSON.stringify(params.identity),
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

  try {
    await waitForCrashPoint({
      child,
      crashPoint: params.crashPoint,
      readStderr: () => stderr,
    });
    if (!child.kill("SIGKILL")) {
      throw new Error(
        `SQLite repository worker exited before the ${params.crashPoint} crash signal was delivered.`,
      );
    }
    const exit = await waitForChildExit(child);
    assertForcedExit(exit);

    const createdEntries = listRepositoryEntries(params.repositoryPath).filter(
      (entry) => !entriesBefore.has(entry),
    );
    const visibleAfter = await params.provider.list();
    const crashSnapshots = visibleAfter.filter(
      (snapshot) => !visiblePathsBefore.has(path.resolve(snapshot.ref.path)),
    );
    const expectedVisibleCrashSnapshots = params.crashPoint === "before-pending" ? 0 : 1;
    if (crashSnapshots.length !== expectedVisibleCrashSnapshots) {
      throw new Error(
        `SQLite repository exposed ${crashSnapshots.length} snapshot(s) at ${params.crashPoint}; expected ${expectedVisibleCrashSnapshots}.`,
      );
    }
    for (const snapshot of visibleAfter) {
      await verifySnapshot({ ...params, snapshot });
    }

    const sourceState = params.verifyState(params.sourcePath);
    assertSameState(sourceState, params.expectedState, `${params.crashPoint} source`);
    const sourcePayload = params.verifyPayload(params.sourcePath);
    assertSamePayload(sourcePayload, params.expectedPayload, `${params.crashPoint} source`);

    const crashSnapshotNames = new Set(
      crashSnapshots.map((snapshot) => path.basename(snapshot.ref.path)),
    );
    const residueEntries = createdEntries.filter((entry) => !crashSnapshotNames.has(entry));
    const stagingEntries = residueEntries.filter((entry) => entry.startsWith(".tmp-")).length;
    const incompleteEntries = residueEntries.length - stagingEntries;
    if (stagingEntries === 0) {
      throw new Error(`SQLite repository worker left no staging at ${params.crashPoint}.`);
    }
    const expectedIncompleteEntries = params.crashPoint === "before-pending" ? 1 : 0;
    if (incompleteEntries !== expectedIncompleteEntries) {
      throw new Error(
        `SQLite repository left ${incompleteEntries} incomplete final entries at ${params.crashPoint}; expected ${expectedIncompleteEntries}.`,
      );
    }

    const retry = await params.provider.create({
      identity: params.identity,
      path: params.sourcePath,
    });
    const retrySnapshot = (await params.provider.list()).find(
      (snapshot) => path.resolve(snapshot.ref.path) === path.resolve(retry.ref.path),
    );
    if (!retrySnapshot) {
      throw new Error(`SQLite repository retry was not visible after ${params.crashPoint}.`);
    }
    await verifySnapshot({ ...params, snapshot: retrySnapshot });
    for (const entry of createdEntries) {
      if (!fs.existsSync(path.join(params.repositoryPath, entry))) {
        throw new Error(`SQLite repository retry removed crash residue it did not own: ${entry}`);
      }
    }

    return {
      crashSnapshotVerifiedAfterCrash: crashSnapshots.length === 1,
      crashSnapshotVisibleAfterCrash: crashSnapshots.length === 1,
      exit,
      incompleteEntries,
      payload: sourcePayload,
      stagingEntries,
      state: sourceState,
      visibleSnapshotsAfterCrash: visibleAfter.length,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildExit(child).catch(() => undefined);
    }
  }
}

export async function runRepositoryInterruptionProof(params: {
  expectedPayload: RepositoryPayload;
  expectedState: ReliabilityStateProof;
  identity: SnapshotDatabaseIdentity;
  repositoryPath: string;
  sourcePath: string;
  validationRootPath: string;
  verifyPayload: (databasePath: string) => RepositoryPayload;
  verifyState: (databasePath: string) => ReliabilityStateProof;
}): Promise<ReliabilityReport["maintenanceProof"]["repositoryInterruption"]> {
  const provider = createLocalSqliteSnapshotProvider({
    repositoryPath: params.repositoryPath,
    validationRootPath: params.validationRootPath,
  });
  const baseline = await provider.create({
    identity: params.identity,
    path: params.sourcePath,
  });
  const baselineSnapshot = (await provider.list()).find(
    (snapshot) => path.resolve(snapshot.ref.path) === path.resolve(baseline.ref.path),
  );
  if (!baselineSnapshot) {
    throw new Error("SQLite repository baseline snapshot was not visible.");
  }
  await verifySnapshot({ ...params, provider, snapshot: baselineSnapshot });

  const beforePending = await runCrashPoint({
    ...params,
    crashPoint: "before-pending",
    provider,
  });
  const pending = await runCrashPoint({
    ...params,
    crashPoint: "pending",
    provider,
  });
  const afterCommit = await runCrashPoint({
    ...params,
    crashPoint: "after-commit",
    provider,
  });

  return {
    afterCommit: {
      ...afterCommit,
      crashSnapshotVerifiedAfterCrash: true,
      crashSnapshotVisibleAfterCrash: true,
      incompleteEntries: 0,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
    },
    beforePending: {
      ...beforePending,
      crashSnapshotVerifiedAfterCrash: false,
      crashSnapshotVisibleAfterCrash: false,
      incompleteEntries: 1,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
    },
    pending: {
      ...pending,
      crashSnapshotVerifiedAfterCrash: true,
      crashSnapshotVisibleAfterCrash: true,
      incompleteEntries: 0,
      repositoryVerified: true,
      retryCreated: true,
      sourcePayloadPreserved: true,
      sourceStatePreserved: true,
    },
  };
}
