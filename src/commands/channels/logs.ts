// Implements channel-scoped tailing of the OpenClaw log file.
import { createHash } from "node:crypto";
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
import {
  LOG_GENERATION_WINDOW_BYTES,
  readConfiguredParsedLogTail,
  type LogFileGeneration,
} from "../../logging/log-tail.js";
import type { ParsedLogLine } from "../../logging/parse-log-line.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
import {
  defaultRuntime,
  type RuntimeEnv,
  writeRuntimeJson,
  writeRuntimeStdout,
} from "../../runtime.js";

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
  size: number;
  cursor: number;
  prefixLength: number;
  prefix: string;
  boundary: string;
  contentHash: string;
  contentWindowStart: number;
  contentWindowLength: number;
  validationContentHash: string;
  validationContentWindowStart: number;
  validationContentWindowLength: number;
  validationBoundary: string;
  mtimeNs: string;
  ctimeNs: string;
};

function checkpointPrefixLength(size: number): number {
  return Math.min(64, Math.max(0, size));
}

function contentWindowBounds(cursor: number, size: number) {
  const end = Math.min(Math.max(0, cursor), size);
  const start = Math.max(0, end - LOG_GENERATION_WINDOW_BYTES);
  return { start, length: end - start };
}

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

function writeChannelLogLine(
  runtime: RuntimeEnv,
  line: ParsedLogLine,
  json: boolean,
  follow = false,
): void {
  if (json) {
    writeRuntimeJson(runtime, { type: "log", ...line }, 0);
    return;
  }
  const ts = line.time ? `${line.time} ` : "";
  const level = line.level ? `${normalizeLowercaseStringOrEmpty(line.level)} ` : "";
  const output = `${ts}${level}${line.message}`.trim();
  if (follow) {
    writeRuntimeStdout(runtime, output);
    return;
  }
  runtime.log(output);
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

function isOutputClosedError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "EPIPE" || code === "EIO";
}

function installFollowOutputHandlers(controller: AbortController): () => void {
  const stop = () => controller.abort();
  const handleError = (error: Error) => {
    if (isOutputClosedError(error)) {
      stop();
    }
  };
  process.stdout.once("close", stop);
  process.stdout.once("error", handleError);
  return () => {
    process.stdout.off("close", stop);
    process.stdout.off("error", handleError);
  };
}

