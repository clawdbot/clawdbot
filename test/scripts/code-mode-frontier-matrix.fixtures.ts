import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFrontierModeConfigProof,
  buildFrozenFrontierMatrixPlan,
  type FrontierExecutionProof,
  type FrontierMatrixCellObservation,
  type FrozenFrontierMatrixIdentity,
  type FrozenFrontierMatrixPlan,
} from "../../scripts/lib/code-mode-frontier-matrix.js";
import { createCodeModeStats } from "../../src/agents/code-mode-stats.js";
import type { AgentCommandRunAccountingSnapshot } from "../../src/agents/command/run-accounting.types.js";
import { createProviderTransportAccountingCollector } from "../../src/agents/provider-transport-accounting.js";
import { projectAgentExecTrace } from "../../src/commands/agent-exec-trace.js";

const tempRoots: string[] = [];

export const frontierIdentity = {
  sourceSha: "a".repeat(40),
  sourceDirty: false,
  buildSha256: "b".repeat(64),
  configSha256: "c".repeat(64),
  entrypointSha256: "d".repeat(64),
  lockfileSha256: "e".repeat(64),
  modelCapabilitySha256: "f".repeat(64),
  nodeVersion: "v24.15.0",
} satisfies FrozenFrontierMatrixIdentity;

export const comparableFrontierProof = {
  providerRetry: { status: "verified", maxRetries: 0 },
  encryptedPayloadRecovery: { status: "disabled", maxRecoveries: 0 },
  transportRetry: { status: "verified", maxRetries: 0 },
  warmCold: {
    build: "warm_shared_immutable",
    gatewayProcess: "cold_per_cell",
    openClawState: "cold_fresh_per_cell",
    providerFirstCallCache: "observed_per_trace",
    transportPrewarm: "observed_disabled",
    transportReuse: "observed_disabled",
  },
} satisfies FrontierExecutionProof;

const modeConfigProof = buildFrontierModeConfigProof({
  agentId: "proof",
  direct: {
    agents: { entries: { proof: { tools: { codeMode: { enabled: false } } } } },
    tools: { codeMode: { enabled: false } },
  },
  code: {
    agents: { entries: { proof: { tools: { codeMode: { enabled: true } } } } },
    tools: { codeMode: { enabled: true } },
  },
});

export async function frontierTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-frontier-matrix-"));
  tempRoots.push(root);
  return root;
}

export async function cleanupFrontierTempRoots(): Promise<void> {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
}

export function frontierPlan(
  executionProof: FrontierExecutionProof = comparableFrontierProof,
  identityObservationTimeoutMs = 30_000,
): FrozenFrontierMatrixPlan {
  return buildFrozenFrontierMatrixPlan({
    api: "responses",
    blockId: "block-01",
    campaignId: "campaign-01",
    campaignNonce: "one-use-campaign-nonce",
    executionProof,
    identityObservationTimeoutMs,
    identity: frontierIdentity,
    modeConfigProof,
    model: "openai/gpt-test",
    runDate: "2026-08-09",
    runner: {
      localModelLean: false,
      thinking: "off",
      timeoutSeconds: 180,
    },
    sampling: { seedSupport: "unsupported", seed: "provider-no-seed" },
    tasks: [
      {
        id: "task-b",
        fixtureSha256: "1".repeat(64),
        promptSha256: "2".repeat(64),
        oracleSha256: "3".repeat(64),
      },
      {
        id: "task-a",
        fixtureSha256: "4".repeat(64),
        promptSha256: "5".repeat(64),
        oracleSha256: "6".repeat(64),
      },
    ],
  });
}

type FrontierUsageFixture = {
  input: number;
  output: number;
  total: number;
};

