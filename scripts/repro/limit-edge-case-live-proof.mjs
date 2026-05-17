#!/usr/bin/env node
import assert from "node:assert/strict";
/**
 * Live repro for limit/CLI numeric fixes (PR #82679). Run: pnpm exec tsx scripts/repro/limit-edge-case-live-proof.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testing as voiceCallCliTesting } from "../../extensions/voice-call/src/cli.ts";
import { loadSessionLogs, loadSessionUsageTimeSeries } from "../../src/infra/session-cost-usage.ts";
import {
  getRecentDiagnosticPhases,
  recordDiagnosticPhase,
  resetDiagnosticPhasesForTest,
} from "../../src/logging/diagnostic-phase.ts";

async function main() {
  resetDiagnosticPhasesForTest();
  recordDiagnosticPhase({
    name: "phase-a",
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    cpuTotalMs: 0,
    cpuCoreRatio: 0,
  });
  recordDiagnosticPhase({
    name: "phase-b",
    startedAt: 3,
    endedAt: 4,
    durationMs: 1,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    cpuTotalMs: 0,
    cpuCoreRatio: 0,
  });
  const zeroPhases = getRecentDiagnosticPhases(0);
  assert.equal(zeroPhases.length, 0);
  console.log("getRecentDiagnosticPhases(0).length =", zeroPhases.length);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-"));
  const sessionFile = path.join(root, "s.jsonl");
  fs.writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "a" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: {
          role: "assistant",
          content: "b",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { total: 0.001 },
          },
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:02:00.000Z",
        message: {
          role: "assistant",
          content: "c",
          provider: "openai",
          model: "gpt-5.5",
          usage: {
            input: 3,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 7,
            cost: { total: 0.002 },
          },
        },
      }),
    ].join("\n"),
  );

  const logs = await loadSessionLogs({ sessionFile, limit: 0 });
  const series = await loadSessionUsageTimeSeries({ sessionFile, maxPoints: 0 });
  const positiveLogs = await loadSessionLogs({ sessionFile, limit: 10 });
  const positiveSeries = await loadSessionUsageTimeSeries({ sessionFile, maxPoints: 10 });
  assert.equal(logs?.length, 0);
  assert.equal(series.points.length, 0);
  assert.equal(positiveLogs?.length, 3);
  assert.equal(positiveSeries.points.length, 2);
  console.log("loadSessionLogs({ limit: 0 }).length =", logs?.length);
  console.log(
    "loadSessionUsageTimeSeries({ maxPoints: 0 }).points.length =",
    series?.points.length,
  );

  try {
    voiceCallCliTesting.parseVoiceCallIntOption("nope", "--port", { min: 1 });
    assert.fail("expected invalid voicecall --port value to throw");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message, "Invalid numeric value for --port: nope");
    console.log("parseVoiceCallIntOption('nope', '--port') error:", message);
  }
}

await main();
