import { fork, type ChildProcess } from "node:child_process";
import { setImmediate as delayImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";
import {
  COMMITTED_WAL_SENTINEL,
  STRESS_TABLE_SQL,
  type ProfileConfig,
} from "./sqlite-reliability-contract.js";

type WriterReadyMessage = {
  kind: "ready";
};

type WriterPartialMessage = {
  batch: number;
  kind: "partial";
  rows: number;
};

type WriterReleasedMessage = {
  batch: number;
  kind: "released";
};

type WriterResultMessage = {
  batchesCommitted: number;
  kind: "result";
  rowsCommitted: number;
};

type WriterErrorMessage = {
  error: string;
  kind: "error";
};

type WriterMessage =
  | WriterReadyMessage
  | WriterPartialMessage
  | WriterReleasedMessage
  | WriterResultMessage
  | WriterErrorMessage;

export type WriterHandle = {
  child: ChildProcess;
  stderr: string[];
  stopped: boolean;
};

const WRITER_MESSAGE_TIMEOUT_MS = 30_000;

export function startWriter(databasePath: string, profile: ProfileConfig): WriterHandle {
  const child = fork(
    fileURLToPath(import.meta.url),
    [
      databasePath,
      String(profile.rowsPerBatch),
      String(profile.payloadBytes),
      String(profile.retainedBatches),
      String(profile.walAutoCheckpointPages),
      String(profile.maxWalBytes),
      String(profile.writerPauseMs),
    ],
    {
      execArgv: ["--import", "tsx"],
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr.push(chunk);
  });
  return { child, stderr, stopped: false };
}

export async function waitForWriterMessage<T extends WriterMessage["kind"]>(
  writer: WriterHandle,
  kind: T,
  action?: () => void,
): Promise<Extract<WriterMessage, { kind: T }>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `SQLite reliability writer timed out waiting for ${kind}.${formatWriterStderr(writer)}`,
        ),
      );
    }, WRITER_MESSAGE_TIMEOUT_MS);
    const onMessage = (message: WriterMessage) => {
      if (message.kind === "error") {
        cleanup();
        reject(new Error(`SQLite reliability writer failed: ${message.error}`));
        return;
      }
      if (message.kind !== kind) {
        return;
      }
      cleanup();
      resolve(message as Extract<WriterMessage, { kind: T }>);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `SQLite reliability writer exited before ${kind}: code=${String(code)} signal=${String(signal)}.${formatWriterStderr(writer)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      writer.child.off("message", onMessage);
      writer.child.off("error", onError);
      writer.child.off("exit", onExit);
    };
    writer.child.on("message", onMessage);
    writer.child.on("error", onError);
    writer.child.on("exit", onExit);
    action?.();
  });
}

function formatWriterStderr(writer: WriterHandle): string {
  const text = writer.stderr.join("").trim();
  return text ? ` stderr=${JSON.stringify(text)}` : "";
}

export async function stopWriter(writer: WriterHandle): Promise<WriterResultMessage> {
  if (writer.stopped) {
    throw new Error("SQLite reliability writer was already stopped.");
  }
  const result = await waitForWriterMessage(writer, "result", () => {
    writer.child.send?.({ kind: "stop" });
  });
  await waitForChildExit(writer.child);
  writer.stopped = true;
  return result;
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("SQLite reliability writer did not exit after stopping."));
    }, WRITER_MESSAGE_TIMEOUT_MS);
    const onExit = () => {
      cleanup();
      resolve();
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

export async function terminateWriter(writer: WriterHandle): Promise<void> {
  if (writer.child.exitCode !== null || writer.child.signalCode !== null) {
    return;
  }
  writer.child.kill();
  await waitForChildExit(writer.child).catch(() => undefined);
}

function parseWriterChildArgs(argv: string[]): {
  databasePath: string;
  payloadBytes: number;
  retainedBatches: number;
  rowsPerBatch: number;
  walAutoCheckpointPages: number;
  walSizeLimitBytes: number;
  writerPauseMs: number;
} {
  const [
    databasePath,
    rowsRaw,
    payloadRaw,
    retainedRaw,
    checkpointRaw,
    walSizeLimitRaw,
    pauseRaw,
    ...extra
  ] = argv;
  const rowsPerBatch = Number(rowsRaw);
  const payloadBytes = Number(payloadRaw);
  const retainedBatches = Number(retainedRaw);
  const walAutoCheckpointPages = Number(checkpointRaw);
  const walSizeLimitBytes = Number(walSizeLimitRaw);
  const writerPauseMs = Number(pauseRaw);
  if (
    !databasePath ||
    extra.length > 0 ||
    !Number.isSafeInteger(rowsPerBatch) ||
    rowsPerBatch < 2 ||
    !Number.isSafeInteger(payloadBytes) ||
    payloadBytes < 1 ||
    !Number.isSafeInteger(retainedBatches) ||
    retainedBatches < 1 ||
    !Number.isSafeInteger(walAutoCheckpointPages) ||
    walAutoCheckpointPages < 1 ||
    !Number.isSafeInteger(walSizeLimitBytes) ||
    walSizeLimitBytes < 1 ||
    !Number.isSafeInteger(writerPauseMs) ||
    writerPauseMs < 0
  ) {
    throw new Error("invalid SQLite reliability writer arguments");
  }
  return {
    databasePath,
    payloadBytes,
    retainedBatches,
    rowsPerBatch,
    walAutoCheckpointPages,
    walSizeLimitBytes,
    writerPauseMs,
  };
}

async function runWriterChild(argv: string[]): Promise<void> {
  const options = parseWriterChildArgs(argv);
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(options.databasePath);
  let nextBatch = 0;
  let batchesCommitted = 0;
  let rowsCommitted = 0;
  let stopping = false;
  let holdPartial = false;
  let releasePartial: "commit" | "rollback" | undefined;
  const payload = "x".repeat(options.payloadBytes);
  const requestStop = () => {
    stopping = true;
    releasePartial ??= "rollback";
  };
  const sendMessage = (message: WriterMessage) => {
    if (process.connected) {
      process.send?.(message);
    }
  };
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`PRAGMA wal_autocheckpoint = ${options.walAutoCheckpointPages};`);
    database.exec(`PRAGMA journal_size_limit = ${options.walSizeLimitBytes};`);
    database.exec("PRAGMA busy_timeout = 30000;");
    database.exec(STRESS_TABLE_SQL);
    const next = database
      .prepare(
        "SELECT COALESCE(MAX(batch), -1) + 1 AS next_batch FROM openclaw_reliability_entries",
      )
      .get() as { next_batch?: number | bigint };
    nextBatch = Number(next.next_batch ?? 0);
    const insert = database.prepare(
      "INSERT INTO openclaw_reliability_entries (batch, ordinal, payload) VALUES (?, ?, ?)",
    );
    const insertSentinel = database.prepare(
      "INSERT INTO openclaw_reliability_sentinel (id, payload) VALUES (1, ?)",
    );
    const deleteExpired = database.prepare(
      "DELETE FROM openclaw_reliability_entries WHERE batch < ?",
    );
    process.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const command = message as { action?: unknown; kind?: unknown };
      if (command.kind === "stop") {
        requestStop();
      } else if (command.kind === "hold-partial") {
        holdPartial = true;
      } else if (
        command.kind === "release-partial" &&
        (command.action === "commit" || command.action === "rollback")
      ) {
        releasePartial = command.action;
      }
    });
    process.on("disconnect", requestStop);
    if (!process.connected) {
      requestStop();
    }
    const shouldStop = () => stopping;
    const shouldReleasePartial = () => releasePartial !== undefined || stopping;

    const commitBatch = (includeSentinel = false) => {
      database.exec("BEGIN IMMEDIATE;");
      try {
        if (includeSentinel) {
          insertSentinel.run(COMMITTED_WAL_SENTINEL);
        }
        for (let ordinal = 0; ordinal < options.rowsPerBatch; ordinal += 1) {
          insert.run(nextBatch, ordinal, `${nextBatch}:${ordinal}:${payload}`);
        }
        deleteExpired.run(Math.max(0, nextBatch - options.retainedBatches + 1));
        database.exec("COMMIT;");
        nextBatch += 1;
        batchesCommitted += 1;
        rowsCommitted += options.rowsPerBatch;
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
    };

    commitBatch(true);
    sendMessage({ kind: "ready" } satisfies WriterReadyMessage);
    while (!shouldStop()) {
      if (holdPartial) {
        holdPartial = false;
        const heldBatch = nextBatch;
        const heldRows = Math.max(1, Math.floor(options.rowsPerBatch / 2));
        database.exec("BEGIN IMMEDIATE;");
        try {
          for (let ordinal = 0; ordinal < heldRows; ordinal += 1) {
            insert.run(heldBatch, ordinal, `${heldBatch}:${ordinal}:${payload}`);
          }
          sendMessage({
            batch: heldBatch,
            kind: "partial",
            rows: heldRows,
          } satisfies WriterPartialMessage);
          while (!shouldReleasePartial()) {
            await delay(1);
          }
          if (releasePartial === "commit") {
            for (let ordinal = heldRows; ordinal < options.rowsPerBatch; ordinal += 1) {
              insert.run(heldBatch, ordinal, `${heldBatch}:${ordinal}:${payload}`);
            }
            database.exec("COMMIT;");
            nextBatch += 1;
            batchesCommitted += 1;
            rowsCommitted += options.rowsPerBatch;
          } else {
            database.exec("ROLLBACK;");
          }
          releasePartial = undefined;
          sendMessage({ batch: heldBatch, kind: "released" } satisfies WriterReleasedMessage);
        } catch (error) {
          database.exec("ROLLBACK;");
          throw error;
        }
      } else {
        commitBatch();
      }
      if (options.writerPauseMs > 0) {
        await delay(options.writerPauseMs);
      } else {
        await delayImmediate();
      }
    }
    sendMessage({
      batchesCommitted,
      kind: "result",
      rowsCommitted,
    } satisfies WriterResultMessage);
  } catch (error) {
    sendMessage({
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      kind: "error",
    } satisfies WriterErrorMessage);
    process.exitCode = 1;
  } finally {
    database.close();
    if (process.connected) {
      process.disconnect?.();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runWriterChild(process.argv.slice(2));
}
