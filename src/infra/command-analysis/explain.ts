// Command-analysis display helpers turn parsed command policy data into small
// warning summaries for approval surfaces without loading the rich parser path.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { CommandExplanation, CommandRisk } from "../command-explainer/types.js";
import type { ExecCommandSegment } from "../exec-approvals-analysis.js";
import { analyzeCommandForPolicy } from "./policy.js";
import { detectCommandCarrierArgv, detectInlineEvalInSegments } from "./risks.js";

/** Compact command explanation summary shown in approval UI. */
export type CommandExplanationSummary = {
  commandCount: number;
  nestedCommandCount: number;
  riskKinds: string[];
  warningLines: string[];
};

// Risk labels keep warnings readable without exposing full command payloads.
function riskLabel(risk: CommandRisk): string {
  switch (risk.kind) {
    case "inline-eval":
      return `${risk.command} ${risk.flag}`;
    case "shell-wrapper":
      return `${risk.executable} ${risk.flag}`;
    case "command-carrier":
      return risk.flag ? `${risk.command} ${risk.flag}` : risk.command;
    case "dynamic-argument":
      return `${risk.command} dynamic argument`;
    case "source":
      return risk.command;
    case "function-definition":
      return risk.name;
    default:
      return risk.kind;
  }
}

/** Summarizes parsed shell-command explanation data for display. */
function summarizeCommandExplanation(explanation: CommandExplanation): CommandExplanationSummary {
  const riskKinds = uniqueStrings(explanation.risks.map((risk) => risk.kind));
  const warningLines = explanation.risks.map((risk) => {
    const label = riskLabel(risk);
    return label === risk.kind ? `Contains ${risk.kind}` : `Contains ${risk.kind}: ${label}`;
  });
  return {
    commandCount: explanation.topLevelCommands.length,
    nestedCommandCount: explanation.nestedCommands.length,
    riskKinds,
    warningLines: uniqueStrings(warningLines),
  };
}

function summarizeCommandSegmentsForDisplay(
  segments: readonly ExecCommandSegment[],
): CommandExplanationSummary {
  const riskKinds: string[] = [];
  const warningLines: string[] = [];
  const inlineEval = detectInlineEvalInSegments(segments);
  if (inlineEval) {
    riskKinds.push("inline-eval");
    warningLines.push(
      `Contains inline-eval: ${inlineEval.normalizedExecutable} ${inlineEval.flag}`,
    );
  }
  for (const segment of segments) {
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    for (const hit of detectCommandCarrierArgv(effectiveArgv)) {
      riskKinds.push("command-carrier");
      warningLines.push(
        hit.flag
          ? `Contains command-carrier: ${hit.command} ${hit.flag}`
          : `Contains command-carrier: ${hit.command}`,
      );
    }
  }
  return {
    commandCount: segments.length,
    nestedCommandCount: 0,
    riskKinds: uniqueStrings(riskKinds),
    warningLines: uniqueStrings(warningLines),
  };
}

export async function resolveCommandAnalysisSummaryForDisplay(params: {
  host?: string | null;
  commandText: string;
  commandArgv?: string[];
  cwd?: string | null;
  sanitizeText?: (value: string) => string;
}): Promise<CommandExplanationSummary | null> {
  const summary =
    params.host === "node"
      ? (() => {
          if (!Array.isArray(params.commandArgv) || params.commandArgv.length === 0) {
            return null;
          }
          const analysis = analyzeCommandForPolicy({
            source: "argv",
            argv: params.commandArgv,
            cwd: params.cwd ?? undefined,
          });
          return analysis.ok ? summarizeCommandSegmentsForDisplay(analysis.segments) : null;
        })()
      : (await explainCommandForDisplay(params.commandText))?.summary;
  if (!summary) {
    return null;
  }
  const sanitizeText = params.sanitizeText;
  if (!sanitizeText) {
    return summary;
  }
  return {
    commandCount: summary.commandCount,
    nestedCommandCount: summary.nestedCommandCount,
    riskKinds: summary.riskKinds.map((kind) => sanitizeText(kind)),
    warningLines: summary.warningLines.map((line) => sanitizeText(line)),
  };
}

async function explainCommandForDisplay(
  command: string,
): Promise<{ explanation: CommandExplanation; summary: CommandExplanationSummary } | null> {
  try {
    const { explainShellCommand } = await import("../command-explainer/extract.js");
    const explanation = await explainShellCommand(command);
    return { explanation, summary: summarizeCommandExplanation(explanation) };
  } catch {
    return null;
  }
}
