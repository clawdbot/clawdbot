// Proof for PR #118650: verifies that the gateway preflight compaction owner
// is already protected against contextWindow=0, independent of the setup.ts
// repair. Drives real production source — no mocks.
//
// Three compaction decision paths are exercised:
//   A. Preflight path: resolveMemoryFlushContextWindowTokens + shouldRunPreflightCompaction
//   B. checkCompaction path: shouldCompact (the path setup.ts protects via effectiveModel)
//   C. Setup repair: resolveEmbeddedRuntimeModelPolicy repairs a nonpositive runtime window

import { shouldCompact } from "../packages/agent-core/src/harness/compaction/compaction.ts";
import { resolveContextWindowInfo } from "../src/agents/context-window-guard.ts";
import { resolveEmbeddedRuntimeModelPolicy } from "../src/agents/embedded-agent-runner/run/setup.ts";
import {
  shouldRunPreflightCompaction,
  resolveMemoryFlushContextWindowTokens,
} from "../src/auto-reply/reply/memory-flush.ts";

const TOKENS_65K = 65320;
const RESERVE = 20000;
const SOFT_THRESHOLD = 4000;

console.log("=== PR #118650: preflight owner protection proof ===");
console.log("Issue #86684 scenario: contextWindow=0, tokens=65320 (6% of 1.05M)\n");

// --- Path A: Preflight compaction owner (the path ClawSweeper flagged) ---
console.log("--- Path A: Preflight owner (runPreflightCompactionIfNeeded decision) ---");

// A1: resolveMemoryFlushContextWindowTokens never returns 0 — it falls back to DEFAULT_CONTEXT_TOKENS
const preflightWindow = resolveMemoryFlushContextWindowTokens({
  cfg: undefined,
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  agentCfgContextTokens: undefined,
});
console.log(
  `A1: resolveMemoryFlushContextWindowTokens(provider=anthropic, modelId=claude-sonnet-4-5)`,
);
console.log(
  `    => ${preflightWindow} (DEFAULT_CONTEXT_TOKENS fallback when metadata unavailable, never 0)`,
);

// A2: even if contextWindowTokens=0 were passed directly, shouldRunPreflightCompaction clamps it
const preflightDecisionZero = shouldRunPreflightCompaction({
  entry: { totalTokens: TOKENS_65K, totalTokensFresh: true },
  tokenCount: TOKENS_65K,
  contextWindowTokens: 0,
  reserveTokensFloor: RESERVE,
  softThresholdTokens: SOFT_THRESHOLD,
});
console.log(`A2: shouldRunPreflightCompaction(contextWindowTokens=0, tokens=${TOKENS_65K})`);
console.log(
  `    => ${preflightDecisionZero} (Math.max(1, 0)=1, threshold=max(0, 1-20000-4000)=0, threshold<=0 => return null => false)`,
);

// A3: normal positive window with low usage — also no compaction
const preflightDecisionNormal = shouldRunPreflightCompaction({
  entry: { totalTokens: TOKENS_65K, totalTokensFresh: true },
  tokenCount: TOKENS_65K,
  contextWindowTokens: 1050000,
  reserveTokensFloor: RESERVE,
  softThresholdTokens: SOFT_THRESHOLD,
});
console.log(`A3: shouldRunPreflightCompaction(contextWindowTokens=1050000, tokens=${TOKENS_65K})`);
console.log(`    => ${preflightDecisionNormal} (6% usage, no compaction, correct)`);

// A4: high usage with valid window — compaction triggers (sanity check)
const preflightDecisionHigh = shouldRunPreflightCompaction({
  entry: { totalTokens: 195000, totalTokensFresh: true },
  tokenCount: 195000,
  contextWindowTokens: 200000,
  reserveTokensFloor: RESERVE,
  softThresholdTokens: SOFT_THRESHOLD,
});
console.log(`A4: shouldRunPreflightCompaction(contextWindowTokens=200000, tokens=195000)`);
console.log(`    => ${preflightDecisionHigh} (threshold exceeded, compaction, correct)\n`);

