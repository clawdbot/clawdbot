// Approval-policy command analysis normalizes shell and argv inputs into the
// shared exec segment shape consumed by risk checks.
import {
  analyzeArgvCommand,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import { detectInlineEvalInSegments } from "./risks.js";

/** Normalized policy analysis result for argv and shell commands. */
type CommandPolicyAnalysis =
  | {
      ok: true;
      source: "argv" | "shell";
      analysis: ExecCommandAnalysis;
      segments: ExecCommandSegment[];
    }
  | {
      ok: false;
      source: "argv" | "shell";
      reason?: string;
      analysis: ExecCommandAnalysis;
      segments: [];
    };

/** Parses a shell or argv command into command segments for approval policy checks. */
export function analyzeCommandForPolicy(params: {
  source: "argv";
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): CommandPolicyAnalysis {
  const analysis = analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
  if (!analysis.ok) {
    return {
      ok: false,
      source: params.source,
      reason: analysis.reason,
      analysis,
      segments: [],
    };
  }
  return {
    ok: true,
    source: params.source,
    analysis,
    segments: analysis.segments,
  };
}

export function detectPolicyInlineEval(segments: readonly ExecCommandSegment[]) {
  return detectInlineEvalInSegments(segments);
}