function snapshot(
  mode: "direct" | "code",
  usage?: FrontierUsageFixture,
): AgentCommandRunAccountingSnapshot {
  const code = mode === "code";
  const calls = code ? 2 : 3;
  const callIds = Array.from({ length: calls }, (_, index) => `${mode}-${String(index + 1)}`);
  const collector = createProviderTransportAccountingCollector();
  for (const callId of callIds) {
    collector.observer.onLogicalCallStarted({
      callId,
      provider: "openai",
      model: "gpt-test",
      api: "responses",
    });
  }
  for (const [index, callId] of callIds.entries()) {
    collector.observer.onTransportEvent({
      eventId: `invocation-${callId}`,
      type: "invocation",
      provider: "openai",
      model: "gpt-test",
      api: "responses",
      callId,
      transport: "sse",
      ordinal: 1,
      attemptOrdinal: 1,
      hopOrdinal: 1,
      reason: "initial",
    });
    collector.observer.onTransportEvent({
      eventId: `attempt-${callId}`,
      type: "attempt",
      provider: "openai",
      model: "gpt-test",
      api: "responses",
      callId,
      transport: "sse",
      ordinal: 1,
      reason: "initial",
      outcome: "completed",
    });
    collector.observer.onLogicalCallSettled(callId, "completed", {
      state: "exact",
      tokens: index === 0 ? 10 : 0,
    });
    collector.finalize(callId);
  }
  collector.seal();
  const transport = collector.project();
  if (!transport.snapshot || transport.coverage.state !== "complete") {
    throw new Error("expected complete transport fixture");
  }
  const codeModeStats = createCodeModeStats();
  codeModeStats.bridgeCalls = code ? { search: 1 } : {};
  codeModeStats.bridgeLifecycle = code
    ? { registered: 1, started: 1, settled: 1, unresolvedAtExtraction: 0 }
    : {};
  return {
    candidates: {
      total: 1,
      returned: 1,
      threw: 0,
      runtimes: { embedded: 1, cli: 0, native: 0, cloud: 0, unknown: 0 },
      entries: [
        {
          provider: "openai",
          model: "gpt-test",
          runtime: "embedded",
          outcome: "returned",
          effectiveModels: {
            entries: [{ provider: "openai", model: "gpt-test" }],
            truncated: 0,
          },
        },
      ],
      truncated: 0,
    },
    agentSubmissions: { total: 1, completed: 1, failed: 0 },
    modelCalls: { total: calls, completed: calls, failed: 0 },
    assistantTurns: code ? 2 : 3,
    usage: {
      input: usage?.input ?? (code ? 70 : 90),
      cacheRead: 10,
      cacheWrite: 0,
      output: usage?.output ?? 20,
      reasoningTokens: 10,
      total: usage?.total ?? (code ? 100 : 130),
    },
    toolSummary: { calls: code ? 1 : 3, tools: code ? ["code_mode"] : ["read"] },
    providerTransport: transport.snapshot,
    agentDurationMs: code ? 80 : 100,
    commandExecutionDurationMs: code ? 90 : 110,
    coverage: {
      candidates: { state: "complete" },
      agentSubmissions: { state: "complete" },
      modelCalls: { state: "complete" },
      assistantTurns: { state: "complete" },
      usage: { state: "complete" },
      usageBuckets: {
        input: { state: "complete" },
        output: { state: "complete" },
        cacheRead: { state: "complete" },
        cacheWrite: { state: "complete" },
        reasoningTokens: { state: "complete" },
        total: { state: "complete" },
      },
      tools: { state: "complete" },
      cost: { state: "complete" },
      agentTime: { state: "complete" },
      commandExecutionDuration: { state: "complete" },
      wallLatency: { state: "complete" },
      providerTransport: { state: "complete" },
    },
    ...(code
      ? {
          codeMode: {
            engaged: true,
            stats: codeModeStats,
            lifecycle: {
              maxUnresolvedAtExtraction: 0,
              attemptsWithUnresolved: 0,
              finalQuiescence: { state: "quiescent" as const },
            },
          },
        }
      : {}),
  };
}

export function frontierTrace(mode: "direct" | "code", usage?: FrontierUsageFixture) {
  const value = projectAgentExecTrace({
    snapshot: snapshot(mode, usage),
    wallLatencyMs: mode === "code" ? 95 : 115,
    codeModeConfigured: mode === "code",
    provider: "openai",
    model: "gpt-test",
  });
  if (!value) {
    throw new Error("expected trace fixture");
  }
  return value;
}

export function frontierEnvelope(
  mode: "direct" | "code",
  outcome: "ok" | "task" | "infrastructure" | "timeout" | "cleanup" = "ok",
  usage?: FrontierUsageFixture,
): string {
  const status = outcome === "ok" ? "ok" : outcome === "timeout" ? "timeout" : "error";
  const phase =
    outcome === "task"
      ? "task"
      : outcome === "cleanup"
        ? "cleanup"
        : outcome === "ok"
          ? undefined
          : "infrastructure";
  const error = phase
    ? { message: `${outcome} fixture`, kind: `${outcome}_error`, phase }
    : undefined;
  return JSON.stringify({
    ok: outcome === "ok",
    status,
    final: "",
    payloads: [],
    trace: frontierTrace(mode, usage),
    model: "gpt-test",
    provider: "openai",
    sessionId: "test-session",
    ...(error ? { error } : {}),
    ...(outcome === "cleanup"
      ? {
          cleanup: {
            status: "failed",
            error: { message: "cleanup fixture", kind: "cleanup_error", phase: "cleanup" },
          },
        }
      : {}),
  });
}

export function frontierClocks() {
  let wall = Date.parse("2026-08-09T00:00:00.000Z");
  let mono = 0;
  return {
    wallNow: () => {
      wall += 1_000;
      return new Date(wall);
    },
    monotonicNow: () => {
      mono += 125;
      return mono;
    },
  };
}

export function frontierRunner(
  choose: (cell: FrozenFrontierMatrixPlan["cells"][number]) => {
    outcome?: "ok" | "task" | "infrastructure" | "timeout" | "cleanup";
    oracle?: boolean;
    envelope?: unknown;
  } = () => ({}),
) {
  return async (
    cell: FrozenFrontierMatrixPlan["cells"][number],
    plan: FrozenFrontierMatrixPlan,
  ): Promise<FrontierMatrixCellObservation> => {
    const selected = choose(cell);
    const task = plan.task.manifest[cell.taskIndex]!;
    const envelope = selected.envelope ?? frontierEnvelope(cell.mode, selected.outcome);
    if (typeof envelope === "string") {
      const parsed = JSON.parse(envelope) as { sessionId?: string };
      parsed.sessionId = `session-${cell.id}`;
      selected.envelope = JSON.stringify(parsed);
    }
    return {
      envelope: selected.envelope ?? envelope,
      oracle: { passed: selected.oracle ?? true },
      receipt: {
        cellId: cell.id,
        cellStateKey: cell.stateKey,
        taskId: cell.taskId,
        taskIndex: cell.taskIndex,
        taskSha256: cell.taskSha256,
        fixtureSha256: task.fixtureSha256,
        promptSha256: task.promptSha256,
        oracleSha256: task.oracleSha256,
        modeConfigSha256:
          cell.mode === "direct"
            ? plan.execution.modeConfigProof.directSha256
            : plan.execution.modeConfigProof.codeSha256,
      },
    };
  };
}

export function collectFrontierKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") {
    return keys;
  }
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectFrontierKeys(entry, keys);
  }
  return keys;
}
