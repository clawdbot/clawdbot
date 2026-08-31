import type { RuntimeParityUsage } from "./runtime-parity-usage.js";

export type RuntimeParityCacheMiss = {
  turn: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

export type RuntimeParityCacheDiagnostics = {
  assistantTurns: number;
  cacheTelemetryTurns: number;
  cacheHitTurns: number;
  cacheWriteTurns: number;
  cacheMisses: RuntimeParityCacheMiss[];
  cacheMissInputTokens: number;
  unmeasuredPostWarmTurns: number[];
};

/** Detect complete cache losses only after this conversation has actually warmed its cache. */
export function buildRuntimeParityCacheDiagnostics(
  turns: readonly RuntimeParityUsage[],
): RuntimeParityCacheDiagnostics {
  const diagnostics: RuntimeParityCacheDiagnostics = {
    assistantTurns: turns.length,
    cacheTelemetryTurns: 0,
    cacheHitTurns: 0,
    cacheWriteTurns: 0,
    cacheMisses: [],
    cacheMissInputTokens: 0,
    unmeasuredPostWarmTurns: [],
  };
  let cacheWasWarmed = false;

  for (const [index, usage] of turns.entries()) {
    const cacheRead = usage.cacheRead;
    const cacheWrite = usage.cacheWrite;
    const cacheWasWarmBeforeTurn = cacheWasWarmed;
    if (cacheRead !== undefined && cacheRead > 0) {
      diagnostics.cacheHitTurns += 1;
      cacheWasWarmed = true;
    }
    if (cacheWrite !== undefined && cacheWrite > 0) {
      diagnostics.cacheWriteTurns += 1;
      cacheWasWarmed = true;
    }
    if (cacheRead === undefined || cacheWrite === undefined) {
      if (cacheWasWarmBeforeTurn) {
        diagnostics.unmeasuredPostWarmTurns.push(index + 1);
      }
      continue;
    }
    diagnostics.cacheTelemetryTurns += 1;
    const missedInputTokens = usage.inputTokens + cacheWrite;
    // A zero-read rewrite still reprocesses the entire prefix; the write only
    // repopulates the cache for a later turn and must not conceal this miss.
    if (cacheWasWarmBeforeTurn && cacheRead === 0 && missedInputTokens > 0) {
      diagnostics.cacheMisses.push({
        turn: index + 1,
        inputTokens: missedInputTokens,
        cacheRead,
        cacheWrite,
      });
      diagnostics.cacheMissInputTokens += missedInputTokens;
    }
  }

  return diagnostics;
}
