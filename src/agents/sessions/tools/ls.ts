/**
 * Built-in ls session tool.
 *
 * Lists directory entries through local or injected operations with bounded output rendering.
 */
import { existsSync, statSync } from "node:fs";
import { opendir } from "node:fs/promises";
import nodePath from "node:path";
import { Type } from "typebox";
import { toErrorObject } from "../../../infra/errors.js";
import type { AgentTool } from "../../runtime/index.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { normalizePositiveLimit } from "./limits.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";
import {
  appendSessionToolTruncationWarning,
  formatSessionToolOutput,
  invalidArgText,
  reuseTextComponent,
  shortenPath,
  str,
} from "./render-utils.js";
import type { LsToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory; default cwd." })),
  limit: Type.Optional(Type.Number({ description: "Max entries; default 500." })),
});
const DEFAULT_LIMIT = 500;
const LOCAL_DIRECTORY_READ_BUFFER_ENTRIES = 32;

export type LsDirectoryEntry = string | { name: string; isDirectory: boolean };

type LsDirectoryEntries = Iterable<LsDirectoryEntry> | AsyncIterable<LsDirectoryEntry>;

type NormalizedLsDirectoryEntry = { name: string; isDirectory?: boolean };

function compareLsDirectoryEntries(
  left: NormalizedLsDirectoryEntry,
  right: NormalizedLsDirectoryEntry,
): number {
  return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
}

function retainSortedDirectoryEntry(
  entries: NormalizedLsDirectoryEntry[],
  entry: NormalizedLsDirectoryEntry,
  limit: number,
): void {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareLsDirectoryEntries(entries[middle]!, entry) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  entries.splice(low, 0, entry);
  if (entries.length > limit) {
    entries.pop();
  }
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
  /** Check if path exists */
  exists: (absolutePath: string, options?: { signal?: AbortSignal }) => Promise<boolean> | boolean;
  /** Get file or directory stats. Throws if not found. */
  stat: (
    absolutePath: string,
    options?: { signal?: AbortSignal },
  ) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  /** Read directory entries */
  readdir: (
    absolutePath: string,
    options?: { signal?: AbortSignal },
  ) => Promise<LsDirectoryEntries> | LsDirectoryEntries;
}

async function* readLocalDirectory(
  absolutePath: string,
  options?: { signal?: AbortSignal },
): AsyncGenerator<string> {
  options?.signal?.throwIfAborted();
  const directory = await opendir(absolutePath, {
    bufferSize: LOCAL_DIRECTORY_READ_BUFFER_ENTRIES,
  });
  try {
    while (true) {
      options?.signal?.throwIfAborted();
      const entry = await directory.read();
      options?.signal?.throwIfAborted();
      if (!entry) {
        return;
      }
      yield entry.name;
    }
  } finally {
    await directory.close();
  }
}

const defaultLsOperations: LsOperations = {
  exists: (absolutePath) => existsSync(absolutePath),
  stat: (absolutePath) => statSync(absolutePath),
  readdir: readLocalDirectory,
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
}

function formatLsCall(
  args: { path?: string; limit?: number } | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").interactiveAgentTheme,
): string {
  const rawPath = str(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);
  let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${path === null ? invalidArg : theme.fg("accent", path)}`;
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` (limit ${limit})`);
  }
  return text;
}

function formatLsResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: LsToolDetails;
  },
  options: ToolRenderResultOptions,
  theme: typeof import("../../modes/interactive/theme/theme.js").interactiveAgentTheme,
  showImages: boolean,
): string {
  const entryLimit = result.details?.entryLimitReached;
  return appendSessionToolTruncationWarning(
    formatSessionToolOutput(result, options, theme, showImages, 20),
    theme,
    {
      limit: entryLimit ? { count: entryLimit, noun: "entries" } : undefined,
      truncation: result.details?.truncation,
    },
  );
}

export function createLsToolDefinition(
  cwd: string,
  options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
  const ops = options?.operations ?? defaultLsOperations;
  const resolvePath = options?.operations ? resolveToCwd : resolveLocalPathToCwd;
  return {
    name: "ls",
    label: "ls",
    description: `List dir alphabetically; / marks dirs; includes dotfiles. Caps ${DEFAULT_LIMIT} entries/${DEFAULT_MAX_BYTES / 1024}KB.`,
    promptSnippet: "List directory contents",
    parameters: lsSchema,
    async execute(
      toolCallId,
      { path, limit }: { path?: string; limit?: number },
      signal?: AbortSignal,
      onUpdate?,
      ctx?,
    ) {
      void toolCallId;
      void onUpdate;
      void ctx;
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const runListing = async () => {
        try {
          const dirPath = resolvePath(path || ".", cwd);
          const effectiveLimit = normalizePositiveLimit(limit, DEFAULT_LIMIT);

          // Check if path exists.
          if (!(await ops.exists(dirPath, { signal }))) {
            throw new Error(`Path not found: ${dirPath}`);
          }

          // Check if path is a directory.
          const stat = await ops.stat(dirPath, { signal });
          if (!stat.isDirectory()) {
            throw new Error(`Not a directory: ${dirPath}`);
          }

          // Read directory entries.
          const entries: NormalizedLsDirectoryEntry[] = [];
          let entryCount = 0;
          let entryLimitReached = false;
          try {
            const source = await ops.readdir(dirPath, { signal });
            for await (const entry of source) {
              signal?.throwIfAborted();
              entryCount += 1;
              retainSortedDirectoryEntry(
                entries,
                typeof entry === "string" ? { name: entry } : entry,
                effectiveLimit,
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Cannot read directory: ${message}`, { cause: error });
          }

          entryLimitReached = entryCount > effectiveLimit;

          // Format entries with directory indicators.
          const results: string[] = [];
          for (const entry of entries) {
            let isDirectory = entry.isDirectory;
            if (isDirectory === undefined) {
              try {
                const fullPath = nodePath.join(dirPath, entry.name);
                const entryStat = await ops.stat(fullPath, { signal });
                isDirectory = entryStat.isDirectory();
              } catch {
                isDirectory = false;
              }
            }
            results.push(entry.name + (isDirectory ? "/" : ""));
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text" as const, text: "(empty directory)" }],
              details: undefined,
            };
          }

          const rawOutput = results.join("\n");
          // Apply byte truncation. There is no separate line limit because entry count is already capped.
          const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
          let output = truncation.content;
          const details: LsToolDetails = {};
          // Build actionable notices for truncation and entry limits.
          const notices: string[] = [];
          if (entryLimitReached) {
            notices.push(
              `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
            );
            details.entryLimitReached = effectiveLimit;
          }
          if (truncation.truncated) {
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation = truncation;
          }
          if (notices.length > 0) {
            output += `\n\n[${notices.join(". ")}]`;
          }

          return {
            content: [{ type: "text" as const, text: output }],
            details: Object.keys(details).length > 0 ? details : undefined,
          };
        } catch (e: unknown) {
          throw toErrorObject(e, "Non-Error rejection");
        }
      };

      if (!signal) {
        return await runListing();
      }

      // Race the listing with cancellation, but always detach the listener when either wins.
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Operation aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      });
      try {
        return await Promise.race([runListing(), abortPromise]);
      } finally {
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
    renderCall(args, theme, context) {
      return reuseTextComponent(context.lastComponent, formatLsCall(args, theme));
    },
    renderResult(result, optionsLocal, theme, context) {
      const content = formatLsResult(result, optionsLocal, theme, context.showImages);
      return reuseTextComponent(context.lastComponent, content);
    },
  };
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
  return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
