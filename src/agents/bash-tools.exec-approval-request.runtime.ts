/**
 * Lazy runtime for exec approval command highlighting.
 * Kept separate so importing approval request code does not load the command
 * explainer until command spans are explicitly requested.
 */
import { explainShellCommand, formatCommandSpans } from "../infra/command-explainer/index.js";
import type { ExecApprovalCommandSpan } from "../infra/exec-approvals.js";

/** Resolve command spans used to highlight exec approval prompts. */
export async function resolveExecApprovalCommandSpans(
  command: string,
): Promise<ExecApprovalCommandSpan[] | undefined> {
  const explanation = await explainShellCommand(command);
  const commandSpans = formatCommandSpans(explanation);
  return commandSpans.length > 0 ? commandSpans : undefined;
}
