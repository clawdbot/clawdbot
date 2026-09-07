// Terminal preview and confirmation for the shared plugin uninstall owner.
import { theme } from "../../packages/terminal-core/src/theme.js";
import { assertConfigWriteAllowedInCurrentMode } from "../config/config.js";
import type { PreparedPluginUninstall } from "../plugins/management-uninstall.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

type PluginUninstallOptions = {
  keepFiles?: boolean;
  /** @deprecated Use keepFiles. */
  keepConfig?: boolean;
  force?: boolean;
  dryRun?: boolean;
  invalidateRuntimeCache?: boolean;
  /** True when a Claw lifecycle caller already owns the package lease. */
  clawManaged?: boolean;
  /** Synchronous authority guard at each final plugin/config mutation. */
  beforePersistentApply?: () => void;
};

export async function runPluginUninstallCommand(
  id: string,
  opts: PluginUninstallOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (!opts.dryRun) {
    assertConfigWriteAllowedInCurrentMode();
  }
  const { preparePluginUninstall, uninstallPluginWithPolicy } =
    await import("../plugins/management-uninstall.js");
  const { formatUninstallActionLabels, resolveUninstallChannelConfigKeys } =
    await import("../plugins/uninstall.js");
  const { collectClawPluginUninstallWarnings } =
    await import("../plugins/uninstall-claw-references.js");
  const { PromptInputClosedError, promptYesNo } = await import("./prompt.js");
  const request = { pluginId: id, keepFiles: Boolean(opts.keepFiles || opts.keepConfig) };
  const warnKeepConfig = () => {
    if (opts.keepConfig) {
      runtime.log(theme.warn("`--keep-config` is deprecated, use `--keep-files`."));
    }
  };
  const printPreview = (preview: PreparedPluginUninstall) => {
    const channelConfigKeys =
      preview.plan.actions.channelConfig && Object.hasOwn(preview.installRecords, preview.pluginId)
        ? resolveUninstallChannelConfigKeys(preview.pluginId, {
            channelIds: preview.channelIds,
          }).filter((key) => Object.hasOwn(preview.snapshot.config.channels ?? {}, key))
        : [];
    const labels = formatUninstallActionLabels(preview.plan.actions, { channelConfigKeys });
    if (preview.plan.directoryRemoval) {
      labels.push(`directory: ${shortenHomePath(preview.plan.directoryRemoval.target)}`);
    }
    runtime.log(
      `Plugin: ${theme.command(preview.name)}${preview.name !== preview.pluginId ? theme.muted(` (${preview.pluginId})`) : ""}`,
    );
    if (preview.pluginIds.length > 1 || preview.requestedPluginId !== preview.pluginId) {
      runtime.log(
        `Package owner: ${theme.command(preview.pluginId)}; all entries will be removed: ${preview.pluginIds.join(", ")}`,
      );
    }
    runtime.log(`Will remove: ${labels.length ? labels.join(", ") : "(nothing)"}`);
    for (const warning of collectClawPluginUninstallWarnings({
      pluginId: preview.pluginId,
      installRecord: preview.installRecords[preview.pluginId],
    })) {
      runtime.log(theme.warn(warning));
    }
  };
  const execute = async (skipPreview: boolean) => {
    warnKeepConfig();
    // Keep errors/output inside the plugin lease; the owner emits success inside any package lease.
    const result = await uninstallPluginWithPolicy({
      ...request,
      caller: "cli",
      clawManaged: opts.clawManaged,
      beforePersistentApply: opts.beforePersistentApply,
      invalidateRuntimeCache: opts.invalidateRuntimeCache,
      ...(skipPreview ? {} : { onPreview: printPreview }),
      onWarning: (message) => runtime.log(theme.warn(message)),
      onComplete: ({ pluginId, requestedPluginId, pluginIds, removed }) => {
        const subject =
          pluginIds.length > 1 || requestedPluginId !== pluginId
            ? `plugin package "${pluginId}" and entries ${pluginIds.join(", ")}`
            : `plugin "${pluginId}"`;
        runtime.log(
          `Uninstalled ${subject}. Removed: ${removed.length ? removed.join(", ") : "nothing"}.`,
        );
        runtime.log("Restart the gateway to apply changes.");
      },
    });
    if (!result.ok) {
      runtime.error(result.error);
      runtime.exit(1);
    }
  };
  if (opts.force && !opts.dryRun) {
    return await withPluginLifecycleLease({}, async () => await execute(false));
  }
  if (!opts.dryRun) {
    assertConfigWriteAllowedInCurrentMode();
  }
  const prepared = await preparePluginUninstall({ ...request, caller: "cli" });
  warnKeepConfig();
  if (!prepared.ok) {
    runtime.error(prepared.error);
    runtime.exit(1);
    return;
  }
  const preview = prepared.value;
  printPreview(preview);
  if (opts.dryRun) {
    runtime.log(theme.muted("Dry run, no changes made."));
    return;
  }
  let confirmed: boolean;
  try {
    confirmed = await promptYesNo(
      preview.pluginIds.length > 1
        ? `Uninstall plugin package "${preview.pluginId}" and all entries?`
        : `Uninstall plugin "${preview.pluginId}"?`,
    );
  } catch (error) {
    if (!(error instanceof PromptInputClosedError)) {
      throw error;
    }
    runtime.error(
      "Error: plugins uninstall requires confirmation input. Re-run in an interactive TTY or pass --force.",
    );
    runtime.exit(1);
    return;
  }
  if (!confirmed) {
    runtime.log("Cancelled.");
    return;
  }
  await withPluginLifecycleLease({}, async () => await execute(true));
}
