import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveFutureConfigActionBlock } from "../../config/future-version-guard.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../../config/recovery-policy.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "../config-recovery-hints.js";

type ConfigActionPreflightFailure = {
  message: string;
  hints?: string[];
};

function formatPluginPackagingRuntimeOutputRecoveryHints(): string[] {
  return formatPluginPackagingRuntimeOutputRecoveryHint().split("\n");
}

/** Best-effort validation before a service action mutates runtime state. */
export async function getConfigActionPreflightFailure(
  action: string,
): Promise<ConfigActionPreflightFailure | null> {
  let snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  try {
    snapshot = await readConfigFileSnapshot();
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

  const futureBlock = resolveFutureConfigActionBlock({ action, snapshot });
  return futureBlock
    ? {
        message: futureBlock.message,
        hints: futureBlock.hints,
      }
    : null;
}
