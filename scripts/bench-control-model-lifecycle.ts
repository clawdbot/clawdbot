import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  createControlModel,
  type ControlModelConnectionSnapshot,
  type ControlModelGatewayBinding,
  type ControlModelGatewayEventFrame,
} from "../packages/gateway-client/src/model/index.js";

type LifecycleOptions = {
  assert: boolean;
  initialRuns: number;
  materializations: number;
  evictionBatches: number;
  evictionsPerBatch: number;
  reconnectRuns: number;
  maxInitialP95Ms: number;
  maxMaterializationP95Ms: number;
  maxEvictionP95BatchMs: number;
  maxReconnectP95Ms: number;
  output?: string;
};

type LifecycleResult = {
  config: Omit<LifecycleOptions, "output">;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  initialProjection: {
    runs: number;
    sessionsPerRun: number;
    messagesPerRun: number;
    artifactsPerRun: number;
    durationsMs: number[];
    medianMs: number;
    p95Ms: number;
  };
  materialization: {
    views: number;
    durationsMs: number[];
    medianMs: number;
    p95Ms: number;
    inlineViews: number;
  };
  inactiveEviction: {
    batches: number;
    conversationsPerBatch: number;
    durationsMs: number[];
    medianBatchMs: number;
    p95BatchMs: number;
    retainedInactiveConversations: number;
    disposedConversations: number;
  };
  reconnectResync: {
    runs: number;
    messagesPerRun: number;
    durationsMs: number[];
    medianMs: number;
    p95Ms: number;
    authoritativeHistoryRequests: number;
  };
  thresholds: {
    initialProjectionP95Ms: boolean;
    materializationP95Ms: boolean;
    evictionP95BatchMs: boolean;
    reconnectResyncP95Ms: boolean;
    lifecycleInvariants: boolean;
  };
  passed: boolean;
};

const SESSION_KEY = "agent:main:lifecycle";
const SESSION_COUNT = 200;
const HISTORY_MESSAGE_COUNT = 200;
const HISTORY_ARTIFACT_COUNT = 50;
const MAX_INACTIVE_CONVERSATIONS = 50;
const DEFAULT_MAX_INITIAL_P95_MS = 100;
const DEFAULT_MAX_MATERIALIZATION_P95_MS = 10;
const DEFAULT_MAX_EVICTION_P95_BATCH_MS = 250;
const DEFAULT_MAX_RECONNECT_P95_MS = 100;

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