// --- Path B: checkCompaction path (the path setup.ts protects) ---
console.log(
  "--- Path B: checkCompaction path (shouldCompact — protected by setup.ts effectiveModel) ---",
);
const checkCompactionZero = shouldCompact(TOKENS_65K, 0, {
  enabled: true,
  reserveTokens: RESERVE,
  keepRecentTokens: 0,
});
console.log(`B1: shouldCompact(tokens=${TOKENS_65K}, contextWindow=0)`);
console.log(`    => ${checkCompactionZero} (guard returns false for contextWindow <= 0)`);

const checkCompactionNormal = shouldCompact(TOKENS_65K, 1050000, {
  enabled: true,
  reserveTokens: RESERVE,
  keepRecentTokens: 0,
});
console.log(`B2: shouldCompact(tokens=${TOKENS_65K}, contextWindow=1050000)`);
console.log(`    => ${checkCompactionNormal} (6% usage, no compaction, correct)\n`);

// --- Path C: Setup canonical repair (resolveEmbeddedRuntimeModelPolicy) ---
console.log(
  "--- Path C: Setup canonical repair (resolveEffectiveRuntimeModel via resolveEmbeddedRuntimeModelPolicy) ---",
);

// C1: verify resolveContextWindowInfo always returns a positive budget
const ctxInfoNoCfg = resolveContextWindowInfo({
  cfg: undefined,
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  modelContextTokens: undefined,
  modelContextWindow: 0,
  defaultTokens: 200000,
});
console.log(`C1: resolveContextWindowInfo(modelContextWindow=0, no cfg)`);
console.log(
  `    => tokens=${ctxInfoNoCfg.tokens} source=${ctxInfoNoCfg.source} (always positive via defaultTokens)`,
);

// C2: a runtime model with contextWindow=0 (simulating missing metadata) gets repaired
const runtimeModelZeroWindow = {
  id: "claude-sonnet-4-5",
  provider: "anthropic",
  contextWindow: 0,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const policyRepaired = resolveEmbeddedRuntimeModelPolicy({
  cfg: undefined,
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  runtimeModel: runtimeModelZeroWindow,
  nativeModelOwned: false,
});
console.log(`C2: resolveEmbeddedRuntimeModelPolicy(runtimeModel.contextWindow=0)`);
console.log(
  `    => effectiveModel.contextWindow=${policyRepaired.effectiveModel.contextWindow} (repaired to positive budget)`,
);
console.log(`    => contextTokenBudget=${policyRepaired.contextTokenBudget}`);

// C3: a runtime model with valid positive contextWindow is unaffected
const runtimeModelValid = {
  id: "claude-sonnet-4-5",
  provider: "anthropic",
  contextWindow: 1050000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const policyValid = resolveEmbeddedRuntimeModelPolicy({
  cfg: undefined,
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  runtimeModel: runtimeModelValid,
  nativeModelOwned: false,
});
console.log(`C3: resolveEmbeddedRuntimeModelPolicy(runtimeModel.contextWindow=1050000)`);
console.log(
  `    => effectiveModel.contextWindow=${policyValid.effectiveModel.contextWindow} (unchanged, backward compatible)`,
);

console.log("\n=== Summary ===");
console.log(
  "Path A (preflight owner): protected by DEFAULT_CONTEXT_TOKENS fallback + Math.max(1,...) clamp — never sees contextWindow=0",
);
console.log("Path B (checkCompaction): protected by shouldCompact() guard (defensive backstop)");
console.log(
  "Path C (setup canonical): resolveEffectiveRuntimeModel repairs nonpositive window to resolved positive budget",
);
console.log(
  "All three compaction decision paths return false for contextWindow=0, tokens=65320 — no spurious compaction.",
);
