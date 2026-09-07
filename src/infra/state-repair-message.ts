import { formatCliCommand } from "../cli/command-format.js";

/** Runtime callers request migration; Doctor reports the manual recovery that remains. */
export function formatStateRepairRequired(
  problem: string,
  recovery: string,
  operation?: "doctor",
  env: NodeJS.ProcessEnv = process.env,
): string {
  return operation === "doctor"
    ? `Doctor cannot repair this state: ${problem}. ${recovery}`
    : `${problem}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before using OpenClaw.`;
}