async function readFileCheckpoint(
  file: string,
  cursor: number,
  prefixLength?: number,
  validationCursor = cursor,
): Promise<FileCheckpoint | undefined> {
  const handle = await fs.open(file, "r").catch((error: unknown) => {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return undefined;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    const readWindow = async (start: number, length: number) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const bytesRead = await readFileWindowFully(handle, buffer, start);
      return buffer.toString("base64", 0, bytesRead);
    };
    const readContentHash = async (contentCursor: number) => {
      const window = contentWindowBounds(contentCursor, size);
      const buffer = Buffer.alloc(window.length);
      const bytesRead = await readFileWindowFully(handle, buffer, window.start);
      return {
        hash: createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex"),
        start: window.start,
        length: bytesRead,
      };
    };
    const boundedCursor = Math.min(Math.max(0, cursor), size);
    const boundedValidationCursor = Math.min(Math.max(0, validationCursor), size);
    const boundedPrefixLength = Math.min(64, Math.max(0, prefixLength ?? size), size);
    const boundaryStart = Math.max(0, boundedCursor - 64);
    const validationBoundaryStart = Math.max(0, boundedValidationCursor - 64);
    const boundary = await readWindow(boundaryStart, boundedCursor - boundaryStart);
    const content = await readContentHash(boundedCursor);
    const validationContent =
      boundedValidationCursor === boundedCursor
        ? content
        : await readContentHash(boundedValidationCursor);
    return {
      file,
      identity: `${stat.dev}:${stat.ino}`,
      size,
      cursor: boundedCursor,
      prefixLength: boundedPrefixLength,
      prefix: await readWindow(0, boundedPrefixLength),
      boundary,
      contentHash: content.hash,
      contentWindowStart: content.start,
      contentWindowLength: content.length,
      validationContentHash: validationContent.hash,
      validationContentWindowStart: validationContent.start,
      validationContentWindowLength: validationContent.length,
      validationBoundary:
        validationBoundaryStart === boundaryStart && boundedValidationCursor === boundedCursor
          ? boundary
          : await readWindow(
              validationBoundaryStart,
              boundedValidationCursor - validationBoundaryStart,
            ),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
  } finally {
    await handle.close();
  }
}

function isSameFileCheckpoint(
  previous: FileCheckpoint,
  current: FileCheckpoint | undefined,
): boolean {
  return isSameFileGeneration(previous, current) && current?.boundary === previous.boundary;
}

function isSameFileGeneration(
  previous: FileCheckpoint,
  current: FileCheckpoint | undefined,
): boolean {
  const currentPrefix = current ? Buffer.from(current.prefix, "base64") : undefined;
  const previousPrefix = Buffer.from(previous.prefix, "base64");
  return (
    current?.file === previous.file &&
    current.identity === previous.identity &&
    current.size >= previous.size &&
    current.prefixLength >= previous.prefixLength &&
    currentPrefix?.subarray(0, previous.prefixLength).equals(previousPrefix) === true &&
    current.validationContentHash === previous.contentHash &&
    current.validationContentWindowStart === previous.contentWindowStart &&
    current.validationContentWindowLength === previous.contentWindowLength &&
    (current.size > previous.size ||
      (current.mtimeNs === previous.mtimeNs && current.ctimeNs === previous.ctimeNs))
  );
}

function isSameTailGeneration(
  file: string,
  generation: LogFileGeneration | undefined,
  current: FileCheckpoint | undefined,
): boolean {
  if (generation === undefined) {
    return current === undefined;
  }
  const currentPrefix = current ? Buffer.from(current.prefix, "base64") : undefined;
  const generationPrefix = Buffer.from(generation.prefix, "base64");
  return (
    current?.file === file &&
    current.identity === generation.identity &&
    current.size >= generation.size &&
    current.prefixLength >= generation.prefixLength &&
    currentPrefix?.subarray(0, generation.prefixLength).equals(generationPrefix) === true &&
    current.boundary === generation.boundary &&
    current.contentHash === generation.contentHash &&
    current.contentWindowStart === generation.contentWindowStart &&
    current.contentWindowLength === generation.contentWindowLength &&
    (current.size > generation.size ||
      (current.mtimeNs === generation.mtimeNs && current.ctimeNs === generation.ctimeNs))
  );
}

function isSameFileGenerationAtValidationCursor(
  previous: FileCheckpoint,
  current: FileCheckpoint | undefined,
): boolean {
  return (
    isSameFileGeneration(previous, current) && current?.validationBoundary === previous.boundary
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
  const removeOutputHandlers = installFollowOutputHandlers(controller);
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

      if (tail.generationStable === false) {
        try {
          await delay(interval, undefined, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          throw error;
        }
        continue;
      }

      if (!reanchored && previousGeneration !== undefined && previousCheckpoint !== undefined) {
        const postReadGeneration = await readFileCheckpoint(
          tail.file,
          previousCheckpoint.cursor,
          previousCheckpoint.prefixLength,
        );
        if (!isSameFileCheckpoint(previousGeneration, postReadGeneration)) {
          tail = await readConfiguredParsedLogTail({
            limit: readLimit,
            maxBytes: MAX_BYTES,
            filter: (line) => matchesChannel(line, filter),
          });
          reanchored = true;
        }
      }

      const checkpointPrefix = reanchored ? undefined : checkpointPrefixLength(tail.size);
      let checkpoint = await readFileCheckpoint(
        tail.file,
        tail.cursor,
        checkpointPrefix,
        previousCheckpoint?.cursor,
      );
      let checkpointValid =
        tail.generationStable !== false &&
        isSameTailGeneration(tail.file, tail.generation, checkpoint);
      if (!checkpointValid) {
        tail = await readConfiguredParsedLogTail({
          limit: readLimit,
          maxBytes: MAX_BYTES,
          filter: (line) => matchesChannel(line, filter),
        });
        reanchored = true;
        checkpoint = await readFileCheckpoint(
          tail.file,
          tail.cursor,
          checkpointPrefixLength(tail.size),
        );
        checkpointValid =
          tail.generationStable !== false &&
          isSameTailGeneration(tail.file, tail.generation, checkpoint);
      }
      if (
        checkpointValid &&
        !reanchored &&
        previousGeneration !== undefined &&
        previousCheckpoint !== undefined &&
        !isSameFileGenerationAtValidationCursor(previousGeneration, checkpoint)
      ) {
        tail = await readConfiguredParsedLogTail({
          limit: readLimit,
          maxBytes: MAX_BYTES,
          filter: (line) => matchesChannel(line, filter),
        });
        reanchored = true;
        checkpoint = await readFileCheckpoint(
          tail.file,
          tail.cursor,
          checkpointPrefixLength(tail.size),
        );
        checkpointValid =
          tail.generationStable !== false &&
          isSameTailGeneration(tail.file, tail.generation, checkpoint);
      }
      if (!checkpointValid) {
        try {
          await delay(interval, undefined, { signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          throw error;
        }
        continue;
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
          writeRuntimeStdout(runtime, theme.info(`Log file: ${tail.file}`));
          if (channel !== "all") {
            writeRuntimeStdout(runtime, theme.info(`Channel: ${channel}`));
          }
        }
        if (tail.truncated) {
          writeRuntimeStdout(
            runtime,
            theme.warn("Log tail truncated; earlier entries were omitted."),
          );
        }
        if (tail.reset || reanchored) {
          writeRuntimeStdout(runtime, theme.warn("Log file reset; re-reading the current tail."));
        }
      }

      for (const line of tail.lines) {
        writeChannelLogLine(runtime, line, json, true);
      }
      cursor = checkpoint ? tail.cursor : undefined;
      previousFile = tail.file;
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
    removeOutputHandlers();
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