function parseOptions(argv: string[]): LifecycleOptions {
  const values = new Map<string, string>();
  let assert = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
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
    "--initial-runs",
    "--materializations",
    "--eviction-batches",
    "--evictions-per-batch",
    "--reconnect-runs",
    "--max-initial-p95-ms",
    "--max-materialization-p95-ms",
    "--max-eviction-p95-batch-ms",
    "--max-reconnect-p95-ms",
    "--output",
  ]);
  for (const flag of values.keys()) {
    if (!knownFlags.has(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
  }
  return {
    assert,
    initialRuns: parsePositiveInteger(values.get("--initial-runs"), "--initial-runs", 8),
    materializations: parsePositiveInteger(
      values.get("--materializations"),
      "--materializations",
      100,
    ),
    evictionBatches: parsePositiveInteger(
      values.get("--eviction-batches"),
      "--eviction-batches",
      6,
    ),
    evictionsPerBatch: parsePositiveInteger(
      values.get("--evictions-per-batch"),
      "--evictions-per-batch",
      1_000,
    ),
    reconnectRuns: parsePositiveInteger(values.get("--reconnect-runs"), "--reconnect-runs", 8),
    maxInitialP95Ms: parsePositiveInteger(
      values.get("--max-initial-p95-ms"),
      "--max-initial-p95-ms",
      DEFAULT_MAX_INITIAL_P95_MS,
    ),
    maxMaterializationP95Ms: parsePositiveInteger(
      values.get("--max-materialization-p95-ms"),
      "--max-materialization-p95-ms",
      DEFAULT_MAX_MATERIALIZATION_P95_MS,
    ),
    maxEvictionP95BatchMs: parsePositiveInteger(
      values.get("--max-eviction-p95-batch-ms"),
      "--max-eviction-p95-batch-ms",
      DEFAULT_MAX_EVICTION_P95_BATCH_MS,
    ),
    maxReconnectP95Ms: parsePositiveInteger(
      values.get("--max-reconnect-p95-ms"),
      "--max-reconnect-p95-ms",
      DEFAULT_MAX_RECONNECT_P95_MS,
    ),
    output: values.get("--output"),
  };
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function artifact(index: number, availability: "deferred" | "inline" = "deferred") {
  return {
    version: 1,
    id: `artifact-${index}`,
    revision: 1,
    structuredContent: { index },
    views: [
      {
        id: "table",
        templateUri: "clawpilot://widgets/table",
        dataVersion: 1,
        availability,
        ...(availability === "inline" ? { data: { rows: [{ index }] } } : {}),
      },
    ],
    state: "ready",
    source: {
      sessionKey: SESSION_KEY,
      messageId: `message-${index}`,
      toolCallId: `tool-${index}`,
      toolName: "benchmark",
    },
  };
}

function historyMessages() {
  return Array.from({ length: HISTORY_MESSAGE_COUNT }, (_, index) => {
    const sequence = index + 1;
    if (index < HISTORY_ARTIFACT_COUNT) {
      return {
        role: "toolResult",
        content: `tool-result-${sequence}`,
        toolCallId: `tool-${sequence}`,
        details: { uiArtifacts: [artifact(sequence)] },
        __openclaw: { id: `message-${sequence}`, seq: sequence },
      };
    }
    return {
      role: sequence % 2 === 0 ? "assistant" : "user",
      content: `message-${sequence}`,
      __openclaw: { id: `message-${sequence}`, seq: sequence },
    };
  });
}

function sessions() {
  return Array.from({ length: SESSION_COUNT }, (_, index) => ({
    key: index === 0 ? SESSION_KEY : `agent:main:lifecycle-${index}`,
    kind: "direct",
    label: `Lifecycle ${index}`,
    updatedAt: 1_700_000_000_000 + index,
  }));
}

function createLifecycleBinding(
  initial: ControlModelConnectionSnapshot = {
    status: "connected",
    epoch: 1,
  },
) {
  let connection = initial;
  let historyRequests = 0;
  const connectionListeners = new Set<() => void>();
  const eventListeners = new Set<(frame: ControlModelGatewayEventFrame) => void>();
  const messages = historyMessages();
  const gateway: ControlModelGatewayBinding = {
    getConnectionSnapshot: () => connection,
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    subscribeSessionCatalogInvalidations: () => () => undefined,
    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
      let response: unknown = {};
      if (method === "sessions.list") {
        response = { sessions: sessions() };
      } else if (method === "sessions.messages.subscribe") {
        response = { key: params.key };
      } else if (method === "question.list") {
        response = { questions: [] };
      } else if (method === "chat.history") {
        historyRequests += 1;
        response = {
          messages,
          completeSnapshot: true,
          totalMessages: messages.length,
        };
      }
      return response as T;
    },
    async materializeArtifactView(input) {
      const index = Number(input.artifactId.slice("artifact-".length));
      return {
        artifactId: input.artifactId,
        artifactRevision: input.artifactRevision,
        view: artifact(index, "inline").views[0],
      };
    },
  };
  return {
    gateway,
    get historyRequests() {
      return historyRequests;
    },
    setConnection(next: ControlModelConnectionSnapshot) {
      connection = next;
      for (const listener of connectionListeners) {
        listener();
      }
    },
    emit(event: string, payload: Record<string, unknown>) {
      const frame = { event, payload, connectionEpoch: connection.epoch };
      for (const listener of eventListeners) {
        listener(frame);
      }
    },
  };
}

async function measureInitialProjection(): Promise<number> {
  const binding = createLifecycleBinding();
  const model = createControlModel({
    gateway: binding.gateway,
    bounds: {
      maxConversationMessages: HISTORY_MESSAGE_COUNT,
      maxConversationArtifacts: HISTORY_ARTIFACT_COUNT,
    },
  });
  const startedAt = performance.now();
  model.start();
  const conversation = model.conversation(SESSION_KEY);
  await waitUntil(
    () =>
      model.getSnapshot().sessionCatalog.status === "ready" &&
      conversation.getSnapshot().history.status === "ready",
    "initial catalog and conversation projection",
  );
  const duration = performance.now() - startedAt;
  const modelSnapshot = model.getSnapshot();
  const conversationSnapshot = conversation.getSnapshot();
  if (
    modelSnapshot.sessionCatalog.sessions.length !== SESSION_COUNT ||
    conversationSnapshot.messages.length !== HISTORY_MESSAGE_COUNT ||
    conversationSnapshot.artifacts.length !== HISTORY_ARTIFACT_COUNT
  ) {
    throw new Error("initial projection did not produce the expected bounded snapshot");
  }
  model.dispose();
  return duration;
}

async function measureMaterialization(count: number) {
  const binding = createLifecycleBinding();
  const model = createControlModel({
    gateway: binding.gateway,
    autoRefreshSessionCatalog: false,
    autoLoadConversationHistory: false,
    bounds: { maxConversationArtifacts: count },
  });
  model.start();
  const conversation = model.conversation(SESSION_KEY);
  await waitUntil(
    () => conversation.getSnapshot().connection.status === "connected",
    "materialization conversation activation",
  );
  for (let index = 1; index <= count; index += 1) {
    binding.emit("agent", {
      sessionKey: SESSION_KEY,
      runId: `run-${index}`,
      stream: "tool",
      data: {
        phase: "result",
        toolCallId: `tool-${index}`,
        uiArtifacts: [artifact(index)],
      },
    });
  }
  const durationsMs: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    const startedAt = performance.now();
    await conversation.materializeView({
      artifactId: `artifact-${index}`,
      artifactRevision: 1,
      viewId: "table",
    });
    durationsMs.push(performance.now() - startedAt);
  }
  const inlineViews = conversation
    .getSnapshot()
    .artifacts.filter((entry) => entry.views[0]?.availability === "inline").length;
  model.dispose();
  return { durationsMs, inlineViews };
}

