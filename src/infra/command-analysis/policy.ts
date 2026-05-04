import {
  analyzeArgvCommand,
  analyzeShellCommand,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import { detectInlineEvalInSegments } from "./risks.js";

export type CommandPolicyAnalysis =
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

export function analyzeCommandForPolicy(
  params:
    | {
        source: "shell";
        command: string;
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        platform?: string | null;
      }
    | {
        source: "argv";
        argv: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
      },
): CommandPolicyAnalysis {
  const analysis =
    params.source === "shell"
      ? analyzeShellCommand({
          command: params.command,
          cwd: params.cwd,
          env: params.env,
          platform: params.platform,
        })
      : analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
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
