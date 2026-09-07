// Run on each revision with: node --expose-gc --import tsx scripts/bench-session-context-navigation.ts
// All state is synthetic and temporary; no Gateway or operator database is opened.
// Optional worker load: OPENCLAW_BENCH_WORKER_CASE=long-reset OPENCLAW_BENCH_ADMISSIONS=4
// Run each worker case in its own process, on both revisions with identical settings.
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  upsertSessionEntryCore,
  type TranscriptEvent,
} from "../src/config/sessions/session-accessor.js";
import { readSessionTranscriptModelContext } from "../src/config/sessions/session-accessor.sqlite-model-context.js";
import {
  appendTranscriptMessage,
  replaceTranscriptEvents,
} from "../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionTranscriptModelContextAsync } from "../src/config/sessions/session-model-context-worker-runtime.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../src/infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

type Shape = "active" | "reset" | "compaction";
type ReadMetrics = {
  navigationSqlMs: number;
  navigationRows: number;
  transactionHoldMs: number;
  transactions: number;
};
type Sample = ReadMetrics & {
  totalReadMs: number;
  events: number;
  contextHash: string;
  before: ReturnType<typeof process.memoryUsage>;
  after: ReturnType<typeof process.memoryUsage>;
  maxRssBytes: number;
};

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hashContext(events: TranscriptEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(canonicalJson(event));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function makeTranscript(sessionId: string, count: number, bodyBytes: number, shape: Shape) {
  const timestamp = "2026-09-01T00:00:00.000Z";
  const body = "x".repeat(bodyBytes);
  const events: TranscriptEvent[] = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: "/synthetic" },
  ];
  let parentId: string | null = null;
  for (let index = 0; index < count; index += 1) {
    // Preserve a complete older tool exchange and two newer exchanges across the boundary.
    if (shape !== "active" && index === count - 8) {
      events.push({
        type: shape,
        id: "boundary",
        parentId,
        timestamp,
        firstKeptEntryId: `message-${count - 12}`,
        ...(shape === "compaction"
          ? { summary: "Synthetic summary of historical exchanges", tokensBefore: count * 2048 }
          : { reason: "reset" }),
      });
      parentId = "boundary";
    }
    const phase = index % 4;
    const content = [{ type: "text", text: body }];
    const message =
      phase === 0
        ? { role: "user", content, timestamp: index }
        : phase === 2
          ? {
              role: "toolResult",
              toolCallId: `call-${index - 1}`,
              toolName: "synthetic",
              content,
              timestamp: index,
            }
          : {
              role: "assistant",
              provider: "openai",
              model: "gpt-4.1",
              api: "openai-responses",
              stopReason: phase === 1 ? "toolUse" : "stop",
              content:
                phase === 1
                  ? [
                      {
                        type: "toolCall",
                        id: `call-${index}`,
                        name: "synthetic",
                        arguments: { payload: body },
                      },
                    ]
                  : content,
              timestamp: index,
            };
    const id = `message-${index}`;
    events.push({ type: "message", id, parentId, timestamp, message });
    parentId = id;
  }
  return events;
}

/** Instrument only the isolated process-owned handle borrowed by the native reader. */
function observeReads(db: DatabaseSync) {
  clearNodeSqliteKyselyCacheForDatabase(db);
  // Capture exact native methods for restoration; calls below supply their receiver.
  const originalExec = Reflect.get(db, "exec") as DatabaseSync["exec"];
  const originalPrepare = Reflect.get(db, "prepare") as DatabaseSync["prepare"];
  const restoreStatements: Array<() => void> = [];
  let current: ReadMetrics | undefined;
  let transactionStart: number | undefined;
  db.exec = function (this: DatabaseSync, sql: string) {
    // Match the production warning: after BEGIN returns, before COMMIT starts.
    if (current && /^(?:COMMIT|ROLLBACK)$/u.test(sql) && transactionStart !== undefined) {
      current.transactionHoldMs += performance.now() - transactionStart;
      current.transactions += 1;
      transactionStart = undefined;
    }
    originalExec.call(this, sql);
    if (current && /^BEGIN(?: DEFERRED)?$/u.test(sql)) {
      transactionStart = performance.now();
    }
  };
  db.prepare = function (this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (!sql.includes('as "navigation_json"')) {
      return statement;
    }
    const originalIterate = Reflect.get(statement, "iterate") as StatementSync["iterate"];
    statement.iterate = function* (
      this: StatementSync,
      ...parameters: SQLInputValue[] | [Record<string, SQLInputValue>, ...SQLInputValue[]]
    ) {
      const start = performance.now();
      // Reflect.apply forwards either native overload without narrowing to the last one.
      const iterator = Reflect.apply(originalIterate, this, parameters) as ReturnType<
        StatementSync["iterate"]
      >;
      if (current) {
        current.navigationSqlMs += performance.now() - start;
      }
      try {
        while (true) {
          // Timing generator creation alone misses SQLite work performed by next().
          const stepStart = performance.now();
          const step = iterator.next();
          if (current) {
            current.navigationSqlMs += performance.now() - stepStart;
            if (!step.done) {
              current.navigationRows += 1;
            }
          }
          if (step.done) {
            return undefined;
          }
          yield step.value;
        }
      } finally {
        iterator.return?.();
      }
    };
    restoreStatements.push(() => {
      statement.iterate = originalIterate;
    });
    return statement;
  };
  return {
    start() {
      current = { navigationSqlMs: 0, navigationRows: 0, transactionHoldMs: 0, transactions: 0 };
      transactionStart = undefined;
      return current;
    },
    stop() {
      current = undefined;
    },
    restore() {
      current = undefined;
      db.exec = originalExec;
      db.prepare = originalPrepare;
      for (const restore of restoreStatements) {
        restore();
      }
      clearNodeSqliteKyselyCacheForDatabase(db);
    },
  };
}

