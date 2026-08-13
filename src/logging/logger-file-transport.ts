// Bounded asynchronous JSONL file transport for the process logger.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { appendRegularFile, appendRegularFileSync } from "../infra/regular-file.js";
import { formatConsoleDiagnosticLine } from "./json-console-line.js";
import { redactSensitiveText } from "./redact.js";
import { formatTimestamp } from "./timestamps.js";

// Keep burst memory bounded while one equally bounded batch is in flight.
const DEFAULT_MAX_QUEUED_RECORDS = 4_096;
const MAX_ROTATED_LOG_FILES = 5;

type FileLogQueueEntry = {
  file: string;
  hostname: string;
  maxFileBytes: number;
  payload: string;
};

type FileCursor = {
  bytes: number;
};

type FileLogAppender = typeof appendRegularFile;

let queue: FileLogQueueEntry[] = [];
let queueStart = 0;
let activeBatch: FileLogQueueEntry[] | null = null;
let activeIndex = 0;
let activeAppendInFlight = false;
let droppedCount = 0;
let droppedTarget: FileLogQueueEntry | null = null;
let maxQueuedRecords = DEFAULT_MAX_QUEUED_RECORDS;
let scheduledFlush: NodeJS.Immediate | null = null;
let flushPromise: Promise<void> | null = null;
let drainGeneration = 0;
let processExiting = false;
let processHooksInstalled = false;
let appendFile: FileLogAppender = appendRegularFile;
const warnedRotationFiles = new Map<string, number>();

function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

function rotateLogFile(file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
    for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(file, index);
      if (fs.existsSync(from)) {
        fs.renameSync(from, rotatedLogPath(file, index + 1));
      }
    }
    if (fs.existsSync(file)) {
      fs.renameSync(file, rotatedLogPath(file, 1));
    }
    return true;
  } catch {
    return false;
  }
}

async function getCurrentLogFileBytes(file: string): Promise<number> {
  try {
    return (await fsPromises.stat(file)).size;
  } catch {
    return 0;
  }
}

function getCurrentLogFileBytesSync(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function buildDroppedMarker(target: FileLogQueueEntry, count: number): FileLogQueueEntry {
  const date = new Date();
  const message = `[openclaw] file log queue overflow; dropped ${count} oldest record${count === 1 ? "" : "s"}`;
  const record = {
    0: message,
    _meta: {
      date,
      hostname: target.hostname,
      logLevelName: "WARN",
      name: "openclaw",
    },
    time: formatTimestamp(date, { style: "long" }),
    hostname: target.hostname,
    message,
    dropped: count,
  };
  return {
    ...target,
    payload: `${redactSensitiveText(JSON.stringify(record))}\n`,
  };
}

function warnAboutRotationFailure(entry: FileLogQueueEntry): void {
  if (warnedRotationFiles.get(entry.file) === entry.maxFileBytes) {
    return;
  }
  warnedRotationFiles.set(entry.file, entry.maxFileBytes);
  const message = `[openclaw] log file rotation failed; continuing writes file=${entry.file} maxFileBytes=${entry.maxFileBytes}`;
  try {
    process.stderr.write(`${formatConsoleDiagnosticLine({ level: "warn", message })}\n`);
  } catch {
    // Logging diagnostics must not stop the file queue.
  }
}

function claimQueuedEntries(): FileLogQueueEntry[] {
  const entries =
    queueStart === 0 ? queue : [...queue.slice(queueStart), ...queue.slice(0, queueStart)];
  queue = [];
  queueStart = 0;
  if (droppedCount > 0 && droppedTarget) {
    entries.unshift(buildDroppedMarker(droppedTarget, droppedCount));
  }
  droppedCount = 0;
  droppedTarget = null;
  return entries;
}

function rotateIfNeeded(entry: FileLogQueueEntry, cursor: FileCursor): void {
  const payloadBytes = Buffer.byteLength(entry.payload, "utf8");
  if (cursor.bytes === 0 || cursor.bytes + payloadBytes <= entry.maxFileBytes) {
    return;
  }
  if (rotateLogFile(entry.file)) {
    cursor.bytes = 0;
    warnedRotationFiles.delete(entry.file);
  } else {
    warnAboutRotationFailure(entry);
  }
}

async function writeEntries(entries: FileLogQueueEntry[], generation: number): Promise<void> {
  const cursors = new Map<string, FileCursor>();
  let index = 0;
  while (index < entries.length) {
    if (generation !== drainGeneration || processExiting) {
      return;
    }
    const entry = entries[index];
    if (!entry) {
      return;
    }
    let cursor = cursors.get(entry.file);
    if (!cursor) {
      cursor = { bytes: await getCurrentLogFileBytes(entry.file) };
      if (generation !== drainGeneration || processExiting) {
        return;
      }
      cursors.set(entry.file, cursor);
    }
    rotateIfNeeded(entry, cursor);
    const payloadBytes = Buffer.byteLength(entry.payload, "utf8");
    activeAppendInFlight = true;
    try {
      await appendFile({ filePath: entry.file, content: entry.payload });
      cursor.bytes += payloadBytes;
    } catch {
      // Match the old best-effort transport: a failed append must not stop later records.
    } finally {
      activeAppendInFlight = false;
    }
    activeIndex = index + 1;
    index += 1;
  }
}

function writeEntriesSync(entries: FileLogQueueEntry[]): void {
  const cursors = new Map<string, FileCursor>();
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    let cursor = cursors.get(entry.file);
    if (!cursor) {
      cursor = { bytes: getCurrentLogFileBytesSync(entry.file) };
      cursors.set(entry.file, cursor);
    }
    rotateIfNeeded(entry, cursor);
    const payloadBytes = Buffer.byteLength(entry.payload, "utf8");
    try {
      appendRegularFileSync({ filePath: entry.file, content: entry.payload });
      cursor.bytes += payloadBytes;
    } catch {
      // Match the old best-effort transport: a failed append must not stop later records.
    }
    index += 1;
  }
}