function measureInactiveEviction(options: LifecycleOptions) {
  let now = 0;
  const binding = createLifecycleBinding({ status: "disconnected", epoch: 0 });
  const model = createControlModel({
    gateway: binding.gateway,
    autoRefreshSessionCatalog: false,
    autoLoadConversationHistory: false,
    bounds: { maxInactiveConversations: MAX_INACTIVE_CONVERSATIONS },
    now: () => ++now,
  });
  model.start();
  const conversations = [];
  const durationsMs: number[] = [];
  for (let batch = 0; batch < options.evictionBatches; batch += 1) {
    const startedAt = performance.now();
    for (let offset = 0; offset < options.evictionsPerBatch; offset += 1) {
      conversations.push(
        model.conversation(`agent:main:eviction-${batch * options.evictionsPerBatch + offset}`),
      );
    }
    durationsMs.push(performance.now() - startedAt);
  }
  const disposedConversations = conversations.filter(
    (conversation) => conversation.getSnapshot().status === "disposed",
  ).length;
  const retainedInactiveConversations = conversations.length - disposedConversations;
  model.dispose();
  return { durationsMs, disposedConversations, retainedInactiveConversations };
}

async function measureReconnectResync(runs: number) {
  const binding = createLifecycleBinding();
  const model = createControlModel({
    gateway: binding.gateway,
    autoRefreshSessionCatalog: false,
    bounds: {
      maxConversationMessages: HISTORY_MESSAGE_COUNT,
      maxConversationArtifacts: HISTORY_ARTIFACT_COUNT,
    },
  });
  model.start();
  const conversation = model.conversation(SESSION_KEY);
  await waitUntil(
    () => conversation.getSnapshot().history.status === "ready",
    "initial reconnect history",
  );
  const durationsMs: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const epoch = index + 2;
    binding.setConnection({ status: "reconnecting", epoch });
    const startedAt = performance.now();
    binding.setConnection({ status: "connected", epoch });
    const expectedHistoryRequests = index + 2;
    await waitUntil(
      () =>
        binding.historyRequests >= expectedHistoryRequests &&
        conversation.getSnapshot().history.status === "ready" &&
        !conversation
          .getSnapshot()
          .partialReasons.includes("reconnect-awaiting-authoritative-history"),
      `reconnect resync ${index + 1}`,
    );
    durationsMs.push(performance.now() - startedAt);
  }
  const authoritativeHistoryRequests = binding.historyRequests;
  model.dispose();
  return { durationsMs, authoritativeHistoryRequests };
}

