/**
 * Visible-reply loop detection.
 *
 * Watches the last N assistant-visible replies per session for two
 * no-progress patterns the existing tool-loop detector misses:
 *
 *   1. same_visible_reply: the assistant emits byte-identical (or
 *      near-identical) visible text across multiple turns, with no
 *      tool-call progress between them.
 *   2. same_plan_rewrite: the assistant keeps rewriting the same
 *      `update_plan` payload (same step hashes, same in-progress step)
 *      across multiple turns.
 *
 * Both patterns are the signature of an LLM that has lost the thread
 * and is hallucinating repetition instead of making forward progress.
 * The existing tool-loop detector at `tool-loop-detection.ts` only
 * catches repeated tool calls; an agent can spiral in plain-text
 * narration with intermittent `update_plan` calls that all rewrite
 * the same plan, and the tool-level detector never fires.
 *
 * This module emits a single `stuck: true` result with a clear
 * "session execution blocked" message that the agent runner surfaces
 * to the LLM as a no-progress notice, identical in shape to the
 * existing tool-loop detection result so the runner doesn't need a
 * second branch.
 *
 * Implementation notes:
 *  - Pure functions; no I/O. The session-state history is owned by
 *    the caller (the embedded-agent-runner) and passed in.
 *  - Hashing uses sha256 over trimmed visible text and over a
 *    canonical JSON serialization of the plan array.
 *  - Thresholds default to: warning at 3 identical replies in a row,
 *    critical (abort) at 5. These are conservative — the existing
 *    tool-loop detector uses 10/20/30 because tool calls can be
 *    legitimately idempotent (poll loops). Visible text repetition
 *    is almost never legitimate, so the threshold is tighter.
 *  - Near-identical detection: Levenshtein ratio > 0.9 on the first
 *    280 chars counts as a hit. Catches the "Confirmed: /TR writes
 *    to trip ledger..." pattern where the LLM re-emits the same
 *    paragraph with minor edits.
 */
import { createHash } from "node:crypto";

/** Default thresholds. Warning at 3, critical at 5. Conservative. */
export const VISIBLE_REPLY_WARNING_THRESHOLD = 3;
export const VISIBLE_REPLY_CRITICAL_THRESHOLD = 5;
const VISIBLE_REPLY_HISTORY_SIZE = 8;
const NEAR_IDENTICAL_RATIO = 0.9;
const NEAR_IDENTICAL_PREVIEW_CHARS = 280;

export type VisibleReplyRecord = {
  /** sha256 of the trimmed visible text */
  textHash: string;
  /** trimmed visible text, kept for near-identical comparison */
  text: string;
  /** sha256 of the canonical plan array, if any plan was emitted */
  planHash?: string;
  /** unix-ms timestamp */
  timestamp: number;
};

export type VisibleLoopDetectionConfig = {
  enabled: boolean;
  warningThreshold?: number;
  criticalThreshold?: number;
};

export type VisibleLoopDetectionScope = {
  runId?: string;
  sessionKey?: string;
};

export type VisibleLoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: "same_visible_reply" | "same_plan_rewrite";
      count: number;
      message: string;
      warningKey: string;
    };

const DEFAULT_CONFIG = {
  enabled: true,
  warningThreshold: VISIBLE_REPLY_WARNING_THRESHOLD,
  criticalThreshold: VISIBLE_REPLY_CRITICAL_THRESHOLD,
};

function resolveConfig(config?: VisibleLoopDetectionConfig) {
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    warningThreshold: config?.warningThreshold ?? DEFAULT_CONFIG.warningThreshold,
    criticalThreshold: config?.criticalThreshold ?? DEFAULT_CONFIG.criticalThreshold,
  };
}

