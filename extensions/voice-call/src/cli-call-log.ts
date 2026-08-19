// Voice Call plugin module implements cli call log commands.
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Command } from "commander";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sleep } from "../api.js";
import { parseCliInteger, writeCliJson, writeCliLine } from "./cli-command-io.js";
import { getCallHistoryFromStore } from "./manager/store.js";

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

function writeVoiceCallLatencySummary(calls: unknown[]) {
  const turnLatencyMs: number[] = [];
  const listenWaitMs: number[] = [];

  for (const call of calls) {
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
    recordsScanned: calls.length,
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
    .description("Tail voice-call JSONL logs (prints new lines; useful during provider tests)")
    .option("--file <path>", "Path to calls.jsonl", params.defaultFile)
    .option("--since <n>", "Print last N lines first", "25")
    .option("--poll <ms>", "Poll interval in ms", "250")
    .action(async (options: { file: string; since?: string; poll?: string }) => {
      const file = options.file;
      const since = parseCliInteger(options.since, "--since", { min: 0 });
      const pollMs = parseCliInteger(options.poll, "--poll", { min: 50 });

      const tailSqliteHistory = async (initialLimit: number): Promise<never> => {
        params.ensureHistoryStateRuntime();
        const seen = new Set<string>();
        const printCall = (call: unknown): void => {
          const line = JSON.stringify(call);
          if (!seen.has(line)) {
            seen.add(line);
            writeCliLine(line);
          }
        };
        if (initialLimit > 0) {
          for (const call of await getCallHistoryFromStore(path.dirname(file), initialLimit)) {
            printCall(call);
          }
        }
        for (;;) {
          try {
            for (const call of await getCallHistoryFromStore(path.dirname(file), 1000)) {
              printCall(call);
            }
          } catch {
            // ignore and retry
          }
          await sleep(pollMs);
        }
      };

      if (fs.existsSync(file) && path.basename(file) !== "calls.jsonl") {
        const initial = fs.readFileSync(file);
        let decoder = new StringDecoder("utf8");
        const initialLines = decoder.write(initial).split("\n");
        let pendingLine = initialLines.pop() ?? "";
        const lines = initialLines.filter(Boolean);
        for (const line of lines.slice(Math.max(0, lines.length - since))) {
          writeCliLine(line);
        }

        let offset = initial.length;
        let lastObservedSize = initial.length;
        for (;;) {
          try {
            const stat = fs.statSync(file);
            // A short read can leave the cursor behind the observed file size;
            // compare observed sizes so copytruncate also clears buffered text.
            if (stat.size < lastObservedSize) {
              offset = 0;
              decoder = new StringDecoder("utf8");
              pendingLine = "";
            }
            lastObservedSize = stat.size;
            if (stat.size > offset) {
              const fd = fs.openSync(file, "r");
              try {
                const buf = Buffer.alloc(stat.size - offset);
                const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
                offset += bytesRead;
                const text = decoder.write(buf.subarray(0, bytesRead));
                const completeLines = `${pendingLine}${text}`.split("\n");
                pendingLine = completeLines.pop() ?? "";
                for (const line of completeLines.filter(Boolean)) {
                  writeCliLine(line);
                }
              } finally {
                fs.closeSync(fd);
              }
            }
          } catch {
            // ignore and retry
          }
          await sleep(pollMs);
        }
      } else {
        await tailSqliteHistory(since);
      }
    });

  params.root
    .command("latency")
    .description("Summarize turn latency metrics from voice-call JSONL logs")
    .option("--file <path>", "Path to calls.jsonl", params.defaultFile)
    .option("--last <n>", "Analyze last N records", "200")
    .action(async (options: { file: string; last?: string }) => {
      const file = options.file;
      const last = parseCliInteger(options.last, "--last", { min: 1 });

      if (fs.existsSync(file) && path.basename(file) !== "calls.jsonl") {
        const content = fs.readFileSync(file, "utf8");
        const calls = content
          .split("\n")
          .filter(Boolean)
          .slice(-last)
          .map((line) => {
            try {
              const parsed: unknown = JSON.parse(line);
              return (isRecord(parsed) ? parsed.call : undefined) ?? parsed;
            } catch {
              return null;
            }
          })
          .filter((call) => call !== null);
        writeVoiceCallLatencySummary(calls);
      } else {
        params.ensureHistoryStateRuntime();
        writeVoiceCallLatencySummary(await getCallHistoryFromStore(path.dirname(file), last));
      }
    });
}
