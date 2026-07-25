// macOS LaunchAgent recovery helper for daemon lifecycle commands.
import {
  formatLaunchAgentGuiSessionError,
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
} from "../../daemon/launchd.js";

const LAUNCH_AGENT_RECOVERY_MESSAGE =
  "Gateway LaunchAgent was installed but not loaded; re-bootstrapped launchd service.";

type LaunchAgentRecoveryAction = "started" | "restarted";

type LaunchAgentRecoveryResult<TResult extends LaunchAgentRecoveryAction> = {
  result: TResult;
  loaded: true;
  message: string;
};

/** Re-bootstrap an installed but unloaded LaunchAgent after a daemon start/restart command. */
export async function recoverInstalledLaunchAgent<
  TResult extends LaunchAgentRecoveryAction,
>(params: {
  result: TResult;
  env?: Record<string, string | undefined>;
}): Promise<LaunchAgentRecoveryResult<TResult> | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const plistExists = await launchAgentPlistExists(env).catch(() => false);
  if (!plistExists) {
    return null;
  }
  const repaired = await repairLaunchAgentBootstrap({ env }).catch(() => ({
    ok: false as const,
    status: "bootstrap-failed" as const,
  }));
  if (!repaired.ok) {
    if (repaired.status === "gui-session-unavailable") {
      const actionHint =
        params.result === "started" ? "openclaw gateway start" : "openclaw gateway restart";
      throw new Error(
        formatLaunchAgentGuiSessionError({
          detail: repaired.detail,
          domain: repaired.domain,
          actionHint,
        }),
      );
    }
    return null;
  }
  return {
    result: params.result,
    loaded: true,
    message: LAUNCH_AGENT_RECOVERY_MESSAGE,
  };
}
