// Implements channel-scoped tailing of the OpenClaw log file.
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  CHAT_CHANNEL_ORDER,
  normalizeChatChannelId as normalizeBundledChannelId,
} from "../../channels/registry.js";
import { isMissingPathError } from "../../infra/errno.js";
import { readFileWindowFully } from "../../infra/file-read.js";
import { readConfiguredParsedLogTail } from "../../logging/log-tail.js";
import type { ParsedLogLine } from "../../logging/parse-log-line.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export type ChannelsLogsOptions = {
  channel?: string;
  lines?: string | number;
  json?: boolean;
  follow?: boolean;
  interval?: string | number;
};

const DEFAULT_LIMIT = 200;
const DEFAULT_INTERVAL = 1000;
// Node clamps setTimeout delays outside the signed 32-bit range to 1 ms.
const MAX_TIMER_DELAY = 2_147_483_647;
const MAX_BYTES = 1_000_000;

type ChannelLogFilter = { channel: string; pluginIds: ReadonlySet<string> };
type ManifestChannel = { id: string; pluginId: string };
type FileCheckpoint = {
  file: string;
  identity: string;
  cursor: number;
  prefixLength: number;
  prefix: string;
  boundary: string;
};

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
  return [channel, `gateway/channels/${channel}`].some(
    (root) => value === root || value?.startsWith(`${root}/`) === true,
  );
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
    [line.subsystem, line.module].some((value) => matchesChannelContext(value, channel)) ||
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

function parseIntervalOption(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_INTERVAL;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error("--interval must be a positive integer.");
  }
  if (parsed > MAX_TIMER_DELAY) {
    throw new Error(`--interval must be no greater than ${MAX_TIMER_DELAY} milliseconds.`);
  }
  return parsed;
}

function writeChannelLogLine(runtime: RuntimeEnv, line: ParsedLogLine, json: boolean): void {
  if (json) {
    writeRuntimeJson(runtime, { type: "log", ...line }, 0);
    return;
  }
  const ts = line.time ? `${line.time} ` : "";
  const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
  runtime.log(`${ts}${level}${line.message}`.trim());
}

function installFollowSignalHandlers(controller: AbortController): () => void {
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  };
}

async function readFileCheckpoint(
  file: string,
  cursor: number,
  prefixLength?: number,
): Promise<FileCheckpoint | undefined> {
  const handle = await fs.open(file, "r").catch((error) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    const readWindow = async (start: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, stat.size - start)));
      const bytesRead = await readFileWindowFully(handle, buffer, start);
      return buffer.toString("base64", 0, bytesRead);
    };
    const boundedCursor = Math.min(Math.max(0, cursor), stat.size);
    const boundedPrefixLength = Math.min(64, Math.max(0, prefixLength ?? boundedCursor), stat.size);
    const boundaryStart = Math.max(0, boundedCursor - 64);
    return {
      file,
      identity: `${stat.dev}:${stat.ino}`,
      cursor: boundedCursor,
      prefixLength: boundedPrefixLength,
      prefix: await readWindow(0, boundedPrefixLength),
      boundary: await readWindow(boundaryStart, boundedCursor - boundaryStart),
    };
  } finally {
    await handle.close();
  }
}

function isSameFileCheckpoint(
  previous: FileCheckpoint,
  current: FileCheckpoint | undefined,
): boolean {
  return (
    current?.file === previous.file &&
    current.identity === previous.identity &&
    current.prefixLength === previous.prefixLength &&
    current.prefix === previous.prefix &&
    current.boundary === previous.boundary
  );
}

function isSameFileGeneration(
  previous: FileCheckpoint,
  current: FileCheckpoint | undefined,
): boolean {
  return (
    current?.file === previous.file &&
    current.identity === previous.identity &&
    current.prefixLength === previous.prefixLength &&
    current.prefix === previous.prefix
  );
}

