import fs from "node:fs/promises";
import { normalizeChannelId as normalizeBundledChannelId } from "../../channels/registry.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { resolveLogFile } from "../../logging/log-tail.js";
import { parseLogLine } from "../../logging/parse-log-line.js";
import {
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
} from "../../plugins/plugin-registry.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
};

type LogLine = ReturnType<typeof parseLogLine>;

const DEFAULT_LIMIT = 200;
const MAX_BYTES = 1_000_000;

function listManifestChannelIds(): Set<string> {
  const index = loadPluginRegistrySnapshot({
    env: process.env,
  });
  return new Set(
    listPluginContributionIds({
      index,
      contribution: "channels",
      includeDisabled: true,
    }),
  );
}

function parseChannelFilter(raw?: string) {
  const trimmed = normalizeLowercaseStringOrEmpty(raw);
  if (!trimmed || trimmed === "all") {
    return "all";
  }
  const bundled = normalizeBundledChannelId(trimmed);
  if (bundled) {
    return bundled;
  }
  return listManifestChannelIds().has(trimmed) ? trimmed : "all";
}

function matchesChannel(line: NonNullable<LogLine>, channel: string) {
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

async function readTailLines(file: string, limit: number): Promise<string[]> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    return [];
  }
  const size = stat.size;
  const start = Math.max(0, size - MAX_BYTES);
  const handle = await fs.open(file, "r");
  try {
    const length = Math.max(0, size - start);
    if (length === 0) {
      return [];
    }
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");
    if (start > 0) {
      lines = lines.slice(1);
    }
    if (lines.length && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }
    return lines;
  } finally {
    await handle.close();
  }
}

export async function channelsLogsCommand(
  opts: ChannelsLogsOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const channel = parseChannelFilter(opts.channel);
  const limitRaw = typeof opts.lines === "string" ? Number(opts.lines) : opts.lines;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : DEFAULT_LIMIT;

  const file = await resolveLogFile(getResolvedLoggerSettings().file);
  const rawLines = await readTailLines(file, limit * 4);
  const parsed = rawLines
    .map(parseLogLine)
    .filter((line): line is NonNullable<LogLine> => Boolean(line));
  const filtered = parsed.filter((line) => matchesChannel(line, channel));
  const lines = filtered.slice(Math.max(0, filtered.length - limit));

  if (opts.json) {
    writeRuntimeJson(runtime, { file, channel, lines });
    return;
  }

  runtime.log(theme.info(`Log file: ${file}`));
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
