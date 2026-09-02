import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  formatSqliteSessionFileMarker,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it } from "vitest";
import { buildRuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import { captureRuntimeParityCell, type RuntimeParityUsage } from "./runtime-parity.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();

afterEach(async () => {
  // Fixtures point a state dir at these temp workspaces, so the shared and per-agent
  // SQLite handles stay cached and Windows fails the removal with EBUSY. The agent close
  // releases its leases through shared state and reopens it, so the store is released second.
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await tempDirs.cleanup();
});

async function seedRuntimeParityCacheTranscript(messages: Array<Record<string, unknown>>) {
  const tempRoot = await tempDirs.makeTempDir("openclaw-qa-runtime-parity-cache-");
  const agentId = "qa";
  const sessionId = "runtime-parity-cache-miss";
  const sessionKey = "agent:qa:runtime-parity-cache-miss";
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
  const storePath = resolveStorePath(undefined, { agentId, env });
  await upsertSessionEntry({
    agentId,
    env,
    sessionKey,
    storePath,
    entry: {
      sessionId,
      sessionFile: formatSqliteSessionFileMarker({ agentId, sessionId, storePath }),
      updatedAt: 100,
    },
  });
  for (const [index, message] of messages.entries()) {
    await appendSessionTranscriptMessageByIdentity({
      agentId,
      env,
      sessionId,
      sessionKey,
      storePath,
      now: index + 1,
      message: message as never,
    });
  }
  return tempRoot;
}

function usage(
  inputTokens: number,
  cache?: { cacheRead: number; cacheWrite: number },
): RuntimeParityUsage {
  return {
    inputTokens,
    outputTokens: 11,
    totalTokens: inputTokens + 11 + (cache?.cacheRead ?? 0) + (cache?.cacheWrite ?? 0),
    ...cache,
  };
}

describe("runtime parity prompt-cache diagnostics", () => {
  it("captures post-warm cache losses from the canonical SQLite assistant transcript", async () => {
    const tempRoot = await seedRuntimeParityCacheTranscript([
      { role: "user", content: "Warm the native conversation." },
      {
        role: "assistant",
        content: "warm",
        usage: { input: 3, output: 11, total: 24_421, cacheRead: 0, cacheWrite: 24_407 },
      },
      { role: "user", content: "Continue that conversation." },
      {
        role: "assistant",
        content: "continued",
        usage: { input: 24_448, output: 11, total: 24_459, cacheRead: 0, cacheWrite: 0 },
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "codex",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.cacheDiagnostics).toEqual({
      assistantTurns: 2,
      cacheTelemetryTurns: 2,
      cacheHitTurns: 0,
      cacheWriteTurns: 1,
      cacheMisses: [{ turn: 2, inputTokens: 24_448, cacheRead: 0, cacheWrite: 0 }],
      cacheMissInputTokens: 24_448,
      unmeasuredPostWarmTurns: [],
    });
    expect(cell.usage).toMatchObject({
      inputTokens: 24_451,
      outputTokens: 22,
      cacheRead: 0,
      cacheWrite: 24_407,
    });
  });

  it("treats Ollama adapter cache zeros as unavailable telemetry", async () => {
    const tempRoot = await seedRuntimeParityCacheTranscript([
      { role: "user", content: "Inspect cache telemetry." },
      {
        role: "assistant",
        content: "done",
        api: "ollama",
        provider: "ollama",
        model: "qwen3.5:9b",
        usage: {
          input: 22,
          output: 7,
          total: 29,
          cacheRead: 0,
          cacheWrite: 0,
          cacheTelemetry: { state: "unavailable" },
        },
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.usage).toEqual({
      inputTokens: 22,
      outputTokens: 7,
      totalTokens: 29,
    });
    expect(cell.cacheDiagnostics).toEqual({
      assistantTurns: 1,
      cacheTelemetryTurns: 0,
      cacheHitTurns: 0,
      cacheWriteTurns: 0,
      cacheMisses: [],
      cacheMissInputTokens: 0,
      unmeasuredPostWarmTurns: [],
    });
  });

  it("preserves unavailable cache telemetry from pre-marker Ollama transcripts", async () => {
    const tempRoot = await seedRuntimeParityCacheTranscript([
      { role: "user", content: "Inspect cache telemetry." },
      {
        role: "assistant",
        content: "done",
        api: "ollama",
        provider: "ollama",
        model: "qwen3.5:9b",
        usage: { input: 22, output: 7, total: 29, cacheRead: 0, cacheWrite: 0 },
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.usage).toEqual({
      inputTokens: 22,
      outputTokens: 7,
      totalTokens: 29,
    });
    expect(cell.cacheDiagnostics?.cacheTelemetryTurns).toBe(0);
  });

  it("preserves an explicitly measured zero-cache result", async () => {
    const tempRoot = await seedRuntimeParityCacheTranscript([
      { role: "user", content: "Inspect cache telemetry." },
      {
        role: "assistant",
        content: "done",
        api: "ollama",
        provider: "ollama",
        model: "future-ollama",
        usage: {
          input: 22,
          output: 7,
          total: 29,
          cacheRead: 0,
          cacheWrite: 0,
          cacheTelemetry: { state: "available" },
        },
      },
    ]);

    const cell = await captureRuntimeParityCell({
      runtime: "openclaw",
      gateway: { tempRoot },
      scenarioResult: { status: "pass" },
      wallClockMs: 10,
    });

    expect(cell.usage).toEqual({
      inputTokens: 22,
      outputTokens: 7,
      totalTokens: 29,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(cell.cacheDiagnostics?.cacheTelemetryTurns).toBe(1);
  });

  it("identifies the first complete cache miss after a cache-warming write", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(3, { cacheRead: 0, cacheWrite: 24_407 }),
      usage(24_448, { cacheRead: 0, cacheWrite: 0 }),
      usage(41, { cacheRead: 24_445, cacheWrite: 0 }),
    ]);

    expect(diagnostics).toEqual({
      assistantTurns: 3,
      cacheTelemetryTurns: 3,
      cacheHitTurns: 1,
      cacheWriteTurns: 1,
      cacheMisses: [{ turn: 2, inputTokens: 24_448, cacheRead: 0, cacheWrite: 0 }],
      cacheMissInputTokens: 24_448,
      unmeasuredPostWarmTurns: [],
    });
  });

  it("identifies complete cache losses later in an already cached conversation", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(5, { cacheRead: 0, cacheWrite: 1_000 }),
      usage(8, { cacheRead: 1_000, cacheWrite: 0 }),
      usage(1_050, { cacheRead: 0, cacheWrite: 0 }),
      usage(12, { cacheRead: 1_050, cacheWrite: 0 }),
      usage(1_100, { cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(diagnostics.cacheMisses).toEqual([
      { turn: 3, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 },
      { turn: 5, inputTokens: 1_100, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(diagnostics.cacheMissInputTokens).toBe(2_150);
  });

  it("counts a zero-read post-warm cache rewrite as a complete miss", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(3, { cacheRead: 0, cacheWrite: 1_000 }),
      usage(200, { cacheRead: 800, cacheWrite: 0 }),
      usage(20, { cacheRead: 0, cacheWrite: 1_100 }),
    ]);

    expect(diagnostics.cacheMisses).toEqual([
      { turn: 3, inputTokens: 1_120, cacheRead: 0, cacheWrite: 1_100 },
    ]);
    expect(diagnostics.cacheMissInputTokens).toBe(1_120);
    expect(diagnostics.cacheHitTurns).toBe(1);
    expect(diagnostics.cacheWriteTurns).toBe(2);
  });

  it("counts write-only processed input when a post-warm miss rewrites the cache", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(3, { cacheRead: 0, cacheWrite: 1_000 }),
      usage(0, { cacheRead: 0, cacheWrite: 1_100 }),
    ]);

    expect(diagnostics.cacheMisses).toEqual([
      { turn: 2, inputTokens: 1_100, cacheRead: 0, cacheWrite: 1_100 },
    ]);
    expect(diagnostics.cacheMissInputTokens).toBe(1_100);
  });

  it("does not mistake unavailable cache telemetry for a measured cache miss", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(3, { cacheRead: 0, cacheWrite: 1_000 }),
      usage(1_050),
      usage(8, { cacheRead: 1_000, cacheWrite: 0 }),
    ]);

    expect(diagnostics.assistantTurns).toBe(3);
    expect(diagnostics.cacheTelemetryTurns).toBe(2);
    expect(diagnostics.cacheMisses).toEqual([]);
    expect(diagnostics.unmeasuredPostWarmTurns).toEqual([2]);
  });

  it.each([
    {
      name: "a measured cache hit without cache-write telemetry",
      partialUsage: { cacheRead: 1_000 },
      cacheHitTurns: 1,
      cacheWriteTurns: 0,
    },
    {
      name: "a measured cache write without cache-hit telemetry",
      partialUsage: { cacheWrite: 1_000 },
      cacheHitTurns: 0,
      cacheWriteTurns: 1,
    },
  ])("recognizes $name as proof that the conversation is warm", (testCase) => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      { ...usage(3), ...testCase.partialUsage },
      usage(1_050, { cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(diagnostics).toEqual({
      assistantTurns: 2,
      cacheTelemetryTurns: 1,
      cacheHitTurns: testCase.cacheHitTurns,
      cacheWriteTurns: testCase.cacheWriteTurns,
      cacheMisses: [{ turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 }],
      cacheMissInputTokens: 1_050,
      unmeasuredPostWarmTurns: [],
    });
  });

  it("preserves measured misses without concealing later unmeasured warm turns", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(3, { cacheRead: 0, cacheWrite: 1_000 }),
      usage(1_050, { cacheRead: 0, cacheWrite: 0 }),
      usage(1_100),
      { ...usage(12), cacheRead: 1_000 },
    ]);

    expect(diagnostics.cacheMisses).toEqual([
      { turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(diagnostics.cacheMissInputTokens).toBe(1_050);
    expect(diagnostics.unmeasuredPostWarmTurns).toEqual([3, 4]);
    expect(diagnostics.cacheHitTurns).toBe(1);
  });

  it("does not flag a cold conversation that never established a cache", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(1_000, { cacheRead: 0, cacheWrite: 0 }),
      usage(1_050, { cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(diagnostics.cacheMisses).toEqual([]);
    expect(diagnostics.cacheMissInputTokens).toBe(0);
  });

  it("does not classify output-only turns as input-cache misses", () => {
    const diagnostics = buildRuntimeParityCacheDiagnostics([
      usage(3, { cacheRead: 0, cacheWrite: 1_000 }),
      usage(0, { cacheRead: 0, cacheWrite: 0 }),
    ]);

    expect(diagnostics.cacheMisses).toEqual([]);
  });

  it("reports an empty transcript without inventing cache telemetry", () => {
    expect(buildRuntimeParityCacheDiagnostics([])).toEqual({
      assistantTurns: 0,
      cacheTelemetryTurns: 0,
      cacheHitTurns: 0,
      cacheWriteTurns: 0,
      cacheMisses: [],
      cacheMissInputTokens: 0,
      unmeasuredPostWarmTurns: [],
    });
  });
});
