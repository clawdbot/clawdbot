import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveStateDir } from "../../config/paths.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";

type UnsafeUpdateRecovery = Extract<
  NonNullable<UpdateRunResult["recovery"]>,
  { serviceRestartSafe: false }
>;

export function resolveUnsafeUpdateRecoveryGuidance(
  reason?: UnsafeUpdateRecovery["reason"],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const triageCommand = formatCliCommand("openclaw triage", env);
  const guidance = `Run \`${triageCommand}\` on this machine to open a coding agent that can diagnose and repair the installation.`;
  if (reason === "state-migration-started") {
    return `${guidance} Candidate Doctor may have migrated state; keep the candidate installed and do not roll back code alone.`;
  }
  return guidance;
}

export function resolveUpdateResultNextAction(params: {
  result: UpdateRunResult;
  serviceRunning?: boolean;
  runningVersion?: string;
  verificationFailure?: string;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  const { result, env } = params;
  if (result.status === "error") {
    if (result.reason === "rollback-project-changed") {
      return `Other global packages changed after staging; automatic rollback was refused to preserve them. Keep the candidate installed if its gateway is reachable; otherwise keep the gateway stopped. ${resolveUnsafeUpdateRecoveryGuidance(undefined, env)}`;
    }
    const reason =
      result.recovery?.serviceRestartSafe === false ? result.recovery.reason : undefined;
    const failure = truncateUtf16Safe(
      params.verificationFailure ?? result.reason ?? reason ?? "",
      240,
    );
    const runningVersion = truncateUtf16Safe(params.runningVersion ?? "", 120);
    const state = reason
      ? params.serviceRunning === true
        ? `The gateway is running${runningVersion ? ` ${runningVersion}` : ""} but did not pass verification (${failure}). `
        : `${params.serviceRunning === false ? "Managed gateway remains stopped because update recovery" : "Update recovery"} could not prove a runnable installation (${failure}). ${params.serviceRunning === false ? "Keep the gateway stopped until the update succeeds. " : ""}`
      : "";
    return `${state}${resolveUnsafeUpdateRecoveryGuidance(reason, env)}`;
  }
  const command = (value: string) => replaceCliName(formatCliCommand(value, env), resolveCliName());
  if (result.reason === "dirty") {
    return `Git-based updates need a clean working tree before they can switch commits, fetch, or rebase. Commit, stash, or discard the local changes, then rerun \`${command("openclaw update")}\`.`;
  }
  if (result.reason === "not-git-install") {
    return `This OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${command("openclaw doctor")}\` and \`${command("openclaw gateway restart")}\`. Examples: \`${replaceCliName("npm i -g openclaw@latest", resolveCliName())}\` or \`${replaceCliName("pnpm add -g openclaw@latest", resolveCliName())}\`.`;
  }
  if (result.status === "ok") {
    return `After verifying your history, preview recovery rollback retirement with ${command("openclaw update cleanup --dry-run")} for state ${resolveStateDir(env)}. Keep the same state/config overrides.`;
  }
  return undefined;
}
