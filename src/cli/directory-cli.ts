import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Directory CLI for chat-channel identity lookup: self, peers, groups, and group members.
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  getTerminalTableWidth,
  renderTerminalSafeTable,
} from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { nullChannelDirectorySelf } from "../channels/plugins/directory-adapters.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { requireValidConfigFileSnapshot } from "../commands/config-validation.js";
import { getRuntimeConfig, replaceConfigFile } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCommandConfigWithSecrets } from "./command-config-resolution.js";
import { getScopedChannelsCommandSecretTargets } from "./command-secret-targets.js";
import { formatHelpExamples } from "./help-format.js";

function parseLimit(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
}

function buildRows(entries: Array<{ id: string; name?: string | undefined }>) {
  return entries.map((entry) => ({
    ID: entry.id,
    Name: normalizeOptionalString(entry.name) ?? "",
  }));
}

function formatDirectoryScope(channelId: string, accountId: string): string {
  const channel = JSON.stringify(sanitizeTerminalText(channelId));
  const account = JSON.stringify(sanitizeTerminalText(accountId));
  return `channel ${channel}, account ${account}`;
}

function printDirectoryList(params: {
  title: string;
  emptyMessage: string;
  entries: Array<{ id: string; name?: string | undefined }>;
}): void {
  if (params.entries.length === 0) {
    defaultRuntime.log(theme.muted(params.emptyMessage));
    return;
  }

  const tableWidth = getTerminalTableWidth();
  defaultRuntime.log(`${theme.heading(params.title)} ${theme.muted(`(${params.entries.length})`)}`);
  defaultRuntime.log(
    renderTerminalSafeTable({
      width: tableWidth,
      columns: [
        { key: "ID", header: "ID", minWidth: 16, flex: true },
        { key: "Name", header: "Name", minWidth: 18, flex: true },
      ],
      rows: buildRows(params.entries),
    }).trimEnd(),
  );
}

