import { formatCliCommand } from "../cli/command-format.js";
import {
  type ConfigFileSnapshot,
  type OpenClawConfig,
  readConfigFileSnapshot,
} from "../config/config.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import {
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";

export async function requireValidConfigFileSnapshot(
  runtime: RuntimeEnv,
  opts?: { includeCompatibilityAdvisory?: boolean },
): Promise<ConfigFileSnapshot | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? formatConfigIssueLines(snapshot.issues, "-").join("\n")
        : "Unknown validation issue.";
    runtime.error(`Config invalid:\n${issues}`);
    runtime.error(`Fix the config or run ${formatCliCommand("openclaw doctor")}.`);
    runtime.exit(1);
    return null;
  }
  if (opts?.includeCompatibilityAdvisory !== true) {
    return snapshot;
  }
  const compatibility = buildPluginCompatibilitySnapshotNotices({ config: snapshot.config });
  if (compatibility.length > 0) {
    runtime.log(
      [
        `Plugin compatibility: ${compatibility.length} notice${compatibility.length === 1 ? "" : "s"}.`,
        ...compatibility
          .slice(0, 3)
          .map((notice) => `- ${formatPluginCompatibilityNotice(notice)}`),
        ...(compatibility.length > 3 ? [`- ... +${compatibility.length - 3} more`] : []),
        `Review: ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
    );
  }
  return snapshot;
}

export async function requireValidConfigSnapshot(
  runtime: RuntimeEnv,
  opts?: { includeCompatibilityAdvisory?: boolean },
): Promise<OpenClawConfig | null> {
  return (await requireValidConfigFileSnapshot(runtime, opts))?.config ?? null;
}
