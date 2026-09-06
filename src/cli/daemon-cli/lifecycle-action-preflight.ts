import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { renderConfigValidationIssueLines } from "../../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../../config/recovery-policy.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "../config-recovery-hints.js";

/** Service lifecycle actions; only start/restart bring the gateway up. */
type DaemonServiceAction = "start" | "restart" | "stop" | "uninstall";

type ServiceActionPreflightFailure = {
  message: string;
  hints?: string[];
};

const ACTION_PROSE: Record<DaemonServiceAction, string> = {
  start: "start the gateway service",
  restart: "restart the gateway service",
  stop: "stop the gateway service",
  uninstall: "uninstall the gateway service",
};

function formatPluginPackagingRuntimeOutputRecoveryHints(): string[] {
  return formatPluginPackagingRuntimeOutputRecoveryHint().split("\n");
}

/** Best-effort validation before a service action mutates runtime state. */
export async function getServiceActionPreflightFailure(
  action: DaemonServiceAction,
): Promise<ServiceActionPreflightFailure | null> {
  let snapshot: ConfigFileSnapshot;
  try {
    snapshot = await readConfigFileSnapshot({ observe: false });
    if (snapshot.exists && !snapshot.valid) {
      const message =
        snapshot.issues.length > 0
          ? renderConfigValidationIssueLines(snapshot, "").join("\n")
          : "Unknown validation issue.";
      return {
        message,
        ...(isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
          ? { hints: formatPluginPackagingRuntimeOutputRecoveryHints() }
          : {}),
      };
    }
  } catch {
    return null;
  }

  const futureBlock = resolveFutureConfigActionBlock({ action: ACTION_PROSE[action], snapshot });
  if (futureBlock) {
    return { message: futureBlock.message, hints: futureBlock.hints };
  }
  return null;
}
