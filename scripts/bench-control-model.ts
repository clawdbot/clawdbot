import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createControlModel,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEventFrame,
} from "../packages/gateway-client/src/model/index.js";

type BenchmarkOptions = {
  assert: boolean;
  batches: number;
  cyclesPerBatch: number;
  maxP95BatchMs: number;
  maxRetainedHeapGrowthBytes: number;
  maxRetainedHeapSlopeBytesPerBatch: number;
  output?: string;
  warmupBatches: number;
};

type BenchmarkResult = {
  config: Omit<BenchmarkOptions, "output">;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  workload: {
    measuredBatches: number;
    cyclesPerBatch: number;
    eventsPerCycle: number;
    measuredEvents: number;
  };
  projection: {
    batchMs: number[];
    medianBatchMs: number;
    p95BatchMs: number;
    medianMsPerThousandEvents: number;
    p95MsPerThousandEvents: number;
  };
  memory: {
    heapUsedBytes: number[];
    retainedHeapGrowthBytes: number;
    retainedHeapSlopeBytesPerBatch: number;
    processPeakRssBytes: number;
  };
  snapshot: {
    messages: number;
    runs: number;
    tools: number;
    questions: number;
    artifacts: number;
    truncation: Record<string, boolean>;
  };
  thresholds: {
    projectionP95BatchMs: boolean;
    retainedHeapGrowthBytes: boolean;
    retainedHeapSlopeBytesPerBatch: boolean;
    snapshotBounds: boolean;
  };
  passed: boolean;
};

const SESSION_KEY = "agent:main:performance";
const EVENTS_PER_CYCLE = 4;
const MEBIBYTE = 1024 * 1024;
const DEFAULT_MAX_P95_BATCH_MS = 4_000;
const DEFAULT_MAX_RETAINED_HEAP_GROWTH_BYTES = 2 * MEBIBYTE;
const DEFAULT_MAX_RETAINED_HEAP_SLOPE_BYTES_PER_BATCH = 256 * 1024;
const BENCHMARK_BOUNDS = {
  maxConversationMessages: 200,
  maxConversationRuns: 50,
  maxConversationTools: 50,
  maxConversationQuestions: 50,
  maxConversationArtifacts: 50,
} as const;

function parsePositiveInteger(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  let assert = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--assert") {
      assert = true;
      continue;
    }
    if (!argument?.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument ?? "end"}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (values.has(argument)) {
      throw new Error(`${argument} was provided more than once`);
    }
    values.set(argument, value);
    index += 1;
  }
  const knownFlags = new Set([
    "--batches",
    "--cycles-per-batch",
    "--max-p95-batch-ms",
    "--max-retained-heap-growth-bytes",
    "--max-retained-heap-slope-bytes-per-batch",
    "--output",
    "--warmup-batches",
  ]);
  for (const flag of values.keys()) {
    if (!knownFlags.has(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
  }
  return {
    assert,
    batches: parsePositiveInteger(values.get("--batches"), "--batches", 6),
    cyclesPerBatch: parsePositiveInteger(
      values.get("--cycles-per-batch"),
      "--cycles-per-batch",
      1_000,
    ),
    maxP95BatchMs: parsePositiveInteger(
      values.get("--max-p95-batch-ms"),
      "--max-p95-batch-ms",
      DEFAULT_MAX_P95_BATCH_MS,
    ),
    maxRetainedHeapGrowthBytes: parsePositiveInteger(
      values.get("--max-retained-heap-growth-bytes"),
      "--max-retained-heap-growth-bytes",
      DEFAULT_MAX_RETAINED_HEAP_GROWTH_BYTES,
    ),
    maxRetainedHeapSlopeBytesPerBatch: parsePositiveInteger(
      values.get("--max-retained-heap-slope-bytes-per-batch"),
      "--max-retained-heap-slope-bytes-per-batch",
      DEFAULT_MAX_RETAINED_HEAP_SLOPE_BYTES_PER_BATCH,
    ),
    output: values.get("--output"),
    warmupBatches: parsePositiveInteger(values.get("--warmup-batches"), "--warmup-batches", 2),
  };
}

function forceGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) {
    throw new Error("Control Model benchmark requires Node --expose-gc");
  }
  gc();
  gc();
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

