import { explainShellCommand, formatCommandSpans } from "../infra/command-explainer/index.js";
import type { ExecApprovalCommandSpan } from "../infra/exec-approvals.js";

export async function resolveExecApprovalCommandSpans(
  command: string,
): Promise<ExecApprovalCommandSpan[] | undefined> {
  const explanation = await explainShellCommand(command);
  const commandSpans = formatCommandSpans(explanation);
  return commandSpans.length > 0 ? commandSpans : undefined;
}
