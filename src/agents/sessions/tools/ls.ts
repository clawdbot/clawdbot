/**
 * Built-in ls session tool.
 *
 * Lists directory entries through local or injected operations with bounded output rendering.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import nodePath from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import type { AgentTool } from "../../runtime/index.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { normalizePositiveLimit } from "./limits.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import type { LsToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list (default: current directory)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of entries to return (default: 500)" }),
  ),
});
export type { LsToolDetails, LsToolInput } from "./tool-contracts.js";

const DEFAULT_LIMIT = 500;

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Get file or directory stats. Throws if not found. */
  stat: (
    absolutePath: string,
  ) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  /** Read directory entries */
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
  exists: existsSync,
  stat: statSync,
  readdir: readdirSync,
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
}

function formatLsCall(
  args: { path?: string; limit?: number } | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
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
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
  showImages: boolean,
): string {
  const output = getTextOutput(result, showImages).trim();
  let text = "";
  if (output) {
    const lines = output.split("\n");
    const maxLines = options.expanded ? lines.length : 20;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
    }
  }

  const entryLimit = result.details?.entryLimitReached;
  const truncation = result.details?.truncation;
  if (entryLimit || truncation?.truncated) {
    const warnings: string[] = [];
    if (entryLimit) {
      warnings.push(`${entryLimit} entries limit`);
    }
    if (truncation?.truncated) {
      warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
    }
    text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
  }
  return text;
}

export function createLsToolDefinition(
  cwd: string,
  options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
  const ops = options?.operations ?? defaultLsOperations;
  return {
    name: "ls",
    label: "ls",
    description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
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
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        const onAbort = () => reject(new Error("Operation aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const dirPath = resolveToCwd(path || ".", cwd);
            const effectiveLimit = normalizePositiveLimit(limit, DEFAULT_LIMIT);

            // Check if path exists.
            if (!(await ops.exists(dirPath))) {
              reject(new Error(`Path not found: ${dirPath}`));
              return;
            }

            // Check if path is a directory.
            const stat = await ops.stat(dirPath);
            if (!stat.isDirectory()) {
              reject(new Error(`Not a directory: ${dirPath}`));
              return;
            }

            // Read directory entries.
            let entries: string[];
            try {
              entries = await ops.readdir(dirPath);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              reject(new Error(`Cannot read directory: ${message}`));
              return;
            }

            // Sort alphabetically, case-insensitive.
            entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

            // Format entries with directory indicators.
            const results: string[] = [];
            let entryLimitReached = false;
            for (const entry of entries) {
              if (results.length >= effectiveLimit) {
                entryLimitReached = true;
                break;
              }

              const fullPath = nodePath.join(dirPath, entry);
              let suffix = "";
              try {
                const entryStat = await ops.stat(fullPath);
                if (entryStat.isDirectory()) {
                  suffix = "/";
                }
              } catch {
                // Skip entries we cannot stat.
                continue;
              }
              results.push(entry + suffix);
            }

            signal?.removeEventListener("abort", onAbort);

            if (results.length === 0) {
              resolve({
                content: [{ type: "text", text: "(empty directory)" }],
                details: undefined,
              });
              return;
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

            resolve({
              content: [{ type: "text", text: output }],
              details: Object.keys(details).length > 0 ? details : undefined,
            });
          } catch (e: unknown) {
            signal?.removeEventListener("abort", onAbort);
            reject(toLintErrorObject(e, "Non-Error rejection"));
          }
        })();
      });
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatLsCall(args, theme));
      return text;
    },
    renderResult(result, optionsLocal, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatLsResult(result, optionsLocal, theme, context.showImages));
      return text;
    },
  };
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
  return wrapToolDefinition(createLsToolDefinition(cwd, options));
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
