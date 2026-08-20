// Implements channel-scoped tailing of the OpenClaw log file.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  CHAT_CHANNEL_ORDER,
  normalizeChatChannelId as normalizeBundledChannelId,
} from "../../channels/registry.js";
import { readConfiguredParsedLogTail } from "../../logging/log-tail.js";
import type { ParsedLogLine } from "../../logging/parse-log-line.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

type ChannelLogFilter = { channel: string; pluginIds: ReadonlySet<string> };
type ManifestChannel = { id: string; pluginId: string };

function listManifestChannels(): ManifestChannel[] {
  return loadPluginManifestRegistryForPluginRegistry({
    includeDisabled: true,
    env: process.env,
  }).plugins.flatMap((plugin) =>
    plugin.channels.flatMap((rawChannel) => {
      const id = normalizeLowercaseStringOrEmpty(rawChannel);
      return id ? [{ id, pluginId: plugin.id }] : [];
    }),
  );
}

function parseChannelFilter(raw?: string): ChannelLogFilter {
  if (raw === undefined) {
    return { channel: "all", pluginIds: new Set() };
  }
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (trimmed === "all") {
    return { channel: "all", pluginIds: new Set() };
  }
  const manifestChannels = listManifestChannels();
  const bundled = normalizeBundledChannelId(trimmed);
  const channel = bundled ?? trimmed;
  const pluginIds = new Set(
    manifestChannels.filter((entry) => entry.id === channel).map((entry) => entry.pluginId),
  );
  if (bundled || pluginIds.size > 0) {
    return { channel, pluginIds };
  }
  const manifestIds = [...new Set(manifestChannels.map((entry) => entry.id))].toSorted();
  const validChannels = ["all", ...new Set([...CHAT_CHANNEL_ORDER, ...manifestIds])];
  throw new Error(
    `Unknown channel ${JSON.stringify(raw)}. Valid channels: ${validChannels.join(", ")}`,
  );
}

function matchesChannelContext(value: string | undefined, channel: string) {
  const path = `gateway/channels/${channel}`;
  return value === channel || value === path || value?.startsWith(`${path}/`) === true;
}

function matchesChannel(
  line: Pick<ParsedLogLine, "subsystem" | "module" | "plugin">,
  filter: ChannelLogFilter,
) {
  const { channel } = filter;
  if (channel === "all") {
    return true;
  }
  return (
    matchesChannelContext(line.subsystem, channel) ||
    matchesChannelContext(line.module, channel) ||
    (line.plugin !== undefined && filter.pluginIds.has(line.plugin))
  );
}

function parseLinesOption(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LIMIT;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error("--lines must be a positive integer.");
  }
  return parsed;
}

/** Print or serialize recent log lines matching one channel subsystem/module. */
export async function channelsLogsCommand(
  opts: ChannelsLogsOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const filter = parseChannelFilter(opts.channel);
  const { channel } = filter;
  const limit = parseLinesOption(opts.lines);

  const tail = await readConfiguredParsedLogTail({
    limit,
    maxBytes: MAX_BYTES,
    filter: (line) => matchesChannel(line, filter),
  });
  const lines = tail.lines;

  if (opts.json) {
    writeRuntimeJson(runtime, { file: tail.file, channel, lines });
    return;
  }

  runtime.log(theme.info(`Log file: ${tail.file}`));
  if (channel !== "all") {
    runtime.log(theme.info(`Channel: ${channel}`));
  }
  if (lines.length === 0) {
    runtime.log(theme.muted("No matching log lines."));
    return;
  }
  for (const line of lines) {
    const ts = line.time ? `${line.time} ` : "";
    const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
    runtime.log(`${ts}${level}${line.message}`.trim());
  }
}