/** Register directory lookup commands and shared channel/account resolution. */
export function registerDirectoryCli(program: Command) {
  const directory = program
    .command("directory")
    .description("Lookup contact and group IDs (self, peers, groups) for supported chat channels")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw directory self --channel slack", "Show the connected account identity."],
          [
            'openclaw directory peers list --channel slack --query "alice"',
            "Search contact/user IDs by name.",
          ],
          ["openclaw directory groups list --channel discord", "List available groups/channels."],
          [
            "openclaw directory groups members --channel discord --group-id <id>",
            "List members for a specific group.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/directory",
          "docs.openclaw.ai/cli/directory",
        )}\n`,
    )
    .action(() => {
      directory.help({ error: true });
    });

  const withChannel = (cmd: Command) =>
    cmd
      .option("--channel <name>", "Channel (auto when only one is configured)")
      .option("--account <id>", "Account id (accountId)")
      .option("--json", "Output JSON", false);

  const resolve = async (opts: { channel?: string; account?: string }) => {
    const sourceSnapshot = await requireValidConfigFileSnapshot(defaultRuntime);
    if (!sourceSnapshot) {
      return null;
    }
    const autoEnabled = applyPluginAutoEnable({
      config: sourceSnapshot.sourceConfig,
      env: process.env,
    });
    const sourceConfig = autoEnabled.config;
    const explicitChannel = opts.channel?.trim();
    const resolvedExplicit = explicitChannel
      ? await resolveInstallableChannelPlugin({
          cfg: sourceConfig,
          runtime: defaultRuntime,
          rawChannel: explicitChannel,
          allowInstall: true,
          preferRegisteredPlugin: true,
          supports: (plugin) => Boolean(plugin.directory),
        })
      : null;
    if (resolvedExplicit?.configChanged) {
      // Installing an explicit channel can update plugin records; commit before directory calls
      // so subsequent registry reads see the channel the user just selected.
      await commitConfigWithPendingPluginInstalls({
        nextConfig: resolvedExplicit.cfg,
        baseHash: sourceSnapshot.hash,
      });
    } else if (autoEnabled.changes.length > 0) {
      // Auto-enable changes are config-only and must be persisted before later CLI invocations.
      await replaceConfigFile({
        nextConfig: sourceConfig,
        baseHash: sourceSnapshot.hash,
      });
    }
    // Config writes refresh the active runtime snapshot. Directory execution must use that
    // prepared view, never the authored config that was just persisted.
    const runtimeConfig = getRuntimeConfig();
    const selection = explicitChannel
      ? {
          channel: resolvedExplicit?.channelId,
          plugin: resolvedExplicit?.plugin,
        }
      : await resolveMessageChannelSelection({
          cfg: runtimeConfig,
          channel: opts.channel ?? null,
          accountResolution: "read_only",
        });
    const selectedChannelId = selection.channel;
    const plugin = selection.plugin;
    if (!plugin) {
      throw new Error(`Unsupported channel: ${String(selectedChannelId)}`);
    }
    const channelId = selectedChannelId ?? plugin.id;
    const accountId =
      normalizeOptionalString(opts.account) ||
      resolveChannelDefaultAccountId({ plugin, cfg: runtimeConfig });
    const secretTargets = getScopedChannelsCommandSecretTargets({
      config: runtimeConfig,
      channel: channelId,
      accountId,
    });
    const { effectiveConfig } = await resolveCommandConfigWithSecrets({
      config: runtimeConfig,
      commandName: "directory",
      targetIds: secretTargets.targetIds,
      ...(secretTargets.allowedPaths ? { allowedPaths: secretTargets.allowedPaths } : {}),
      mode: "read_only_operational",
      runtime: defaultRuntime,
    });
    return { cfg: effectiveConfig, channelId, accountId, plugin };
  };

  const runDirectoryList = async (params: {
    opts: {
      channel?: unknown;
      account?: unknown;
      query?: unknown;
      limit?: unknown;
      json?: unknown;
    };
    action: "listPeers" | "listGroups";
    unsupported: string;
    title: string;
    emptyMessage: string;
  }) => {
    const limit = parseLimit(params.opts.limit);
    const resolved = await resolve({
      channel: params.opts.channel as string | undefined,
      account: params.opts.account as string | undefined,
    });
    if (!resolved) {
      return;
    }
    const { cfg, channelId, accountId, plugin } = resolved;
    const fn =
      params.action === "listPeers"
        ? (plugin.directory?.listPeersLive ?? plugin.directory?.listPeers)
        : (plugin.directory?.listGroupsLive ?? plugin.directory?.listGroups);
    if (!fn) {
      throw new Error(`Channel ${channelId} does not support directory ${params.unsupported}`);
    }
    const result = await fn({
      cfg,
      accountId,
      query: (params.opts.query as string | undefined) ?? null,
      limit,
      runtime: defaultRuntime,
    });
    if (params.opts.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    printDirectoryList({
      title: params.title,
      emptyMessage: `${params.emptyMessage} for ${formatDirectoryScope(channelId, accountId)}.`,
      entries: result,
    });
  };

  const runDirectoryAction = async (opts: { json?: unknown }, action: () => Promise<void>) => {
    try {
      await action();
    } catch (err) {
      if (opts.json) {
        throw err;
      }
      defaultRuntime.error(danger(formatErrorMessage(err)));
      defaultRuntime.exit(1);
    }
  };

  withChannel(directory.command("self").description("Show the current account user")).action(
    (opts) =>
      runDirectoryAction(opts, async () => {
        const resolved = await resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        if (!resolved) {
          return;
        }
        const { cfg, channelId, accountId, plugin } = resolved;
        const fn = plugin.directory?.self;
        if (!fn) {
          throw new Error(`Channel ${channelId} does not support directory self`);
        }
        const result = await fn({ cfg, accountId, runtime: defaultRuntime });
        if (!result) {
          const unsupported = fn === nullChannelDirectorySelf;
          if (opts.json) {
            defaultRuntime.writeJson({
              status: "unavailable",
              channel: channelId,
              accountId,
              reason: unsupported
                ? "self-identity-unsupported"
                : "plugin-returned-no-self-identity",
            });
          } else {
            defaultRuntime.log(
              theme.muted(
                unsupported
                  ? `Channel ${JSON.stringify(sanitizeTerminalText(channelId))} does not expose a self identity.`
                  : `No self identity was returned for ${formatDirectoryScope(channelId, accountId)}. Verify the account is configured and authenticated, then retry.`,
              ),
            );
          }
          return;
        }
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(theme.heading("Self"));
        defaultRuntime.log(
          renderTerminalSafeTable({
            width: tableWidth,
            columns: [
              { key: "ID", header: "ID", minWidth: 16, flex: true },
              { key: "Name", header: "Name", minWidth: 18, flex: true },
            ],
            rows: buildRows([result]),
          }).trimEnd(),
        );
      }),
  );

  const peers = directory.command("peers").description("Peer directory (contacts/users)");
  withChannel(peers.command("list").description("List peers"))
    .option("--query <text>", "Optional search query")
    .option("--limit <n>", "Limit results")
    .action((opts) =>
      runDirectoryAction(opts, async () => {
        await runDirectoryList({
          opts,
          action: "listPeers",
          unsupported: "peers",
          title: "Peers",
          emptyMessage: "No peers found",
        });
      }),
    );

  const groups = directory.command("groups").description("Group directory");
  withChannel(groups.command("list").description("List groups"))
    .option("--query <text>", "Optional search query")
    .option("--limit <n>", "Limit results")
    .action((opts) =>
      runDirectoryAction(opts, async () => {
        await runDirectoryList({
          opts,
          action: "listGroups",
          unsupported: "groups",
          title: "Groups",
          emptyMessage: "No groups found",
        });
      }),
    );

  withChannel(
    groups
      .command("members")
      .description("List group members")
      .requiredOption("--group-id <id>", "Group id"),
  )
    .option("--limit <n>", "Limit results")
    .action((opts) =>
      runDirectoryAction(opts, async () => {
        const limit = parseLimit(opts.limit);
        const resolved = await resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        if (!resolved) {
          return;
        }
        const { cfg, channelId, accountId, plugin } = resolved;
        const fn = plugin.directory?.listGroupMembers;
        if (!fn) {
          throw new Error(`Channel ${channelId} does not support group members listing`);
        }
        const groupId = normalizeStringifiedOptionalString(opts.groupId) ?? "";
        if (!groupId) {
          throw new Error("Missing --group-id");
        }
        const result = await fn({
          cfg,
          accountId,
          groupId,
          limit,
          runtime: defaultRuntime,
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        printDirectoryList({
          title: "Group Members",
          emptyMessage: `No group members found for group ${JSON.stringify(sanitizeTerminalText(groupId))}, ${formatDirectoryScope(channelId, accountId)}.`,
          entries: result,
        });
      }),
    );
}
