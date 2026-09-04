import { classifyCronAgentTurnShellPrompt } from "../agent-turn-command-prompt.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import type { CronStoredJob } from "../types.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

/** Rejects deterministic command prompts whose stored cap cannot execute them. */
export function resolveCronCommandPromptPreflight(
  job: CronStoredJob,
): RunCronAgentTurnResult | undefined {
  if (
    job.payload.kind !== "agentTurn" ||
    classifyCronAgentTurnShellPrompt(job.payload) !== "commandPromptWithoutShellAccess"
  ) {
    return undefined;
  }
  const error =
    `Automation ${job.id} cannot run its requested command because the agent prompt contains ` +
    'a "Command to run:" block but toolsAllow does not grant shell/process access. ' +
    `No command was executed. Recreate it as a command automation with ` +
    '`openclaw automations add ... --command "<shell>"`, or explicitly reauthorize this job ' +
    `from a trusted operator shell with ` +
    `\`openclaw automations edit ${job.id} --tools exec,process\`.`;
  return {
    status: "error",
    error,
    diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error),
  };
}
