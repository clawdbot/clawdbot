// Voice Call plugin module implements cli call log commands.
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
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

/** Cap diagnostic CLI reads to avoid loading oversized JSONL logs into memory. */
const VOICE_CALL_CLI_MAX_JSONL_TAIL_BYTES = 1_000_000;
const VOICE_CALL_CLI_JSONL_READ_CHUNK_BYTES = 64 * 1024;

type JsonlFileIdentity = {
  dev: number;
  ino: number;
};

function getJsonlFileIdentity(stat: fs.Stats): JsonlFileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function isSameJsonlFileIdentity(left: JsonlFileIdentity, right: JsonlFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read complete JSONL records from at most `maxBytes` at the end of `filePath`. */
function readJsonlTailSync(
  filePath: string,
  maxBytes: number,
): {
  text: string;
  bytes: Buffer;
  end: number;
  identity: JsonlFileIdentity;
  omittedLeadingBytes: number;
  droppedLeadingBytes: number;
  discardUntilNewline: boolean;
} {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const identity = getJsonlFileIdentity(stat);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length === 0) {
      return {
        text: "",
        bytes: Buffer.alloc(0),
        end: stat.size,
        identity,
        omittedLeadingBytes: start,
        droppedLeadingBytes: 0,
        discardUntilNewline: false,
      };
    }
    let startsAtRecordBoundary = start === 0;
    if (start > 0) {
      const prefix = Buffer.alloc(1);
      startsAtRecordBoundary = fs.readSync(fd, prefix, 0, 1, start - 1) === 1 && prefix[0] === 0x0a;
    }
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = fs.readSync(fd, buf, bytesRead, length - bytesRead, start + bytesRead);
      if (read === 0) {
        break;
      }
      bytesRead += read;
    }
    let bytes = buf.subarray(0, bytesRead);
    let droppedLeadingBytes = 0;
    let discardUntilNewline = false;
    if (!startsAtRecordBoundary) {
      const firstNewline = bytes.indexOf(0x0a);
      if (firstNewline === -1) {
        droppedLeadingBytes = bytes.length;
        bytes = Buffer.alloc(0);
        discardUntilNewline = start > 0;
      } else {
        droppedLeadingBytes = firstNewline + 1;
        bytes = bytes.subarray(firstNewline + 1);
      }
    }
    return {
      text: bytes.toString("utf8"),
      bytes,
      end: start + bytesRead,
      identity,
      omittedLeadingBytes: start,
      droppedLeadingBytes,
      discardUntilNewline,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function writeStderrLine(...values: unknown[]): void {
  process.stderr.write(`${format(...values)}\n`);
}

function warnJsonlCappedLeadingOmission(params: {
  omittedLeadingBytes: number;
  droppedLeadingBytes: number;
  filePath: string;
}): void {
  if (params.omittedLeadingBytes > 0) {
    writeStderrLine(
      "voicecall: retained the newest %d bytes from %s and omitted %d earlier JSONL bytes; earlier records are not included",
      VOICE_CALL_CLI_MAX_JSONL_TAIL_BYTES,
      params.filePath,
      params.omittedLeadingBytes,
    );
  }
  if (params.droppedLeadingBytes > 0) {
    writeStderrLine(
      "voicecall: skipped %d bytes of a partial JSONL record at the start of the capped read (%s)",
      params.droppedLeadingBytes,
      params.filePath,
    );
  }
}

function warnJsonlFollowDiscard(filePath: string): void {
  writeStderrLine(
    "voicecall: discarding a JSONL record larger than %d bytes while following %s",
    VOICE_CALL_CLI_MAX_JSONL_TAIL_BYTES,
    filePath,
  );
}

type JsonlFollowState = {
  pending: Buffer;
  discardUntilNewline: boolean;
  identity: JsonlFileIdentity;
};

function readJsonlFollowRangeSync(params: {
  filePath: string;
  start: number;
  state: JsonlFollowState;
  onLine: (line: string) => void;
}): number {
  const fd = fs.openSync(params.filePath, "r");
  const chunk = Buffer.alloc(VOICE_CALL_CLI_JSONL_READ_CHUNK_BYTES);
  let position = params.start;
  const appendPending = (fragment: Buffer): void => {
    if (params.state.discardUntilNewline || fragment.length === 0) {
      return;
    }
    if (params.state.pending.length + fragment.length > VOICE_CALL_CLI_MAX_JSONL_TAIL_BYTES) {
      params.state.pending = Buffer.alloc(0);
      params.state.discardUntilNewline = true;
      warnJsonlFollowDiscard(params.filePath);
      return;
    }
    // Retain raw bytes so UTF-8 code points split across read chunks decode only after completion.
    params.state.pending =
      params.state.pending.length === 0
        ? Buffer.from(fragment)
        : Buffer.concat([params.state.pending, fragment]);
  };
  try {
    const stat = fs.fstatSync(fd);
    const identity = getJsonlFileIdentity(stat);
    if (!isSameJsonlFileIdentity(params.state.identity, identity) || stat.size < position) {
      position = 0;
      params.state.pending = Buffer.alloc(0);
      params.state.discardUntilNewline = false;
    }
    params.state.identity = identity;

    while (position < stat.size) {
      const requested = Math.min(chunk.length, stat.size - position);
      const bytesRead = fs.readSync(fd, chunk, 0, requested, position);
      if (bytesRead === 0) {
        break;
      }
      let cursor = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, cursor);
        if (newline === -1 || newline >= bytesRead) {
          appendPending(chunk.subarray(cursor, bytesRead));
          break;
        }
        appendPending(chunk.subarray(cursor, newline));
        if (!params.state.discardUntilNewline && params.state.pending.length > 0) {
          params.onLine(params.state.pending.toString("utf8"));
        }
        params.state.pending = Buffer.alloc(0);
        params.state.discardUntilNewline = false;
        cursor = newline + 1;
      }
      position += bytesRead;
    }
    return position;
  } finally {
    fs.closeSync(fd);
  }
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
        const {
          bytes: initial,
          end,
          identity,
          omittedLeadingBytes,
          droppedLeadingBytes,
          discardUntilNewline,
        } = readJsonlTailSync(file, VOICE_CALL_CLI_MAX_JSONL_TAIL_BYTES);
        warnJsonlCappedLeadingOmission({
          omittedLeadingBytes,
          droppedLeadingBytes,
          filePath: file,
        });
        const finalNewline = initial.lastIndexOf(0x0a);
        const completeInitial =
          finalNewline === -1 ? Buffer.alloc(0) : initial.subarray(0, finalNewline + 1);
        const pending = finalNewline === -1 ? initial : initial.subarray(finalNewline + 1);
        const lines = completeInitial.toString("utf8").split("\n").filter(Boolean);
        for (const line of lines.slice(Math.max(0, lines.length - since))) {
          writeCliLine(line);
        }

        let offset = end;
        let lastObservedSize = end;
        const followState: JsonlFollowState = {
          pending: Buffer.from(pending),
          discardUntilNewline,
          identity,
        };
        for (;;) {
          try {
            const stat = fs.statSync(file);
            // A copy-truncate can replace a partial record while keeping the same inode.
            // Reset buffered bytes when the observed file size shrinks before reading again.
            if (stat.size < lastObservedSize) {
              offset = 0;
              followState.pending = Buffer.alloc(0);
              followState.discardUntilNewline = false;
            }
            lastObservedSize = stat.size;
            offset = readJsonlFollowRangeSync({
              filePath: file,
              start: offset,
              state: followState,
              onLine: (line) => {
                if (line) {
                  writeCliLine(line);
                }
              },
            });
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
        const {
          text: content,
          omittedLeadingBytes,
          droppedLeadingBytes,
        } = readJsonlTailSync(file, VOICE_CALL_CLI_MAX_JSONL_TAIL_BYTES);
        warnJsonlCappedLeadingOmission({
          omittedLeadingBytes,
          droppedLeadingBytes,
          filePath: file,
        });
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