function slope(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * ((values[index] ?? 0) - yMean);
    denominator += xDelta * xDelta;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function createBenchmarkBinding() {
  const listeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
  const gateway: ControlModelGatewayBinding = {
    getConnectionSnapshot: () => ({ status: "connected", epoch: 1 }),
    subscribeConnection: () => () => undefined,
    subscribeSessionCatalogInvalidations: () => () => undefined,
    subscribeEvents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request<T>(method: string): Promise<T> {
      const response =
        method === "sessions.messages.subscribe"
          ? { key: SESSION_KEY }
          : method === "question.list"
            ? { questions: [] }
            : method === "chat.history"
              ? { messages: [], completeSnapshot: true, totalMessages: 0 }
              : method === "sessions.list"
                ? { sessions: [] }
                : {};
      return response as T;
    },
  };
  const emit = (event: string, payload: Record<string, unknown>) => {
    const frame = { event, payload, connectionEpoch: 1 };
    for (const listener of listeners) {
      listener(frame);
    }
  };
  return {
    gateway,
    emit,
  };
}

function emitCycle(
  emit: (event: string, payload: Record<string, unknown>) => void,
  sequence: number,
): void {
  const message = {
    role: sequence % 2 === 0 ? "assistant" : "user",
    content: `message-${sequence}`,
    __openclaw: { id: `message-${sequence}`, seq: sequence },
  };
  emit("session.message", { sessionKey: SESSION_KEY, message });
  emit("chat", {
    sessionKey: SESSION_KEY,
    runId: `run-${sequence}`,
    state: "final",
    message,
  });
  emit("agent", {
    sessionKey: SESSION_KEY,
    runId: `run-${sequence}`,
    stream: "tool",
    data: {
      phase: "result",
      toolCallId: `tool-${sequence}`,
      output: "x".repeat(512),
      uiArtifacts: [
        {
          version: 1,
          id: `artifact-${sequence}`,
          revision: 1,
          structuredContent: { sequence },
          views: [
            {
              id: "table",
              templateUri: "clawpilot://widgets/table",
              dataVersion: 1,
              availability: "inline",
              data: { rows: [{ sequence }] },
            },
          ],
          state: "ready",
          source: {
            sessionKey: SESSION_KEY,
            messageId: `message-${sequence}`,
            toolCallId: `tool-${sequence}`,
            toolName: "benchmark",
          },
        },
      ],
    },
  });
  emit("question.requested", {
    question: {
      id: `question-${sequence}`,
      status: "pending",
      sessionKey: SESSION_KEY,
    },
  });
}

async function runBatch(
  emit: (event: string, payload: Record<string, unknown>) => void,
  startSequence: number,
  cycles: number,
): Promise<number> {
  const startedAt = performance.now();
  for (let offset = 0; offset < cycles; offset += 1) {
    emitCycle(emit, startSequence + offset);
  }
  await flush();
  return performance.now() - startedAt;
}

async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const binding = createBenchmarkBinding();
  const model = createControlModel({
    gateway: binding.gateway,
    autoRefreshSessionCatalog: false,
    autoLoadConversationHistory: false,
    bounds: BENCHMARK_BOUNDS,
  });
  model.start();
  const conversation = model.conversation(SESSION_KEY);
  await flush();

  let sequence = 1;
  for (let index = 0; index < options.warmupBatches; index += 1) {
    await runBatch(binding.emit, sequence, options.cyclesPerBatch);
    sequence += options.cyclesPerBatch;
  }
  forceGc();

  const batchMs: number[] = [];
  const heapUsedBytes: number[] = [];
  for (let index = 0; index < options.batches; index += 1) {
    batchMs.push(await runBatch(binding.emit, sequence, options.cyclesPerBatch));
    sequence += options.cyclesPerBatch;
    forceGc();
    heapUsedBytes.push(process.memoryUsage().heapUsed);
  }

  const snapshot = conversation.getSnapshot();
  const medianBatchMs = percentile(batchMs, 0.5);
  const p95BatchMs = percentile(batchMs, 0.95);
  const eventsPerBatch = options.cyclesPerBatch * EVENTS_PER_CYCLE;
  const retainedHeapGrowthBytes = Math.max(0, Math.max(...heapUsedBytes) - (heapUsedBytes[0] ?? 0));
  const retainedHeapSlopeBytesPerBatch = Math.max(0, slope(heapUsedBytes));
  const snapshotBounds =
    snapshot.messages.length === BENCHMARK_BOUNDS.maxConversationMessages &&
    snapshot.runs.length === BENCHMARK_BOUNDS.maxConversationRuns &&
    snapshot.tools.length === BENCHMARK_BOUNDS.maxConversationTools &&
    snapshot.questions.length === BENCHMARK_BOUNDS.maxConversationQuestions &&
    snapshot.artifacts.length === BENCHMARK_BOUNDS.maxConversationArtifacts &&
    snapshot.bounds.messagesTruncated &&
    snapshot.bounds.runsTruncated &&
    snapshot.bounds.toolsTruncated &&
    snapshot.bounds.questionsTruncated &&
    snapshot.bounds.artifactsTruncated;
  const thresholds = {
    projectionP95BatchMs: p95BatchMs <= options.maxP95BatchMs,
    retainedHeapGrowthBytes: retainedHeapGrowthBytes <= options.maxRetainedHeapGrowthBytes,
    retainedHeapSlopeBytesPerBatch:
      retainedHeapSlopeBytesPerBatch <= options.maxRetainedHeapSlopeBytesPerBatch,
    snapshotBounds,
  };
  const result: BenchmarkResult = {
    config: {
      assert: options.assert,
      batches: options.batches,
      cyclesPerBatch: options.cyclesPerBatch,
      maxP95BatchMs: options.maxP95BatchMs,
      maxRetainedHeapGrowthBytes: options.maxRetainedHeapGrowthBytes,
      maxRetainedHeapSlopeBytesPerBatch: options.maxRetainedHeapSlopeBytesPerBatch,
      warmupBatches: options.warmupBatches,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    workload: {
      measuredBatches: options.batches,
      cyclesPerBatch: options.cyclesPerBatch,
      eventsPerCycle: EVENTS_PER_CYCLE,
      measuredEvents: eventsPerBatch * options.batches,
    },
    projection: {
      batchMs,
      medianBatchMs,
      p95BatchMs,
      medianMsPerThousandEvents: (medianBatchMs / eventsPerBatch) * 1_000,
      p95MsPerThousandEvents: (p95BatchMs / eventsPerBatch) * 1_000,
    },
    memory: {
      heapUsedBytes,
      retainedHeapGrowthBytes,
      retainedHeapSlopeBytesPerBatch,
      processPeakRssBytes: Math.round(process.resourceUsage().maxRSS * 1024),
    },
    snapshot: {
      messages: snapshot.messages.length,
      runs: snapshot.runs.length,
      tools: snapshot.tools.length,
      questions: snapshot.questions.length,
      artifacts: snapshot.artifacts.length,
      truncation: { ...snapshot.bounds },
    },
    thresholds,
    passed: Object.values(thresholds).every(Boolean),
  };
  model.dispose();
  return result;
}

const options = parseOptions(process.argv.slice(2));
const result = await runBenchmark(options);
const output = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(output);
if (options.output) {
  writeFileSync(options.output, output);
}
if (options.assert && !result.passed) {
  process.exitCode = 1;
}
