// `openclaw update status`: combines install metadata, configured channel, and remote update checks.
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  resolveStatusRegistryUpdateChannel,
  resolveUpdateAvailability,
} from "../../commands/status.update.js";
import { readSourceConfigBestEffort } from "../../config/config.js";
import {
  normalizeUpdateChannel,
  resolveUpdateChannelDisplay,
} from "../../infra/update-channels.js";
import { checkUpdateStatus, formatGitInstallLabel } from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { parseTimeoutMsOrExit, resolveUpdateRoot, type UpdateStatusOptions } from "./shared.js";

/** Print update status in JSON or table form for scripts and humans. */
export async function updateStatusCommand(opts: UpdateStatusOptions): Promise<void> {
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }

  const [root, config] = await Promise.all([resolveUpdateRoot(), readSourceConfigBestEffort()]);
  const configChannel = normalizeUpdateChannel(config.update?.channel);

  const update = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: true,
    useDetachedDevUpstream: configChannel === "dev",
    includeRegistry: true,
    resolveRegistryChannel: ({ installKind, git }) =>
      resolveStatusRegistryUpdateChannel({
        configChannel,
        installKind,
        git,
      }),
  });

  const channelInfo = resolveUpdateChannelDisplay({
    configChannel,
    currentVersion: VERSION,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });
  const channelLabel = channelInfo.label;

  const updateAvailability = resolveUpdateAvailability(update);

  if (opts.json) {
    defaultRuntime.writeJson({
      update,
      channel: {
        value: channelInfo.channel,
        source: channelInfo.source,
        label: channelLabel,
        config: configChannel,
      },
      availability: updateAvailability,
    });
    return;
  }

  const gitLabel = formatGitInstallLabel(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
  const tableWidth = getTerminalTableWidth();
  const installLabel =
    update.installKind === "git"
      ? `git (${update.root ?? "unknown"})`
      : update.installKind === "package"
        ? update.packageManager
        : "unknown";

  const rows = [
    { Item: "Install", Value: installLabel },
    { Item: "Channel", Value: channelLabel },
    ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
    {
      Item: "Update",
      Value: updateAvailability.available ? theme.warn(`available · ${updateLine}`) : updateLine,
    },
  ];

  defaultRuntime.log(theme.heading("OpenClaw update status"));
  defaultRuntime.log("");
  defaultRuntime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 10 },
        { key: "Value", header: "Value", flex: true, minWidth: 24 },
      ],
      rows,
    }).trimEnd(),
  );
  defaultRuntime.log("");

  const updateHint = formatUpdateAvailableHint(update);
  if (updateHint) {
    defaultRuntime.log(theme.warn(updateHint));
  }
}
