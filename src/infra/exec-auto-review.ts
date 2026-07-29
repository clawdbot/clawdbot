import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatErrorMessage } from "./errors.js";

/** Risk level returned by exec auto-reviewers for approval routing decisions. */
type ExecAutoReviewRisk = "unknown" | "low" | "medium" | "high";

/** Auto-review outcome: either approve once or send the command to normal approval. */
export type ExecAutoReviewDecision =
  | {
      decision: "allow-once";
      rationale: string;
      risk: "low";
    }
  | {
      decision: "ask";
      rationale: string;
      risk: ExecAutoReviewRisk;
    };

/** Execution host whose command policy context is being reviewed. */
export type ExecAutoReviewHost = "gateway" | "node" | "codex-app-server";

/** Command and policy facts supplied to an exec auto-reviewer. */
export type ExecAutoReviewInput = {
  command: string;
  argv?: readonly string[];
  resolvedPath?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host: ExecAutoReviewHost;
  reason:
    | "approval-required"
    | "allowlist-miss"
    | "strict-inline-eval"
    | "heredoc"
    | "execution-plan-miss";
  analysis: {
    parsed: boolean;
    allowlistMatched: boolean;
    safeBinMatched?: boolean;
    durableApprovalMatched?: boolean;
    inlineEval: boolean;
    heredoc?: boolean;
    shellWrapper?: boolean;
  };
  agent?: {
    id?: string | null;
    sessionKey?: string | null;
  };
};

/** Reviewer function used by gateway/node exec paths before human approval fallback. */
export type ExecAutoReviewer = (
  input: ExecAutoReviewInput,
) => Promise<ExecAutoReviewDecision> | ExecAutoReviewDecision;

/** Keeps reviewer and provider explanations safe for human-facing approval text. */
export function normalizeExecAutoReviewRationale(value: unknown, fallback: string): string {
  const text = normalizeOptionalString(typeof value === "string" ? value : undefined);
  const sanitized = sanitizeTerminalText(text ?? fallback)
    .replace(/[\p{Cf}\u2028\u2029]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(sanitized || fallback, 500);
}

/** Turns reviewer and provider failures into a bounded, redacted human-review decision. */
export function buildExecAutoReviewFailureDecision(
  prefix: string,
  error: unknown,
): ExecAutoReviewDecision {
  return {
    decision: "ask",
    risk: "unknown",
    rationale: normalizeExecAutoReviewRationale(`${prefix}: ${formatErrorMessage(error)}`, prefix),
  };
}

/** Custom reviewer failures must defer to a human, never authorize or crash execution. */
export async function resolveExecAutoReviewDecision(
  reviewer: ExecAutoReviewer,
  input: ExecAutoReviewInput,
): Promise<ExecAutoReviewDecision> {
  try {
    return await reviewer(input);
  } catch (error) {
    return buildExecAutoReviewFailureDecision("exec reviewer failed", error);
  }
}

/**
 * Conservative fallback used when no model-backed reviewer is available.
 * Auto mode must never become a static allowlist; without a reviewer, defer to
 * the normal human approval route.
 */
export const defaultExecAutoReviewer: ExecAutoReviewer = (input) => {
  return {
    decision: "ask",
    rationale: `no model-backed exec reviewer is configured for ${input.host}`,
    risk: input.analysis.inlineEval ? "medium" : "unknown",
  };
};
