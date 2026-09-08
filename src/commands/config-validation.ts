// Config validation helpers shared by commands that need fail-fast config loading.
import { formatCliCommand } from "../cli/command-format.js";
import { formatPluginPackagingRuntimeOutputRecoveryHint } from "../cli/config-recovery-hints.js";
import {
  type ConfigFileSnapshot,
  type OpenClawConfig,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
} from "../config/config.js";
import { renderConfigValidationIssueLines } from "../config/issue-location.js";
import { isPluginPackagingRuntimeOutputInvalidConfigSnapshot } from "../config/recovery-policy.js";
import {
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice,
} from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";

type ConfigValidationOptions = {
  includeCompatibilityAdvisory?: boolean;
  observe?: boolean;
  skipPluginValidation?: boolean;
  adoptPluginMetadata?: boolean;
};

/** Read the config file and exit through the runtime when validation fails. */
export async function requireValidConfigFileSnapshot(
  runtime: RuntimeEnv,
  opts?: ConfigValidationOptions,
): Promise<ConfigFileSnapshot | null> {
  const readOptions = {
    ...(opts?.observe === false ? { observe: false } : {}),
    ...(opts?.skipPluginValidation ? { skipPluginValidation: true } : {}),
  };
  const snapshot = opts?.adoptPluginMetadata
    ? (
        await (
          await import("../cli/command-config-snapshot.js")
        ).readCommandConfigSnapshot(readOptions)
      ).snapshot
    : await readConfigFileSnapshot(Object.keys(readOptions).length > 0 ? readOptions : undefined);
  return validateConfigFileSnapshot(snapshot, runtime, opts?.includeCompatibilityAdvisory);
}

/** Preserve native read-time ownership through commands that can write after awaits. */
export async function requireValidConfigForWrite(runtime: RuntimeEnv) {
  const read = await readConfigFileSnapshotForWrite();
  return validateConfigFileSnapshot(read.snapshot, runtime) ? read : null;
}

function validateConfigFileSnapshot(
  snapshot: ConfigFileSnapshot,
  runtime: RuntimeEnv,
  includeCompatibilityAdvisory = false,
): ConfigFileSnapshot | null {
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? renderConfigValidationIssueLines(snapshot).join("\n")
        : "Unknown validation issue.";
    runtime.error(`OpenClaw config is invalid: ${snapshot.path}\n${issues}`);
    runtime.error(
      isPluginPackagingRuntimeOutputInvalidConfigSnapshot(snapshot)
        ? `Fix: ${formatPluginPackagingRuntimeOutputRecoveryHint()}`
        : `Fix: ${formatCliCommand("openclaw doctor --fix")}`,
    );
    runtime.error(`Inspect: ${formatCliCommand("openclaw config validate")}`);
    runtime.exit(1);
    return null;
  }
  if (!includeCompatibilityAdvisory) {
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

/** Read and return a valid OpenClaw config, or null after reporting validation errors. */
export async function requireValidConfig(
  runtime: RuntimeEnv,
  opts?: ConfigValidationOptions,
): Promise<OpenClawConfig | null> {
  return (await requireValidConfigFileSnapshot(runtime, opts))?.config ?? null;
}
