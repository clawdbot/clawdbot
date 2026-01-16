import type { Command } from "commander";

import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { DEFAULT_CHAT_CHANNEL } from "../channels/registry.js";
import { loadConfig } from "../config/config.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

function parseLimit(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    return Math.floor(value);
  }
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function formatEntry(entry: { kind: string; id: string; name?: string | undefined }): string {
  const name = entry.name?.trim();
  return name ? `${entry.id}\t${name}` : entry.id;
}

export function registerDirectoryCli(program: Command) {
  const directory = program
    .command("directory")
    .description("Directory lookups (self, peers, groups) for channels that support it")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/directory",
          "docs.clawd.bot/cli/directory",
        )}\n`,
    )
    .action(() => {
      directory.help({ error: true });
    });

  const withChannel = (cmd: Command) =>
    cmd
      .option("--channel <name>", "Channel (default: whatsapp)")
      .option("--account <id>", "Account id (accountId)")
      .option("--json", "Output JSON", false);

  const resolve = (opts: { channel?: string; account?: string }) => {
    const cfg = loadConfig();
    const channelInput = opts.channel ?? DEFAULT_CHAT_CHANNEL;
    const channelId = normalizeChannelId(channelInput);
    if (!channelId) {
      throw new Error(`Unsupported channel: ${channelInput}`);
    }
    const plugin = getChannelPlugin(channelId);
    if (!plugin?.directory) {
      throw new Error(`Channel ${channelId} does not support directory`);
    }
    const accountId = opts.account?.trim() || resolveChannelDefaultAccountId({ plugin, cfg });
    return { cfg, channelId, accountId, plugin };
  };

  withChannel(directory.command("self").description("Show the current account user")).action(
    async (opts) => {
      try {
        const { cfg, channelId, accountId, plugin } = resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        const fn = plugin.directory?.self;
        if (!fn) throw new Error(`Channel ${channelId} does not support directory self`);
        const result = await fn({ cfg, accountId, runtime: defaultRuntime });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result) {
          defaultRuntime.log("not available");
          return;
        }
        defaultRuntime.log(formatEntry(result));
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
        const { cfg, channelId, accountId, plugin } = resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        const fn = plugin.directory?.listPeers;
        if (!fn) throw new Error(`Channel ${channelId} does not support directory peers`);
        const result = await fn({
          cfg,
          accountId,
          query: (opts.query as string | undefined) ?? null,
          limit: parseLimit(opts.limit),
          runtime: defaultRuntime,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        for (const entry of result) {
          defaultRuntime.log(formatEntry(entry));
        }
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
        const { cfg, channelId, accountId, plugin } = resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        const fn = plugin.directory?.listGroups;
        if (!fn) throw new Error(`Channel ${channelId} does not support directory groups`);
        const result = await fn({
          cfg,
          accountId,
          query: (opts.query as string | undefined) ?? null,
          limit: parseLimit(opts.limit),
          runtime: defaultRuntime,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        for (const entry of result) {
          defaultRuntime.log(formatEntry(entry));
        }
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
        const { cfg, channelId, accountId, plugin } = resolve({
          channel: opts.channel as string | undefined,
          account: opts.account as string | undefined,
        });
        const fn = plugin.directory?.listGroupMembers;
        if (!fn) throw new Error(`Channel ${channelId} does not support group members listing`);
        const groupId = String(opts.groupId ?? "").trim();
        if (!groupId) throw new Error("Missing --group-id");
        const result = await fn({
          cfg,
          accountId,
          groupId,
          limit: parseLimit(opts.limit),
          runtime: defaultRuntime,
        });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        for (const entry of result) {
          defaultRuntime.log(formatEntry(entry));
        }
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
