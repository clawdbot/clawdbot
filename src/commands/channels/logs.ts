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
import { listManifestChannelContributionIds } from "../../plugins/manifest-contribution-ids.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

function listManifestChannelIds(): Set<string> {
  return new Set(
    listManifestChannelContributionIds({ includeDisabled: true, env: process.env })
      .map((id) => normalizeLowercaseStringOrEmpty(id))
      .filter(Boolean),
  );
}

function parseChannelFilter(raw?: string): string {
  if (raw === undefined) {
    return "all";
  }
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (trimmed === "all") {
    return "all";
  }
  const bundled = normalizeBundledChannelId(trimmed);
  if (bundled) {
    return bundled;
  }
  const manifestIds = listManifestChannelIds();
  if (manifestIds.has(trimmed)) {
    return trimmed;
  }
  const validChannels = ["all", ...new Set([...CHAT_CHANNEL_ORDER, ...manifestIds])];
  throw new Error(
    `Unknown channel ${JSON.stringify(raw)}. Valid channels: ${validChannels.join(", ")}`,
  );
}

function matchesChannel(line: ParsedLogLine, channel: string) {
  if (channel === "all") {
    return true;
  }
  const needle = `gateway/channels/${channel}`;
  if (line.subsystem?.includes(needle)) {
    return true;
  }
  if (line.module?.includes(channel)) {
    return true;
  }
  return false;
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
  const channel = parseChannelFilter(opts.channel);
  const limit = parseLinesOption(opts.lines);

  const tail = await readConfiguredParsedLogTail({ limit: limit * 4, maxBytes: MAX_BYTES });
  const filtered = tail.lines.filter((line) => matchesChannel(line, channel));
  const lines = filtered.slice(Math.max(0, filtered.length - limit));

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