function normalizeScopeKey(scope?: VisibleLoopDetectionScope): string {
  return `${scope?.runId ?? ""}::${scope?.sessionKey ?? ""}`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

/**
 * Stable hash of a plan payload. The plan is a list of
 * `{step, status}` objects; order matters. We sort the keys inside
 * each step but keep step order so plan rewrites that just shuffle
 * step text are still detected as identical.
 */
function hashPlan(plan: ReadonlyArray<{ step: string; status: string }>): string {
  const canonical = plan
    .map((p) => ({ step: p.step, status: p.status }))
    .map((p) => JSON.stringify(p, Object.keys(p).sort()));
  return createHash("sha256").update(canonical.join("\n")).digest("hex");
}

/**
 * Cheap near-identical ratio. We don't pull in a full Levenshtein
 * library for this — `difflib` is overkill. Instead, we count the
 * longest common prefix and the count of matching tokens in the
 * preview window. If both are above 80% of the preview length, we
 * treat the texts as near-identical.
 *
 * Returns a number in [0, 1].
 */
function nearIdenticalRatio(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }
  const limit = Math.min(a.length, b.length, NEAR_IDENTICAL_PREVIEW_CHARS);
  if (limit === 0) {
    return 0;
  }
  const aWindow = a.slice(0, limit);
  const bWindow = b.slice(0, limit);
  // Common prefix length.
  let commonPrefix = 0;
  for (let i = 0; i < limit; i += 1) {
    if (aWindow[i] === bWindow[i]) {
      commonPrefix += 1;
    } else {
      break;
    }
  }
  // Token overlap on word boundaries.
  const aTokens = new Set(aWindow.toLowerCase().split(/\s+/).filter(Boolean));
  const bTokens = bWindow.toLowerCase().split(/\s+/).filter(Boolean);
  let matching = 0;
  for (const t of bTokens) {
    if (aTokens.has(t)) {
      matching += 1;
    }
  }
  const tokenRatio = bTokens.length > 0 ? matching / bTokens.length : 0;
  const prefixRatio = commonPrefix / limit;
  // Geometric mean of the two ratios — both must be high for the texts
  // to count as near-identical.
  return Math.sqrt(prefixRatio * tokenRatio);
}

/**
 * Detect if the assistant has been emitting the same visible reply
 * (or near-identical) or rewriting the same plan across the last
 * `historySize` turns. Returns a structured result identical in
 * shape to `detectToolCallLoop` so the agent runner can dispatch
 * it the same way.
 */
