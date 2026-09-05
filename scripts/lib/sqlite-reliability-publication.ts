import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createVerifiedSqliteSnapshot } from "../../src/infra/sqlite-snapshot.js";
import {
  assertSameReliabilityState,
  type ReliabilityReport,
  type ReliabilityStateProof,
} from "./sqlite-reliability-contract.js";

type PublicationCrashPoint = "after-publish" | "before-publish";
type PublicationExit = ReliabilityReport["publicationInterruptionProof"]["beforePublish"]["exit"];

type CrashPointResult = {
  exit: PublicationExit;
  sourceStatePreserved: true;
  stagingEntries: number;
  targetState: ReliabilityStateProof | null;
  targetVisibleAfterCrash: boolean;
};

const PUBLICATION_WORKER_PATH = fileURLToPath(
  new URL("./sqlite-reliability-publication-worker.ts", import.meta.url),
);
const CRASH_POINT_TIMEOUT_MS = 120_000;

function assertNoSqliteSidecars(targetPath: string): void {
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    if (fs.existsSync(`${targetPath}${suffix}`)) {
      throw new Error(
        `publication crash left an unexpected SQLite sidecar: ${targetPath}${suffix}`,
      );
    }
  }
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listCrashStagingEntries(scratchPath: string): string[] {
  return fs
    .readdirSync(scratchPath)
    .filter(
      (entry) => entry.startsWith(".sqlite-publish-") || entry.startsWith(".sqlite-snapshot-"),
    );
}

async function waitForCrashPoint(params: {
  child: ReturnType<typeof spawn>;
  markerPath: string;
  readStderr: () => string;
}): Promise<void> {
  const deadline = Date.now() + CRASH_POINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(params.markerPath)) {
      return;
    }
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
        `SQLite publication worker exited before its crash point: ${params.readStderr().trim()}`,
      );
    }
    await delay(5);
  }
  throw new Error(`SQLite publication worker did not reach its crash point within 120 seconds.`);
}

async function runCrashPoint(params: {
  crashPoint: PublicationCrashPoint;
  expectedState: ReliabilityStateProof;
  scratchPath: string;
  sourcePath: string;
  verifyDatabase: (databasePath: string) => ReliabilityStateProof;
}): Promise<CrashPointResult> {
  const targetPath = path.join(params.scratchPath, `${params.crashPoint}.sqlite`);
  const markerPath = path.join(params.scratchPath, `${params.crashPoint}.ready`);
  let stderr = "";
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      PUBLICATION_WORKER_PATH,
      params.crashPoint,
      params.sourcePath,
      targetPath,
      markerPath,
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitPromise = new Promise<PublicationExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let crashStagingEntries: string[];
  try {
    await waitForCrashPoint({ child, markerPath, readStderr: () => stderr });
    const targetVisibleAfterCrash = fs.existsSync(targetPath);
    crashStagingEntries = listCrashStagingEntries(params.scratchPath);
    if (crashStagingEntries.length === 0) {
      throw new Error(`SQLite publication worker reached ${params.crashPoint} without staging.`);
    }
    if (!child.kill("SIGKILL")) {
      throw new Error(`SQLite publication worker could not be terminated at ${params.crashPoint}.`);
    }
    const exit = await exitPromise;
    if (exit.code === null && exit.signal === null) {
      throw new Error(`SQLite publication worker reported no forced exit at ${params.crashPoint}.`);
    }

    const sourceState = params.verifyDatabase(params.sourcePath);
    assertSameReliabilityState(sourceState, params.expectedState, `${params.crashPoint} source`);
    let targetState: ReliabilityStateProof | null = null;
    if (targetVisibleAfterCrash) {
      assertNoSqliteSidecars(targetPath);
      targetState = params.verifyDatabase(targetPath);
      assertSameReliabilityState(targetState, params.expectedState, `${params.crashPoint} target`);
    }

    if (params.crashPoint === "before-publish") {
      await createVerifiedSqliteSnapshot({
        sourcePath: params.sourcePath,
        targetPath,
      });
      assertNoSqliteSidecars(targetPath);
      const retryState = params.verifyDatabase(targetPath);
      assertSameReliabilityState(retryState, params.expectedState, `${params.crashPoint} retry`);
    } else {
      const targetHash = hashFile(targetPath);
      let retryError: unknown;
      try {
        await createVerifiedSqliteSnapshot({
          sourcePath: params.sourcePath,
          targetPath,
        });
      } catch (error) {
        retryError = error;
      }
      if (!(retryError instanceof Error) || !/target already exists/iu.test(retryError.message)) {
        throw new Error("SQLite retry did not preserve the already-published target.", {
          cause: retryError,
        });
      }
      assertNoSqliteSidecars(targetPath);
      if (hashFile(targetPath) !== targetHash) {
        throw new Error("SQLite retry changed the already-published target.");
      }
      const preservedState = params.verifyDatabase(targetPath);
      assertSameReliabilityState(
        preservedState,
        params.expectedState,
        `${params.crashPoint} retry`,
      );
    }
    for (const entry of crashStagingEntries) {
      if (!fs.existsSync(path.join(params.scratchPath, entry))) {
        throw new Error(`SQLite retry removed crash staging it did not own: ${entry}`);
      }
    }

    return {
      exit,
      sourceStatePreserved: true,
      stagingEntries: crashStagingEntries.length,
      targetState,
      targetVisibleAfterCrash,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exitPromise.catch(() => undefined);
    }
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(targetPath, { force: true });
    for (const entry of listCrashStagingEntries(params.scratchPath)) {
      fs.rmSync(path.join(params.scratchPath, entry), { force: true, recursive: true });
    }
  }
}

export async function runPublicationInterruptionProof(params: {
  expectedState: ReliabilityStateProof;
  scratchPath: string;
  sourcePath: string;
  verifyDatabase: (databasePath: string) => ReliabilityStateProof;
}): Promise<ReliabilityReport["publicationInterruptionProof"]> {
  fs.mkdirSync(params.scratchPath, { recursive: true, mode: 0o700 });
  const beforePublish = await runCrashPoint({
    ...params,
    crashPoint: "before-publish",
  });
  if (beforePublish.targetVisibleAfterCrash || beforePublish.targetState) {
    throw new Error("SQLite snapshot became visible before publication.");
  }

  const afterPublish = await runCrashPoint({
    ...params,
    crashPoint: "after-publish",
  });
  if (!afterPublish.targetVisibleAfterCrash || !afterPublish.targetState) {
    throw new Error("SQLite snapshot was not complete after durable publication.");
  }

  return {
    afterPublish: {
      existingTargetPreserved: true,
      exit: afterPublish.exit,
      recoveryVerified: true,
      sourceStatePreserved: true,
      stagingEntries: afterPublish.stagingEntries,
      targetVerifiedAfterCrash: true,
      targetVisibleAfterCrash: true,
    },
    beforePublish: {
      exit: beforePublish.exit,
      recoveryVerified: true,
      retryPublished: true,
      sourceStatePreserved: true,
      stagingEntries: beforePublish.stagingEntries,
      targetVerifiedAfterCrash: false,
      targetVisibleAfterCrash: false,
    },
  };
}
