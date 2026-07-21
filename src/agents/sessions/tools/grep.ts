/**
 * Built-in grep session tool.
 *
 * Searches files with ripgrep/local operations, optional context, and bounded output rendering.
 */
import type { ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { releaseChildProcessOutputAfterExit } from "../../../process/child-process.js";
import { spawnCommand } from "../../../process/exec.js";
import type { AgentTool } from "../../runtime/index.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { appendBoundedTextTail, normalizePositiveLimit } from "./limits.js";
import { resolveToCwd } from "./path-utils.js";
import {
  appendSessionToolTruncationWarning,
  formatSessionToolOutput,
  invalidArgText,
  shortenPath,
  str,
} from "./render-utils.js";
import type { GrepToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from "./truncate.js";

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Regex/literal pattern." }),
  path: Type.Optional(Type.String({ description: "File/dir; default cwd." })),
  glob: Type.Optional(Type.String({ description: "File glob, e.g. *.ts." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Ignore case; default false." })),
  literal: Type.Optional(
    Type.Boolean({
      description: "Literal, not regex; default false.",
    }),
  ),
  context: Type.Optional(
    Type.Number({
      description: "Context lines each side; default 0.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max matches; default 100." })),
});
const DEFAULT_LIMIT = 100;

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
  /** Check if path is a directory. Throws if path does not exist. */
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  /** Read file contents for context lines */
  readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
  isDirectory: (p) => statSync(p).isDirectory(),
  readFile: (p) => readFileSync(p, "utf-8"),
};

export interface GrepToolOptions {
  /** Custom operations for grep. Default: local filesystem plus ripgrep */
  operations?: GrepOperations;
}

function formatGrepCall(
  args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
  const pattern = str(args?.pattern);
  const rawPath = str(args?.path);
  const pathLocal = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const glob = str(args?.glob);
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);
  let text =
    theme.fg("toolTitle", theme.bold("grep")) +
    " " +
    (pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
    theme.fg("toolOutput", ` in ${pathLocal === null ? invalidArg : pathLocal}`);
  if (glob) {
    text += theme.fg("toolOutput", ` (${glob})`);
  }
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` limit ${limit}`);
  }
  return text;
}

function formatGrepResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: GrepToolDetails;
  },
  options: ToolRenderResultOptions,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
  showImages: boolean,
): string {
  const matchLimit = result.details?.matchLimitReached;
  const linesTruncated = result.details?.linesTruncated;
  return appendSessionToolTruncationWarning(
    formatSessionToolOutput(result, options, theme, showImages, 15),
    theme,
    {
      limit: matchLimit ? { count: matchLimit, noun: "matches" } : undefined,
      truncation: result.details?.truncation,
      additionalWarnings: linesTruncated ? ["some lines truncated"] : undefined,
    },
  );
}