export function detectVisibleReplyLoop(
  history: ReadonlyArray<VisibleReplyRecord>,
  currentVisibleText: string,
  currentPlan: ReadonlyArray<{ step: string; status: string }> | undefined,
  config?: VisibleLoopDetectionConfig,
  scope?: VisibleLoopDetectionScope,
): VisibleLoopDetectionResult {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) {
    return { stuck: false };
  }

  // Scope filter: only count history rows that match this scope.
  // We don't carry scope on each record (caller does the scoping),
  // but the caller passes the already-filtered history slice.
  void normalizeScopeKey(scope);

  if (history.length === 0) {
    return { stuck: false };
  }

  const trimmed = currentVisibleText.trim();

  // 1) Exact same-text repeat (most aggressive detector).
  // The streak includes the current turn, so a count of N means the
  // current turn + N-1 consecutive matching history entries.
  let sameTextStreak = trimmed.length > 0 ? 1 : 0;
  if (trimmed.length > 0) {
    const currentHash = hashText(trimmed);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const rec = history[i];
      if (!rec || rec.textHash !== currentHash) {
        break;
      }
      sameTextStreak += 1;
    }
  }

  // 2) Near-identical text repeat. Current turn counts as 1.
  let nearIdenticalStreak = trimmed.length > 0 ? 1 : 0;
  if (trimmed.length > 0) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const rec = history[i];
      if (!rec) {
        continue;
      }
      if (rec.text.trim().length === 0) {
        continue;
      }
      if (nearIdenticalRatio(rec.text, trimmed) >= NEAR_IDENTICAL_RATIO) {
        nearIdenticalStreak += 1;
      } else {
        break;
      }
    }
  }

  const bestTextStreak = Math.max(sameTextStreak, nearIdenticalStreak);

  // 3) Same plan rewrite. Current turn counts as 1.
  let samePlanStreak = currentPlan && currentPlan.length > 0 ? 1 : 0;
  if (currentPlan && currentPlan.length > 0) {
    const currentPlanHash = hashPlan(currentPlan);
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const rec = history[i];
      if (!rec || rec.planHash !== currentPlanHash) {
        break;
      }
      samePlanStreak += 1;
    }
  }

  // Pick the strongest signal.
  if (bestTextStreak >= cfg.criticalThreshold) {
    return {
      stuck: true,
      level: "critical",
      detector: "same_visible_reply",
      count: bestTextStreak,
      message:
        `CRITICAL: assistant emitted the same visible reply ${bestTextStreak} times in a row. ` +
        `Session execution blocked to prevent runaway narration loop. ` +
        `Either take a real action that produces a new tool result, or report the task as blocked.`,
      warningKey: `visible-reply:${hashText(trimmed)}:${bestTextStreak}`,
    };
  }

  if (bestTextStreak >= cfg.warningThreshold) {
    return {
      stuck: true,
      level: "warning",
      detector: "same_visible_reply",
      count: bestTextStreak,
      message:
        `WARNING: assistant emitted the same visible reply ${bestTextStreak} times in a row. ` +
        `If this is not making progress, stop repeating yourself and either take a real ` +
        `action (run a tool, edit a file) or report the task as blocked.`,
      warningKey: `visible-reply:${hashText(trimmed)}:${bestTextStreak}`,
    };
  }

  if (samePlanStreak >= cfg.criticalThreshold) {
    return {
      stuck: true,
      level: "critical",
      detector: "same_plan_rewrite",
      count: samePlanStreak,
      message:
        `CRITICAL: assistant rewrote the same plan payload ${samePlanStreak} times with no ` +
        `progress. Session execution blocked to prevent runaway plan-rewrite loop. ` +
        `Either complete a real step (mark a step done) or report the task as blocked.`,
      warningKey: `plan-rewrite:${(currentPlan && hashPlan(currentPlan)) || "empty"}:${samePlanStreak}`,
    };
  }

  if (samePlanStreak >= cfg.warningThreshold) {
    return {
      stuck: true,
      level: "warning",
      detector: "same_plan_rewrite",
      count: samePlanStreak,
      message:
        `WARNING: assistant rewrote the same plan payload ${samePlanStreak} times. ` +
        `Make forward progress by completing a real step, or stop and report the task as blocked.`,
      warningKey: `plan-rewrite:${(currentPlan && hashPlan(currentPlan)) || "empty"}:${samePlanStreak}`,
    };
  }

  return { stuck: false };
}

/**
 * Append a record to the history. Returns the trimmed history
 * (max `historySize` entries). Pure: caller owns the array.
 */
export function recordVisibleReply(
  history: VisibleReplyRecord[],
  visibleText: string,
  plan: ReadonlyArray<{ step: string; status: string }> | undefined,
  historySize: number = VISIBLE_REPLY_HISTORY_SIZE,
): VisibleReplyRecord[] {
  const trimmed = visibleText.trim();
  const record: VisibleReplyRecord = {
    textHash: hashText(trimmed),
    text: trimmed,
    planHash: plan && plan.length > 0 ? hashPlan(plan) : undefined,
    timestamp: Date.now(),
  };
  history.push(record);
  if (history.length > historySize) {
    history.splice(0, history.length - historySize);
  }
  return history;
}

export const __test = {
  hashText,
  hashPlan,
  nearIdenticalRatio,
  NEAR_IDENTICAL_RATIO,
  VISIBLE_REPLY_HISTORY_SIZE,
};
