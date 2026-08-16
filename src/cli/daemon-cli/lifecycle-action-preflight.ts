import {
  AUTH_PROFILE_MIGRATION_COMMAND,
  listAuthProfileStoresRequiringMigration,
} from "../../agents/auth-profiles/legacy-source-diagnostic.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../../config/recovery-policy.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { collectCandidateAgentDirs } from "../../secrets/runtime-fast-path.js";
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

const GATEWAY_LAUNCHING_ACTIONS = new Set<DaemonServiceAction>(["start", "restart"]);

function formatPluginPackagingRuntimeOutputRecoveryHints(): string[] {
  return formatPluginPackagingRuntimeOutputRecoveryHint().split("\n");
}

/**
 * Retired credential files make the gateway throw AuthProfileMigrationRequiredError during boot.
 * Blocking here keeps the running service up instead of taking it down into a known-fatal state.
 * Only launching actions are gated; stop/uninstall never read the auth store.
 */
function resolveAuthProfileMigrationBlock(
  action: DaemonServiceAction,
  snapshot: ConfigFileSnapshot,
): ServiceActionPreflightFailure | null {
  if (!GATEWAY_LAUNCHING_ACTIONS.has(action) || !snapshot.valid) {
    return null;
  }
  let stores: string[];
  try {
    stores = listAuthProfileStoresRequiringMigration({
      agentDirs: collectCandidateAgentDirs(snapshot.runtimeConfig, process.env),
      env: process.env,
    });
  } catch {
    // A preflight must never be the reason a lifecycle command fails.
    return null;
  }
  if (stores.length === 0) {
    return null;
  }
  return {
    message:
      stores.length === 1
        ? `Auth profile store ${stores[0]} requires legacy credential migration.`
        : `Auth profile stores ${stores.join(", ")} require legacy credential migration.`,
    hints: [`Run \`${AUTH_PROFILE_MIGRATION_COMMAND}\`, then retry this command.`],
  };
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
          ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n")
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
  return resolveAuthProfileMigrationBlock(action, snapshot);
}