async function runFlushLoop(): Promise<void> {
  const generation = drainGeneration;
  for (;;) {
    if (generation !== drainGeneration || processExiting) {
      return;
    }
    const entries = claimQueuedEntries();
    if (entries.length === 0) {
      return;
    }
    activeBatch = entries;
    activeIndex = 0;
    await writeEntries(entries, generation);
    if (generation !== drainGeneration) {
      return;
    }
    activeBatch = null;
    activeIndex = 0;
  }
}

function startFlush(): void {
  if (flushPromise || processExiting) {
    return;
  }
  const running = runFlushLoop().catch(() => undefined);
  flushPromise = running;
  void running.then(() => {
    if (flushPromise === running) {
      flushPromise = null;
    }
    if (queue.length > 0 || droppedCount > 0) {
      scheduleFlush();
    }
  });
}

function scheduleFlush(): void {
  if (scheduledFlush || flushPromise || processExiting) {
    return;
  }
  scheduledFlush = setImmediate(() => {
    scheduledFlush = null;
    startFlush();
  });
}

function handleProcessBeforeExit(): void {
  void flushFileLogQueue();
}

function handleProcessExit(): void {
  processExiting = true;
  drainFileLogQueueSync();
}

function installProcessHooks(): void {
  if (processHooksInstalled) {
    return;
  }
  processHooksInstalled = true;
  process.on("beforeExit", handleProcessBeforeExit);
  process.on("exit", handleProcessExit);
}

function removeProcessHooks(): void {
  if (!processHooksInstalled) {
    return;
  }
  process.removeListener("beforeExit", handleProcessBeforeExit);
  process.removeListener("exit", handleProcessExit);
  processHooksInstalled = false;
}

// Production installs eagerly so logs emitted by another exit listener are still rescued.
// Vitest shared workers reload modules, so defer there until file logging is actually used.
if (process.env.VITEST !== "true") {
  installProcessHooks();
}

/** Enqueues one serialized record without waiting for filesystem I/O. */
function enqueueFileLog(entry: FileLogQueueEntry): void {
  if (processExiting) {
    writeEntriesSync([entry]);
    return;
  }
  installProcessHooks();
  // Keep the newest diagnostics and report every eviction once in the next drain batch.
  if (queue.length >= maxQueuedRecords) {
    const dropped = queue[queueStart];
    if (dropped) {
      droppedTarget ??= dropped;
      droppedCount += 1;
    }
    queue[queueStart] = entry;
    queueStart = (queueStart + 1) % queue.length;
  } else {
    queue.push(entry);
  }
  scheduleFlush();
}

/** Waits until every record currently queued for the async transport has settled. */
async function flushFileLogQueue(): Promise<void> {
  for (;;) {
    if (scheduledFlush) {
      clearImmediate(scheduledFlush);
      scheduledFlush = null;
    }
    if (!flushPromise && (queue.length > 0 || droppedCount > 0)) {
      startFlush();
    }
    const running = flushPromise;
    if (!running) {
      return;
    }
    await running;
  }
}

/** Synchronously rescues pending records for process.exit() and crash-adjacent paths. */
function drainFileLogQueueSync(): void {
  if (scheduledFlush) {
    clearImmediate(scheduledFlush);
    scheduledFlush = null;
  }
  drainGeneration += 1;
  // An issued append cannot be cancelled or safely replayed. Graceful exits await it; forced
  // exits rescue the still-queued tail without risking duplicate or interleaved JSONL records.
  const drainIndex = activeIndex + (activeAppendInFlight ? 1 : 0);
  const entries = activeBatch ? activeBatch.slice(drainIndex) : [];
  activeBatch = null;
  activeIndex = 0;
  entries.push(...claimQueuedEntries());
  writeEntriesSync(entries);
}

function setFileLogQueueMaxRecordsForTests(value?: number): void {
  maxQueuedRecords = Math.max(1, value ?? DEFAULT_MAX_QUEUED_RECORDS);
}

function setFileLogAppenderForTests(value?: FileLogAppender): void {
  appendFile = value ?? appendRegularFile;
}

function resetFileLogTransportForTests(): void {
  drainFileLogQueueSync();
  removeProcessHooks();
  processExiting = false;
  appendFile = appendRegularFile;
  maxQueuedRecords = DEFAULT_MAX_QUEUED_RECORDS;
  warnedRotationFiles.clear();
}

export const fileLogTransport = {
  drainSync: drainFileLogQueueSync,
  enqueue: enqueueFileLog,
  flush: flushFileLogQueue,
  resetForTests: resetFileLogTransportForTests,
  setAppenderForTests: setFileLogAppenderForTests,
  setMaxQueuedRecordsForTests: setFileLogQueueMaxRecordsForTests,
};
