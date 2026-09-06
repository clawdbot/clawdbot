// Preview and confirm the shared plugin package lifecycle operation.
import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import {
  planManagedPluginUninstall,
  uninstallManagedPlugin,
} from "../plugins/management-mutations.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { shortenHomeInString } from "../utils.js";
import { resolvePluginLifecycleGateway } from "./plugins-lifecycle-client.js";
import { PromptInputClosedError, promptYesNo } from "./prompt.js";

type PluginUninstallOptions = {
  keepFiles?: boolean;
  /** @deprecated Use keepFiles. */
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
  invalidateRuntimeCache?: boolean;
  /** True when a Claw lifecycle caller already owns the package lease. */
  clawManaged?: boolean;
};

export async function runPluginUninstallCommand(
  id: string,
  opts: PluginUninstallOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (!opts.dryRun) {
    assertConfigWriteAllowedInCurrentMode();
  }
  const keepFiles = Boolean(opts.keepFiles || opts.keepConfig);
  if (opts.keepConfig) {
    runtime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
  }
  const plan = await planManagedPluginUninstall({ pluginId: id, keepFiles });
  const packageRemoval = plan.pluginIds.length > 1 || plan.requestedPluginId !== plan.pluginId;
  runtime.log(
    `Plugin: ${theme.command(plan.name)}${plan.name !== plan.pluginId ? theme.muted(` (${plan.pluginId})`) : ""}`,
  );
  if (packageRemoval) {
    runtime.log(
      `Package owner: ${theme.command(plan.pluginId)}; all entries will be removed: ${plan.pluginIds.join(", ")}`,
    );
  }
  runtime.log(
    `Will remove: ${plan.preview.length > 0 ? plan.preview.map((value) => shortenHomeInString(value)).join(", ") : "(nothing)"}`,
  );
  for (const warning of plan.warnings) {
    runtime.log(theme.warn(warning));
  }
  if (opts.dryRun) {
    runtime.log(theme.muted("Dry run, no changes made."));
    return;
  }
  if (!opts.force) {
    let confirmed: boolean;
    try {
      confirmed = await promptYesNo(
        packageRemoval
          ? `Uninstall plugin package "${plan.pluginId}" and all entries?`
          : `Uninstall plugin "${plan.pluginId}"?`,
      );
    } catch (error) {
      if (!(error instanceof PromptInputClosedError)) {
        throw error;
      }
      runtime.error(
        "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
      );
      return runtime.exit(1);
    }
    if (!confirmed) {
      runtime.log("Cancelled.");
      return;
    }
  }
  const gateway = await resolvePluginLifecycleGateway();
  const result = gateway
    ? await gateway<Awaited<ReturnType<typeof uninstallManagedPlugin>>>("plugins.uninstall", {
        pluginId: plan.pluginId,
        keepFiles,
        ...(opts.clawManaged ? { clawManaged: true } : {}),
      })
    : await uninstallManagedPlugin({ ...opts, pluginId: plan.pluginId, keepFiles });
  for (const warning of result.warnings ?? []) {
    if (!plan.warnings.includes(warning)) {
      runtime.log(theme.warn(warning));
    }
  }
  const subject = packageRemoval
    ? `plugin package "${result.pluginId}" and entries ${plan.pluginIds.join(", ")}`
    : `plugin "${result.pluginId}"`;
  runtime.log(
    `Uninstalled ${subject}. Removed: ${result.removed.length > 0 ? result.removed.join(", ") : "nothing"}.`,
  );
  if (!gateway) {
    runtime.log("Saved for the next Gateway start.");
  }
}
