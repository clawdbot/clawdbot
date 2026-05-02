import type { Command } from "commander";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { resolveInstallableChannelPlugin } from "../commands/channel-setup/channel-plugin-resolution.js";
import { getRuntimeConfig, readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { danger } from "../globals.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatHelpExamples } from "./help-format.js";
import { commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit.js";

function parseLimit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return null;
    }
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = normalizeOptionalString(value) ?? "";
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function buildRows(entries: Array<{ id: string; name?: string | undefined }>) {
  return entries.map((entry) => ({
    ID: entry.id,
    Name: normalizeOptionalString(entry.name) ?? "",
  }));
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
    renderTable({
      width: tableWidth,
      columns: [
        { key: "ID", header: "ID", minWidth: 16, flex: true },
        { key: "Name", header: "Name", minWidth: 18, flex: true },
      ],
      rows: buildRows(params.entries),
    }).trimEnd(),
  );
}

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
    const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
    const autoEnabled = applyPluginAutoEnable({
      config: getRuntimeConfig(),
      env: process.env,
    });
    let cfg = autoEnabled.config;
    const explicitChannel = opts.channel?.trim();
    const resolvedExplicit = explicitChannel
      ? await resolveInstallableChannelPlugin({
          cfg,
          runtime: defaultRuntime,
          rawChannel: explicitChannel,
          allowInstall: true,
          supports: (plugin) => Boolean(plugin.directory),
        })
      : null;
    if (resolvedExplicit?.configChanged) {
      cfg = resolvedExplicit.cfg;
      const committed = await commitConfigWithPendingPluginInstalls({
        nextConfig: cfg,
        baseHash: (await sourceSnapshotPromise)?.hash,
      });
      cfg = committed.config;
    } else if (autoEnabled.changes.length > 0) {
      await replaceConfigFile({
        nextConfig: cfg,
        baseHash: (await sourceSnapshotPromise)?.hash,
      });
    }
    const selection = explicitChannel
      ? {
          channel: resolvedExplicit?.channelId,
        }
      : await resolveMessageChannelSelection({
          cfg,
          channel: opts.channel ?? null,
        });
    const channelId = selection.channel;
    const plugin =
      resolvedExplicit?.plugin ?? (channelId ? getChannelPlugin(channelId) : undefined);
    if (!plugin) {
      throw new Error(`Unsupported channel: ${String(channelId)}`);
    }
    const accountId =
      normalizeOptionalString(opts.account) || resolveChannelDefaultAccountId({ plugin, cfg });
    return { cfg, channelId, accountId, plugin };
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
    const { cfg, channelId, accountId, plugin } = await resolve({
      channel: params.opts.channel as string | undefined,
      account: params.opts.account as string | undefined,
    });
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
      limit: parseLimit(params.opts.limit),
      runtime: defaultRuntime,
    });
    if (params.opts.json) {
      defaultRuntime.writeJson(result);
      return;
    }
    printDirectoryList({ title: params.title, emptyMessage: params.emptyMessage, entries: result });
  };

  withChannel(directory.command("self").description("Show the current account user")).action(
    async (opts) => {
      try {
        const { cfg, channelId, accountId, plugin } = await resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        const fn = plugin.directory?.self;
        if (!fn) {
          throw new Error(`Channel ${channelId} does not support directory self`);
        }
        const result = await fn({ cfg, accountId, runtime: defaultRuntime });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        if (!result) {
          defaultRuntime.log(theme.muted("Not available."));
          return;
        }
        const tableWidth = getTerminalTableWidth();
        defaultRuntime.log(theme.heading("Self"));
        defaultRuntime.log(
          renderTable({
            width: tableWidth,
            columns: [
              { key: "ID", header: "ID", minWidth: 16, flex: true },
              { key: "Name", header: "Name", minWidth: 18, flex: true },
            ],
            rows: buildRows([result]),
          }).trimEnd(),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    },
  );

  const peers = directory.command("peers").description("Peer directory (contacts/users)");
  withChannel(peers.command("list").description("List peers"))
    .option("--query <text>", "Optional search query")
    .option("--limit <n>", "Limit results")
    .action(async (opts) => {
      try {
        await runDirectoryList({
          opts,
          action: "listPeers",
          unsupported: "peers",
          title: "Peers",
          emptyMessage: "No peers found.",
        });
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  const groups = directory.command("groups").description("Group directory");
  withChannel(groups.command("list").description("List groups"))
    .option("--query <text>", "Optional search query")
    .option("--limit <n>", "Limit results")
    .action(async (opts) => {
      try {
        await runDirectoryList({
          opts,
          action: "listGroups",
          unsupported: "groups",
          title: "Groups",
          emptyMessage: "No groups found.",
        });
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  withChannel(
    groups
      .command("members")
      .description("List group members")
      .requiredOption("--group-id <id>", "Group id"),
  )
    .option("--limit <n>", "Limit results")
    .action(async (opts) => {
      try {
        const { cfg, channelId, accountId, plugin } = await resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
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
          limit: parseLimit(opts.limit),
          runtime: defaultRuntime,
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        printDirectoryList({
          title: "Group Members",
          emptyMessage: "No group members found.",
          entries: result,
        });
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