// Select one case per process so the production worker inherits that fixture's
// isolated environment for its entire lifetime. No worker-pool policy is changed.
async function measureWorkerContention(
  scope: Parameters<typeof readSessionTranscriptModelContextAsync>[0],
  expectedHash: string,
  rounds: number,
) {
  const concurrency = integerEnv("OPENCLAW_BENCH_ADMISSIONS", 4, 1, 8);
  const writerScope = {
    ...scope,
    sessionId: "contention-writer",
    sessionKey: "agent:main:contention-writer",
  };
  await upsertSessionEntryCore(writerScope, { sessionId: writerScope.sessionId, updatedAt: 1 });
  // Exclude worker startup and validate that it actually reads the same fixture.
  if (
    hashContext((await readSessionTranscriptModelContextAsync(scope, undefined)).events) !==
    expectedHash
  ) {
    throw new Error("Worker warmup differs from the synchronous reference");
  }
  const batches = [];
  let appended = 0;
  const append = async () => {
    const start = performance.now();
    const result = await appendTranscriptMessage(writerScope, {
      eventId: `writer-${appended}`,
      now: appended + 1,
      message: { role: "user", content: [{ type: "text", text: "synthetic append" }] },
    });
    if (!result.appended) {
      throw new Error("Synthetic writer unexpectedly deduplicated an append");
    }
    appended += 1;
    return performance.now() - start;
  };
  // Do not charge first-use writer/header initialization to the first batch.
  await append();
  for (let round = 0; round < rounds; round += 1) {
    const completion = { readsSettled: false };
    const appendMs: number[] = [];
    const before = process.memoryUsage();
    const start = performance.now();
    const reads = Promise.allSettled(
      Array.from({ length: concurrency }, async () => {
        const admittedAt = performance.now();
        const result = await readSessionTranscriptModelContextAsync(scope, undefined);
        return {
          result,
          latencyMs: performance.now() - admittedAt,
          completedAtMs: performance.now() - start,
        };
      }),
    ).finally(() => {
      completion.readsSettled = true;
    });
    // Same agent DB, different session: real writer/read connection contention
    // without changing the expected context while a read is queued.
    const writes = (async () => {
      while (!completion.readsSettled) {
        appendMs.push(await append());
        await delay(20);
      }
    })();
    const settled = await Promise.allSettled([reads, writes]);
    for (const result of settled) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    // Drain every queued admission before fixture cleanup, including failures.
    const completed = (await reads).map((read) => {
      if (read.status === "rejected") {
        throw read.reason;
      }
      return read.value;
    });
    const after = process.memoryUsage();
    const wallMs = performance.now() - start;
    // Last read completion excludes the writer's final pacing delay and hashing.
    const readWindowMs = Math.max(...completed.map((read) => read.completedAtMs));
    const hashes = completed.map((read) => hashContext(read.result.events));
    if (hashes.some((hash) => hash !== expectedHash)) {
      throw new Error("Concurrent worker read differs from the synchronous reference");
    }
    batches.push({
      readWindowMs,
      wallMs,
      readsPerSecond: (1000 * completed.length) / readWindowMs,
      readLatencyMs: completed.map((read) => read.latencyMs),
      appendMs,
      hashes,
      before,
      after,
    });
  }
  const writer = readSessionTranscriptModelContext(writerScope);
  if (
    writer.events.filter((event) => isRecord(event) && event.type === "message").length !== appended
  ) {
    throw new Error("Committed synthetic writer messages were lost");
  }
  return { concurrency, writerCadenceMs: 20, warmupAppends: 1, appended, batches };
}