export function createGrepToolDefinition(
  cwd: string,
  options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
  const customOps = options?.operations;
  return {
    name: "grep",
    label: "grep",
    description: `Search contents; returns path:line matches. Respects .gitignore. Caps ${DEFAULT_LIMIT} matches/${DEFAULT_MAX_BYTES / 1024}KB; lines cap ${GREP_MAX_LINE_LENGTH} chars.`,
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
    parameters: grepSchema,
    async execute(
      toolCallId,
      {
        pattern,
        path: searchDir,
        glob,
        ignoreCase,
        literal,
        context,
        limit,
      }: {
        pattern: string;
        path?: string;
        glob?: string;
        ignoreCase?: boolean;
        literal?: boolean;
        context?: number;
        limit?: number;
      },
      signal?: AbortSignal,
      onUpdate?,
      ctx?,
    ) {
      void toolCallId;
      void onUpdate;
      void ctx;
      return new Promise((resolve, reject) => {
        // Keep cancellation live from the first await through async result formatting.
        // Settlement owns listener cleanup; spawned children stop without waiting for close.
        let settled = false;
        let child: ChildProcess | undefined;
        let childClosed = false;
        let rl: ReturnType<typeof createInterface> | undefined;
        let killedDueToLimit = false;
        const cleanup = () => {
          rl?.close();
          signal?.removeEventListener("abort", onAbort);
        };
        const settle = (fn: () => void): boolean => {
          if (settled) {
            return false;
          }
          settled = true;
          cleanup();
          fn();
          return true;
        };
        const stopChild = (dueToLimit = false) => {
          if (child && !childClosed && !child.killed) {
            killedDueToLimit = dueToLimit;
            child.kill();
          }
        };
        const onAbort = () => {
          if (settle(() => reject(new Error("Operation aborted")))) {
            stopChild();
          }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          return;
        }

        void (async () => {
          try {
            const rgPath = await ensureTool("rg", true);
            if (settled) {
              return;
            }
            if (!rgPath) {
              settle(() =>
                reject(new Error("ripgrep (rg) is not available and could not be downloaded")),
              );
              return;
            }

            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const ops = customOps ?? defaultGrepOperations;
            let isDirectory: boolean;
            try {
              isDirectory = await ops.isDirectory(searchPath);
            } catch {
              settle(() => reject(new Error(`Path not found: ${searchPath}`)));
              return;
            }
            if (settled) {
              return;
            }

            const contextValue = context && context > 0 ? context : 0;
            const effectiveLimit = normalizePositiveLimit(limit, DEFAULT_LIMIT);
            const formatPath = (filePath: string): string => {
              if (isDirectory) {
                const relative = path.relative(searchPath, filePath);
                if (relative && !relative.startsWith("..")) {
                  return relative.replace(/\\/g, "/");
                }
              }
              return path.basename(filePath);
            };

            const fileCache = new Map<string, string[]>();
            const getFileLines = async (filePath: string): Promise<string[]> => {
              let lines = fileCache.get(filePath);
              if (!lines) {
                try {
                  const content = await ops.readFile(filePath);
                  lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
                } catch {
                  lines = [];
                }
                fileCache.set(filePath, lines);
              }
              return lines;
            };

            const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
            if (ignoreCase) {
              args.push("--ignore-case");
            }
            if (literal) {
              args.push("--fixed-strings");
            }
            if (glob) {
              args.push("--glob", glob);
            }
            args.push("--", pattern, searchPath);

            if (settled) {
              return;
            }
            const spawnedChild = spawnCommand([rgPath, ...args], {
              buffer: false,
              reject: false,
              stdio: ["ignore", "pipe", "pipe"],
            });
            releaseChildProcessOutputAfterExit(spawnedChild);
            child = spawnedChild;
            rl = createInterface({ input: spawnedChild.stdout });
            let stderr = "";
            let matchCount = 0;
            let matchLimitReached = false;
            let linesTruncated = false;
            const outputLines: string[] = [];

            // Decode stderr as UTF-8 at the stream so pipe chunk boundaries
            // cannot split multibyte characters into U+FFFD replacement noise.
            spawnedChild.stderr?.setEncoding("utf8");
            spawnedChild.stderr?.on("data", (chunk: string) => {
              stderr = appendBoundedTextTail(stderr, chunk);
            });
            const onStreamError = (stream: "stdout" | "stderr", error: Error) => {
              if (settled) {
                return;
              }
              if (settle(() => reject(new Error(`ripgrep ${stream} error: ${error.message}`)))) {
                stopChild();
              }
            };
            // readline re-emits input failures, then drops its input listener on close.
            // Keep the direct guard until child exit so later stdout errors stay handled.
            rl.on("error", (error) => onStreamError("stdout", error));
            spawnedChild.stdout?.on("error", (error) => onStreamError("stdout", error));
            spawnedChild.stderr?.on("error", (error) => onStreamError("stderr", error));

            const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
              const relativePath = formatPath(filePath);
              const lines = await getFileLines(filePath);
              if (!lines.length) {
                return [`${relativePath}:${lineNumber}: (unable to read file)`];
              }
              const block: string[] = [];
              const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
              const end =
                contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
              for (let current = start; current <= end; current++) {
                const lineText = lines[current - 1] ?? "";
                const sanitized = lineText.replace(/\r/g, "");
                const isMatchLine = current === lineNumber;
                // Truncate long lines so grep output stays compact.
                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                if (wasTruncated) {
                  linesTruncated = true;
                }
                if (isMatchLine) {
                  block.push(`${relativePath}:${current}: ${truncatedText}`);
                } else {
                  block.push(`${relativePath}-${current}- ${truncatedText}`);
                }
              }
              return block;
            };

            // Collect matches during streaming, then format them after rg exits.
            const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
            rl.on("line", (line) => {
              if (!line.trim() || matchCount >= effectiveLimit) {
                return;
              }
              let event: {
                type?: string;
                data?: {
                  path?: { text?: string };
                  line_number?: unknown;
                  lines?: { text?: string };
                };
              };
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              if (event.type === "match") {
                matchCount++;
                const filePath = event.data?.path?.text;
                const lineNumber = event.data?.line_number;
                const lineText = event.data?.lines?.text;
                if (filePath && typeof lineNumber === "number") {
                  matches.push({ filePath, lineNumber, lineText });
                }
                if (matchCount >= effectiveLimit) {
                  matchLimitReached = true;
                  stopChild(true);
                }
              }
            });

            spawnedChild.on("error", (error) => {
              childClosed = true;
              settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
            });
            spawnedChild.on("close", (code) => {
              childClosed = true;
              void (async () => {
                if (settled) {
                  return;
                }
                if (!killedDueToLimit && code !== 0 && code !== 1) {
                  const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                  settle(() => reject(new Error(errorMsg)));
                  return;
                }
                if (matchCount === 0) {
                  settle(() =>
                    resolve({
                      content: [{ type: "text", text: "No matches found" }],
                      details: undefined,
                    }),
                  );
                  return;
                }

                // Format matches after streaming finishes so custom readFile() backends can be async.
                for (const match of matches) {
                  if (contextValue === 0 && match.lineText !== undefined) {
                    const relativePath = formatPath(match.filePath);
                    const sanitized = match.lineText
                      .replace(/\r\n/g, "\n")
                      .replace(/\r/g, "")
                      .replace(/\n$/, "");
                    const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                    if (wasTruncated) {
                      linesTruncated = true;
                    }
                    outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
                  } else {
                    const block = await formatBlock(match.filePath, match.lineNumber);
                    if (settled) {
                      return;
                    }
                    outputLines.push(...block);
                  }
                }

                const rawOutput = outputLines.join("\n");
                // Apply byte truncation. There is no line limit here because the match limit already capped rows.
                const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
                let output = truncation.content;
                const details: GrepToolDetails = {};
                // Build actionable notices for truncation and match limits.
                const notices: string[] = [];
                if (matchLimitReached) {
                  notices.push(
                    `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                  );
                  details.matchLimitReached = effectiveLimit;
                }
                if (truncation.truncated) {
                  notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                  details.truncation = truncation;
                }
                if (linesTruncated) {
                  notices.push(
                    `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
                  );
                  details.linesTruncated = true;
                }
                if (notices.length > 0) {
                  output += `\n\n[${notices.join(". ")}]`;
                }
                settle(() =>
                  resolve({
                    content: [{ type: "text", text: output }],
                    details: Object.keys(details).length > 0 ? details : undefined,
                  }),
                );
              })().catch((err: unknown) => {
                settle(() => reject(err as Error));
              });
            });
          } catch (err) {
            if (settle(() => reject(err as Error))) {
              stopChild();
            }
          }
        })();
      });
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatGrepCall(args, theme));
      return text;
    },
    renderResult(result, optionsLocal, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatGrepResult(result, optionsLocal, theme, context.showImages));
      return text;
    },
  };
}

export function createGrepTool(
  cwd: string,
  options?: GrepToolOptions,
): AgentTool<typeof grepSchema> {
  return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