async function runBenchmark(options: LifecycleOptions): Promise<LifecycleResult> {
  const initialDurationsMs: number[] = [];
  for (let index = 0; index < options.initialRuns; index += 1) {
    initialDurationsMs.push(await measureInitialProjection());
  }
  const materialization = await measureMaterialization(options.materializations);
  const inactiveEviction = measureInactiveEviction(options);
  const reconnectResync = await measureReconnectResync(options.reconnectRuns);
  const initialP95Ms = percentile(initialDurationsMs, 0.95);
  const materializationP95Ms = percentile(materialization.durationsMs, 0.95);
  const evictionP95BatchMs = percentile(inactiveEviction.durationsMs, 0.95);
  const reconnectP95Ms = percentile(reconnectResync.durationsMs, 0.95);
  const totalConversations = options.evictionBatches * options.evictionsPerBatch;
  const expectedRetained = Math.min(totalConversations, MAX_INACTIVE_CONVERSATIONS);
  const expectedDisposed = totalConversations - expectedRetained;
  const lifecycleInvariants =
    materialization.inlineViews === options.materializations &&
    inactiveEviction.retainedInactiveConversations === expectedRetained &&
    inactiveEviction.disposedConversations === expectedDisposed &&
    reconnectResync.authoritativeHistoryRequests === options.reconnectRuns + 1;
  const thresholds = {
    initialProjectionP95Ms: initialP95Ms <= options.maxInitialP95Ms,
    materializationP95Ms: materializationP95Ms <= options.maxMaterializationP95Ms,
    evictionP95BatchMs: evictionP95BatchMs <= options.maxEvictionP95BatchMs,
    reconnectResyncP95Ms: reconnectP95Ms <= options.maxReconnectP95Ms,
    lifecycleInvariants,
  };
  return {
    config: {
      assert: options.assert,
      initialRuns: options.initialRuns,
      materializations: options.materializations,
      evictionBatches: options.evictionBatches,
      evictionsPerBatch: options.evictionsPerBatch,
      reconnectRuns: options.reconnectRuns,
      maxInitialP95Ms: options.maxInitialP95Ms,
      maxMaterializationP95Ms: options.maxMaterializationP95Ms,
      maxEvictionP95BatchMs: options.maxEvictionP95BatchMs,
      maxReconnectP95Ms: options.maxReconnectP95Ms,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    initialProjection: {
      runs: options.initialRuns,
      sessionsPerRun: SESSION_COUNT,
      messagesPerRun: HISTORY_MESSAGE_COUNT,
      artifactsPerRun: HISTORY_ARTIFACT_COUNT,
      durationsMs: initialDurationsMs,
      medianMs: percentile(initialDurationsMs, 0.5),
      p95Ms: initialP95Ms,
    },
    materialization: {
      views: options.materializations,
      durationsMs: materialization.durationsMs,
      medianMs: percentile(materialization.durationsMs, 0.5),
      p95Ms: materializationP95Ms,
      inlineViews: materialization.inlineViews,
    },
    inactiveEviction: {
      batches: options.evictionBatches,
      conversationsPerBatch: options.evictionsPerBatch,
      durationsMs: inactiveEviction.durationsMs,
      medianBatchMs: percentile(inactiveEviction.durationsMs, 0.5),
      p95BatchMs: evictionP95BatchMs,
      retainedInactiveConversations: inactiveEviction.retainedInactiveConversations,
      disposedConversations: inactiveEviction.disposedConversations,
    },
    reconnectResync: {
      runs: options.reconnectRuns,
      messagesPerRun: HISTORY_MESSAGE_COUNT,
      durationsMs: reconnectResync.durationsMs,
      medianMs: percentile(reconnectResync.durationsMs, 0.5),
      p95Ms: reconnectP95Ms,
      authoritativeHistoryRequests: reconnectResync.authoritativeHistoryRequests,
    },
    thresholds,
    passed: Object.values(thresholds).every(Boolean),
  };
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