async function main() {
  const samples = integerEnv("OPENCLAW_BENCH_SAMPLES", 5, 1, 50);
  const warmups = integerEnv("OPENCLAW_BENCH_WARMUPS", 1, 1, 10);
  const longEvents = integerEnv("OPENCLAW_BENCH_EVENTS", 4000, 24, 10000);
  const bodyBytes = integerEnv("OPENCLAW_BENCH_EVENT_BYTES", 8192, 128, 65536);
  const workerCase = process.env.OPENCLAW_BENCH_WORKER_CASE;
  if (workerCase && !/^(short|long)-(active|reset|compaction)$/u.test(workerCase)) {
    throw new Error("OPENCLAW_BENCH_WORKER_CASE must select short/long-active/reset/compaction");
  }
  if (longEvents % 4 !== 0 || longEvents * bodyBytes > 256 * 1024 * 1024) {
    throw new Error(
      "OPENCLAW_BENCH_EVENTS must be divisible by four; each fixture must fit 256 MiB of message bodies",
    );
  }
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  const cases: Array<{
    size: "short" | "long";
    shape: Shape;
    messages: number;
    transcriptBytes: number;
    samples: Sample[];
    workerContention?: Awaited<ReturnType<typeof measureWorkerContention>>;
    median: {
      navigationSqlMs: number;
      transactionHoldMs: number;
      totalReadMs: number;
      heapUsedDeltaBytes: number;
      rssDeltaBytes: number;
    };
  }> = [];
  for (const [size, count] of [
    ["short", 24],
    ["long", longEvents],
  ] as const) {
    for (const shape of ["active", "reset", "compaction"] as const) {
      if (workerCase && workerCase !== `${size}-${shape}`) {
        continue;
      }
      await withOpenClawTestState({ label: "context-navigation-benchmark" }, async (state) => {
        const sessionId = `${size}-${shape}`;
        const scope = {
          agentId: "main",
          sessionId,
          sessionKey: `agent:main:${sessionId}`,
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
        const events = makeTranscript(sessionId, count, bodyBytes, shape);
        const transcriptBytes = events.reduce<number>(
          (sum, event) => sum + Buffer.byteLength(JSON.stringify(event)),
          0,
        );
        await replaceTranscriptEvents(scope, events);
        events.length = 0;
        const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
        const observer = observeReads(db);
        const results: Sample[] = [];
        try {
          for (let run = -warmups; run < samples; run += 1) {
            gc?.();
            const before = process.memoryUsage();
            const measured = observer.start();
            const start = performance.now();
            const context = readSessionTranscriptModelContext(scope);
            const totalReadMs = performance.now() - start;
            observer.stop();
            const after = process.memoryUsage();
            if (
              measured.transactions !== 1 ||
              measured.navigationRows !== count + (shape === "active" ? 1 : 2)
            ) {
              throw new Error(
                `Native reader instrumentation missed the snapshot or navigation rows for ${sessionId}`,
              );
            }
            if (run >= 0) {
              results.push({
                ...measured,
                totalReadMs,
                before,
                after,
                maxRssBytes: process.resourceUsage().maxRSS * 1024,
                events: context.events.length,
                contextHash: hashContext(context.events),
              });
            }
          }
        } finally {
          observer.restore();
        }
        if (new Set(results.map((result) => result.contextHash)).size !== 1) {
          throw new Error(`Non-deterministic context output for ${sessionId}`);
        }
        const workerContention = workerCase
          ? await measureWorkerContention(scope, results[0]!.contextHash, samples)
          : undefined;
        cases.push({
          size,
          shape,
          messages: count,
          transcriptBytes,
          samples: results,
          ...(workerContention ? { workerContention } : {}),
          median: {
            navigationSqlMs: median(results.map((result) => result.navigationSqlMs)),
            transactionHoldMs: median(results.map((result) => result.transactionHoldMs)),
            totalReadMs: median(results.map((result) => result.totalReadMs)),
            heapUsedDeltaBytes: median(
              results.map((result) => result.after.heapUsed - result.before.heapUsed),
            ),
            rssDeltaBytes: median(results.map((result) => result.after.rss - result.before.rss)),
          },
        });
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        node: process.version,
        sqlite: process.versions.sqlite,
        warmups,
        samples,
        bodyBytes,
        gcAvailable: Boolean(gc),
        notes: [
          "Native samples are warm synchronous reads. Optional workerContention measures queued production-worker admissions with same-DB, different-session appends.",
          "Worker batches include queueing and result transfer; hashing is outside read latency. Worker startup is excluded. Append rate is paced, not saturated throughput.",
          "Neither mode measures end-to-end Gateway or model-turn latency, or establishes uniform gains across workloads.",
          "Navigation SQL time includes iterator construction and next() calls, excluding SQL preparation, JavaScript parsing and tree traversal.",
          "Iterator timing adds measurement overhead. Compare identical scripts and host conditions across revisions.",
          "Hashes cover canonicalized returned events, not randomized rewrite-generation metadata.",
          "RSS/heap are process snapshots; maxRSS is the process lifetime high-water mark including imports and fixture creation, not a per-read peak.",
          "Synthetic tool exchanges and boundaries are performance fixtures, not a substitute for correctness and concurrency tests.",
        ],
        cases,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
