// Voice Call plugin module implements cli call log commands.
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sleep } from "../api.js";
import { parseCliInteger, writeCliJson } from "./cli-command-io.js";
import { getCallHistoryFromStore, MAX_CALL_RECORD_EVENTS } from "./manager/store.js";

const READ_BYTES = 64 * 1024;
type LogLine = { fd: number; start: number; end: number };

async function writeLogChunk(chunk: string | Buffer): Promise<void> {
  if (!process.stdout.write(chunk)) {
    await once(process.stdout, "drain");
  }
}

function* readLogLine({ fd, start, end }: LogLine): Generator<Buffer> {
  for (let offset = start; offset < end;) {
    const chunk = Buffer.alloc(Math.min(READ_BYTES, end - offset));
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
    if (!bytesRead) {
      throw new Error("Voice-call log was truncated while reading a record");
    }
    offset += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
}

async function* readLogLines(file: string, last: number, pollMs?: number): AsyncGenerator<LogLine> {
  let initial = true;
  let offset = 0;
  let lineStart = 0;
  let previous: fs.Stats | undefined;
  const buffer = Buffer.alloc(READ_BYTES);
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch (error) {
      if (initial || pollMs === undefined || !isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
      // Rotation may temporarily remove the path; retain the old cursor until its replacement opens.
      await sleep(pollMs);
      continue;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (
        previous &&
        (stat.ino !== previous.ino || stat.dev !== previous.dev || stat.size < previous.size)
      ) {
        offset = lineStart = 0;
      }
      previous = stat;
      // Retain positions, not record contents. A partial record can span any number of polls.
      const selected: LogLine[] = [];
      let count = 0;
      while (offset < stat.size) {
        const length = Math.min(buffer.length, stat.size - offset);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        if (!bytesRead) {
          break;
        }
        const start = offset;
        offset += bytesRead;
        for (
          let index = buffer.indexOf(10);
          index >= 0 && index < bytesRead;
          index = buffer.indexOf(10, index + 1)
        ) {
          const line = { fd, start: lineStart, end: start + index };
          lineStart = line.end + 1;
          if (line.end > line.start) {
            if (!initial) {
              yield line;
            } else if (last > 0) {
              selected[count++ % last] = line;
            }
          }
        }
        // Check copytruncate against the observed size before retrying a short follow read.
        if (!initial && bytesRead < length) {
          break;
        }
      }
      if (pollMs === undefined && lineStart < offset) {
        selected[count++ % last] = { fd, start: lineStart, end: offset };
      }
      // The next overwrite slot is the oldest retained line.
      yield* selected.splice(last === 0 ? 0 : count % last);
      yield* selected;
    } finally {
      // The descriptor also closes if the consumer fails while waiting for stdout.
      fs.closeSync(fd);
    }
    initial = false;
    if (pollMs === undefined) {
      return;
    }
    await sleep(pollMs);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function summarizeSeries(values: number[]): {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
} {
  if (values.length === 0) {
    return { count: 0, minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0 };
  }

  // Reduce instead of Math.min(...values): spread throws past V8's argument
  // cap, and `latency --last <n>` can scan an unbounded JSONL history.
  const minMs = values.reduce((min, value) => (value < min ? value : min));
  const maxMs = values.reduce((max, value) => (value > max ? value : max));
  const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    count: values.length,
    minMs,
    maxMs,
    avgMs,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  };
}

async function writeVoiceCallLatencySummary(calls: Iterable<unknown> | AsyncIterable<unknown>) {
  let recordsScanned = 0;
  const turnLatencyMs: number[] = [];
  const listenWaitMs: number[] = [];

  for await (const call of calls) {
    recordsScanned++;
    const metadata = isRecord(call) && isRecord(call.metadata) ? call.metadata : undefined;
    const latency = metadata?.lastTurnLatencyMs;
    const listenWait = metadata?.lastTurnListenWaitMs;
    if (typeof latency === "number" && Number.isFinite(latency)) {
      turnLatencyMs.push(latency);
    }
    if (typeof listenWait === "number" && Number.isFinite(listenWait)) {
      listenWaitMs.push(listenWait);
    }
  }

  writeCliJson({
    recordsScanned,
    turnLatency: summarizeSeries(turnLatencyMs),
    listenWait: summarizeSeries(listenWaitMs),
  });
}

export function registerVoiceCallLogs(params: {
  root: Command;
  defaultFile: string;
  ensureHistoryStateRuntime: () => void;
}): void {
  params.root
    .command("tail")
    .description("Tail persisted voice-call records or a custom JSONL log")
    .option("--file <path>", "Path to calls.jsonl", params.defaultFile)
    .option("--since <n>", "Print last N lines first", "25")
    .option("--poll <ms>", "Poll interval in ms", "250")
    .action(async (options: { file: string; since?: string; poll?: string }) => {
      const file = options.file;
      const since = parseCliInteger(options.since, "--since", { min: 0 });
      const pollMs = parseCliInteger(options.poll, "--poll", { min: 50 });

      if (fs.existsSync(file) && path.basename(file) !== "calls.jsonl") {
        for await (const line of readLogLines(file, since, pollMs)) {
          for (const chunk of readLogLine(line)) {
            await writeLogChunk(chunk);
          }
          await writeLogChunk("\n");
        }
      } else {
        params.ensureHistoryStateRuntime();
        let initial = true;
        let seen = new Set<string>();
        for (;;) {
          const lines = (
            await getCallHistoryFromStore(path.dirname(file), MAX_CALL_RECORD_EVENTS)
          ).map((call) => JSON.stringify(call));
          for (const line of initial ? lines.slice(Math.max(0, lines.length - since)) : lines) {
            if (!seen.has(line)) {
              await writeLogChunk(`${line}\n`);
              seen.add(line);
            }
          }
          // Prime from all retained history, but print only --since initially.
          // Later snapshots retire dedup entries with their store records.
          seen = new Set(lines);
          initial = false;
          await sleep(pollMs);
        }
      }
    });

  params.root
    .command("latency")
    .description("Summarize turn latency metrics from voice-call history or a custom JSONL log")
    .option("--file <path>", "Path to calls.jsonl", params.defaultFile)
    .option("--last <n>", "Analyze last N records", "200")
    .action(async (options: { file: string; last?: string }) => {
      const file = options.file;
      const last = parseCliInteger(options.last, "--last", { min: 1 });

      if (fs.existsSync(file) && path.basename(file) !== "calls.jsonl") {
        async function* readCalls() {
          for await (const line of readLogLines(file, last)) {
            try {
              const parsed: unknown = JSON.parse(
                Buffer.concat([...readLogLine(line)]).toString("utf8"),
              );
              const call = (isRecord(parsed) ? parsed.call : undefined) ?? parsed;
              if (call !== null) {
                yield call;
              }
            } catch (error) {
              if (!(error instanceof SyntaxError)) {
                throw error;
              }
            }
          }
        }
        await writeVoiceCallLatencySummary(readCalls());
      } else {
        params.ensureHistoryStateRuntime();
        await writeVoiceCallLatencySummary(await getCallHistoryFromStore(path.dirname(file), last));
      }
    });
}
