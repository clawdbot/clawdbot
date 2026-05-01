/**
 * Heap-leak harness for the runEmbeddedAttempt abort path. Loops aborted runs
 * in a function-shaped scope that mimics the runner, snapshots the heap, and
 * computes a PASS/FAIL verdict from RSS delta + tracked-instance retention.
 *
 * Usage:
 *   node --import tsx --expose-gc scripts/embedded-run-abort-leak.ts \
 *     --mode production --iters 50 --batches 5
 *
 * Modes:
 *   production (default):        imports the real abortable from src; PASS proves the fix works.
 *   closure-extracted:           self-contained module-scope helper (mirrors production shape).
 *   closure-inline:              pre-fix shape (closure inside runner scope).
 *   synthetic-leak:              deliberately retains via module-level bucket
 *                                (sanity check that the harness detects leaks).
 *
 * Exit code: 0 if PASS, 1 if FAIL (leak detected).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as v8 from "node:v8";
import { abortable as productionAbortable } from "../src/agents/pi-embedded-runner/run/abortable.js";

type Mode = "production" | "closure-extracted" | "closure-inline" | "synthetic-leak";

type Options = {
  iters: number;
  batches: number;
  snapDir: string;
  mode: Mode;
  maxRssGrowthMb: number;
  maxTrackedRetention: number;
  scopeBytes: number;
  quiet: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    iters: 50,
    batches: 5,
    snapDir: ".tmp/embedded-run-abort-leak",
    mode: "production",
    maxRssGrowthMb: 64,
    maxTrackedRetention: 16,
    scopeBytes: 2_000_000,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--iters":
        opts.iters = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--batches":
        opts.batches = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--snap-dir":
        opts.snapDir = next ?? opts.snapDir;
        i += 1;
        break;
      case "--mode":
        if (
          next === "production" ||
          next === "closure-extracted" ||
          next === "closure-inline" ||
          next === "synthetic-leak"
        ) {
          opts.mode = next;
        } else {
          fail(
            `--mode must be one of: production, closure-extracted, closure-inline, synthetic-leak`,
          );
        }
        i += 1;
        break;
      case "--max-rss-growth-mb":
        opts.maxRssGrowthMb = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--max-tracked-retention":
        opts.maxTrackedRetention = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--scope-bytes":
        opts.scopeBytes = Number.parseInt(next ?? "", 10);
        i += 1;
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        fail(`Unknown arg: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.iters) || opts.iters <= 0) {
    fail("--iters must be > 0");
  }
  if (!Number.isFinite(opts.batches) || opts.batches <= 0) {
    fail("--batches must be > 0");
  }
  return opts;
}

function printUsage(): void {
  process.stderr.write(
    [
      "Usage: node --import tsx --expose-gc scripts/embedded-run-abort-leak.ts [flags]",
      "  --mode <production|closure-extracted|closure-inline|synthetic-leak>",
      "  --iters N            iterations per batch (default 50)",
      "  --batches B          batches between snapshots (default 5)",
      "  --snap-dir DIR       heap snapshot output dir (default .tmp/embedded-run-abort-leak)",
      "  --scope-bytes N      simulated run-scope payload size (default 2_000_000)",
      "  --max-rss-growth-mb  PASS threshold for RSS growth (default 64)",
      "  --max-tracked-retention  PASS threshold for tracked finalizer retention (default 16)",
      "  --quiet              only print final verdict",
      "",
    ].join("\n"),
  );
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(2);
}

const KEEP_ALIVE: Array<Promise<unknown>> = [];
const SYNTHETIC_LEAK_BUCKET: Uint8Array[] = [];
const FINALIZED = { count: 0 };
const finalizer = new FinalizationRegistry<number>(() => {
  FINALIZED.count += 1;
});

function abortableExtracted<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function runOnce(mode: Mode, scopeBytes: number, iter: number): void {
  const transcript = new Uint8Array(scopeBytes);
  const toolMetas = [{ data: new Uint8Array(scopeBytes / 4) }];
  const subscription = {
    onPartialReply: (_text: string) => {
      void transcript;
    },
    onAssistantMessageStart: () => {
      void toolMetas;
    },
  };
  finalizer.register(transcript, iter);

  const ac = new AbortController();
  const neverSettling = new Promise<unknown>(() => {});
  KEEP_ALIVE.push(neverSettling);

  if (mode === "production") {
    void productionAbortable(ac.signal, neverSettling).catch(() => {});
  } else if (mode === "closure-extracted") {
    void abortableExtracted(ac.signal, neverSettling).catch(() => {});
  } else if (mode === "closure-inline") {
    const wrapped = new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(new Error("aborted"));
      ac.signal.addEventListener("abort", onAbort, { once: true });
      neverSettling.then(
        (v) => {
          void transcript;
          void toolMetas;
          void subscription;
          resolve(v);
        },
        (e) => {
          void transcript;
          void toolMetas;
          void subscription;
          reject(e);
        },
      );
    });
    void wrapped.catch(() => {});
  } else {
    SYNTHETIC_LEAK_BUCKET.push(transcript);
  }
  ac.abort();

  void transcript.length;
  void toolMetas.length;
  void subscription.onPartialReply;
}

async function settleAndGc(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
    globalThis.gc?.();
  }
  await new Promise<void>((r) => setTimeout(r, 100));
  globalThis.gc?.();
}

type SampleRow = {
  label: string;
  rssBytes: number;
  heapUsedBytes: number;
  totalIters: number;
  trackedFinalized: number;
  snapshotPath: string;
};

function takeSnapshot(snapDir: string, label: string): string {
  fs.mkdirSync(snapDir, { recursive: true });
  const filename = path.join(snapDir, `${label}-${process.pid}-${Date.now()}.heapsnapshot`);
  v8.writeHeapSnapshot(filename);
  return filename;
}

function fmtBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof globalThis.gc !== "function") {
    fail("--expose-gc is required (run with: node --expose-gc ...)");
  }

  const startedAt = Date.now();
  const samples: SampleRow[] = [];

  if (!opts.quiet) {
    process.stdout.write(
      `[harness] mode=${opts.mode} iters=${opts.iters} batches=${opts.batches} ` +
        `scope=${fmtBytes(opts.scopeBytes)} pid=${process.pid}\n`,
    );
  }

  await settleAndGc();
  const baselinePath = takeSnapshot(opts.snapDir, "baseline");
  const baseline: SampleRow = {
    label: "baseline",
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    totalIters: 0,
    trackedFinalized: FINALIZED.count,
    snapshotPath: baselinePath,
  };
  samples.push(baseline);
  if (!opts.quiet) {
    process.stdout.write(
      `  baseline rss=${fmtBytes(baseline.rssBytes)} heap=${fmtBytes(baseline.heapUsedBytes)}\n`,
    );
  }

  let totalIters = 0;
  for (let b = 0; b < opts.batches; b += 1) {
    for (let i = 0; i < opts.iters; i += 1) {
      runOnce(opts.mode, opts.scopeBytes, totalIters);
      totalIters += 1;
    }
    await settleAndGc();
    const snapshotPath = takeSnapshot(opts.snapDir, `batch-${b}`);
    const row: SampleRow = {
      label: `batch-${b}`,
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      totalIters,
      trackedFinalized: FINALIZED.count,
      snapshotPath,
    };
    samples.push(row);
    if (!opts.quiet) {
      process.stdout.write(
        `  batch ${b} totalIters=${row.totalIters} ` +
          `rss=${fmtBytes(row.rssBytes)} heap=${fmtBytes(row.heapUsedBytes)} ` +
          `trackedFinalized=${row.trackedFinalized}/${row.totalIters}\n`,
      );
    }
  }

  const final = samples[samples.length - 1];
  if (!final) {
    fail("no samples collected");
  }
  const rssGrowthMb = (final.rssBytes - baseline.rssBytes) / 1024 / 1024;
  // Tracked retention: how many iter-allocated transcripts are STILL alive
  // (have not been finalized). Lower is better.
  const trackedRetention = final.totalIters - final.trackedFinalized;

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const verdict =
    rssGrowthMb > opts.maxRssGrowthMb || trackedRetention > opts.maxTrackedRetention
      ? "FAIL"
      : "PASS";

  process.stdout.write(
    `${verdict}: mode=${opts.mode} ` +
      `rss_growth=${rssGrowthMb.toFixed(1)}MB ` +
      `tracked_retention=${trackedRetention}/${final.totalIters} ` +
      `duration=${durationSec}s ` +
      `(thresholds: rss<${opts.maxRssGrowthMb}MB, tracked<${opts.maxTrackedRetention})\n`,
  );
  if (!opts.quiet) {
    process.stdout.write(
      `snapshots in ${opts.snapDir}/ — diff with:\n` +
        `  node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs ` +
        `${baseline.snapshotPath} ${final.snapshotPath} --top 30\n`,
    );
  }
  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`harness crashed: ${String(err)}\n${(err as Error)?.stack ?? ""}\n`);
  process.exit(2);
});