async function followChannelLogs(
  filter: ChannelLogFilter,
  channel: string,
  limit: number,
  interval: number,
  json: boolean,
  runtime: RuntimeEnv,
): Promise<void> {
  const controller = new AbortController();
  const removeSignalHandlers = installFollowSignalHandlers(controller);
  let cursor: number | undefined;
  let previousFile: string | undefined;
  let previousCheckpoint: FileCheckpoint | undefined;
  let firstRead = true;

  try {
    while (!controller.signal.aborted) {
      const readLimit = firstRead ? limit : "all";
      const previousGeneration = previousCheckpoint
        ? await readFileCheckpoint(
            previousCheckpoint.file,
            previousCheckpoint.cursor,
            previousCheckpoint.prefixLength,
          )
        : undefined;
      let reanchored =
        previousCheckpoint !== undefined &&
        !isSameFileCheckpoint(previousCheckpoint, previousGeneration);
      const readCursor = reanchored ? undefined : cursor;
      let tail = await readConfiguredParsedLogTail({
        cursor: readCursor,
        limit: readLimit,
        maxBytes: MAX_BYTES,
        filter: (line) => matchesChannel(line, filter),
      });

      // A rolling file can change between polls. Re-anchor to the new file so a
      // coincidentally valid byte offset cannot skip its initial records.
      if (previousFile !== undefined && tail.file !== previousFile) {
        tail = await readConfiguredParsedLogTail({
          limit: readLimit,
          maxBytes: MAX_BYTES,
          filter: (line) => matchesChannel(line, filter),
        });
        reanchored = true;
      }

      let checkpoint = await readFileCheckpoint(
        tail.file,
        tail.cursor,
        reanchored ? undefined : previousCheckpoint?.prefixLength,
      );
      if (
        !reanchored &&
        previousGeneration !== undefined &&
        !isSameFileGeneration(previousGeneration, checkpoint)
      ) {
        tail = await readConfiguredParsedLogTail({
          limit: readLimit,
          maxBytes: MAX_BYTES,
          filter: (line) => matchesChannel(line, filter),
        });
        reanchored = true;
        checkpoint = await readFileCheckpoint(tail.file, tail.cursor);
      }

      const fileChanged = previousFile !== undefined && tail.file !== previousFile;
      if (json) {
        if (firstRead || fileChanged) {
          writeRuntimeJson(runtime, { type: "meta", file: tail.file, channel }, 0);
        }
        if (tail.truncated) {
          writeRuntimeJson(
            runtime,
            { type: "notice", message: "Log tail truncated; earlier entries were omitted." },
            0,
          );
        }
        if (tail.reset || reanchored) {
          writeRuntimeJson(
            runtime,
            { type: "notice", message: "Log file reset; re-reading the current tail." },
            0,
          );
        }
      } else {
        if (firstRead || fileChanged) {
          runtime.log(theme.info(`Log file: ${tail.file}`));
          if (channel !== "all") {
            runtime.log(theme.info(`Channel: ${channel}`));
          }
        }
        if (tail.truncated) {
          runtime.log(theme.warn("Log tail truncated; earlier entries were omitted."));
        }
        if (tail.reset || reanchored) {
          runtime.log(theme.warn("Log file reset; re-reading the current tail."));
        }
      }

      for (const line of tail.lines) {
        writeChannelLogLine(runtime, line, json);
      }
      cursor = checkpoint ? tail.cursor : undefined;
      previousFile = checkpoint ? tail.file : undefined;
      previousCheckpoint = checkpoint;
      firstRead = false;

      try {
        await delay(interval, undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        throw error;
      }
    }
  } finally {
    removeSignalHandlers();
  }
}

/** Print or serialize recent log lines matching one channel subsystem/module. */
export async function channelsLogsCommand(
  opts: ChannelsLogsOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const filter = parseChannelFilter(opts.channel);
  const { channel } = filter;
  const limit = parseLinesOption(opts.lines);

  if (opts.follow) {
    await followChannelLogs(
      filter,
      channel,
      limit,
      parseIntervalOption(opts.interval),
      Boolean(opts.json),
      runtime,
    );
    return;
  }

  const tail = await readConfiguredParsedLogTail({
    limit,
    maxBytes: MAX_BYTES,
    filter: (line) => matchesChannel(line, filter),
  });
  const { lines, truncated } = tail;

  if (opts.json) {
    writeRuntimeJson(runtime, { file: tail.file, channel, truncated, lines });
    return;
  }

  runtime.log(theme.info(`Log file: ${tail.file}`));
  if (channel !== "all") {
    runtime.log(theme.info(`Channel: ${channel}`));
  }
  if (truncated) {
    runtime.log(theme.warn("Log tail truncated; earlier entries were omitted."));
  }
  if (lines.length === 0) {
    runtime.log(theme.muted("No matching log lines."));
    return;
  }
  for (const line of lines) {
    writeChannelLogLine(runtime, line, false);
  }
}
