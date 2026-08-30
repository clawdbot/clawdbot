/**
 * Built-in grep session tool.
 *
 * Searches files with ripgrep/local operations, optional context, and bounded output rendering.
 */
import { statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { releaseChildProcessOutputAfterExit } from "../../../process/child-process.js";
import { spawnCommand } from "../../../process/exec.js";
import { normalizeNativePathSeparators } from "../../../shared/ignore-rules.js";
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

export interface GrepToolOptions {
  /** Custom operations for grep. Default: local filesystem plus ripgrep */
  operations?: GrepOperations;
}

function formatGrepCall(
  args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").interactiveAgentTheme,
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
  theme: typeof import("../../modes/interactive/theme/theme.js").interactiveAgentTheme,
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
        let child:
          | {
              nodeChildProcess: { killed: boolean };
              kill: () => void;
            }
          | undefined;
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
          if (child && !childClosed && !child.nodeChildProcess.killed) {
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
            let isDirectory: boolean;
            try {
              isDirectory = await (customOps?.isDirectory(searchPath) ??
                statSync(searchPath).isDirectory());
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
              const relative = isDirectory ? path.relative(searchPath, filePath) : "";
              return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)
                ? normalizeNativePathSeparators(relative)
                : path.basename(filePath);
            };

            const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
            if (!customOps && contextValue > 0) {
              args.push("--context", String(contextValue));
            }
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
            releaseChildProcessOutputAfterExit(spawnedChild.nodeChildProcess);
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

            const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
            const nativeFiles = new Map<string, Map<number, string>>();
            rl.on("line", (line) => {
              if (!line.trim() || settled || killedDueToLimit) {
                return;
              }
              let event: {
                type?: string;
                data?: {
                  path?: { text?: string };
                  line_number?: unknown;
                  lines?: { text?: string; bytes?: string };
                };
              };
              try {
                event = JSON.parse(line);
              } catch {
                return;
              }
              const filePath = event.data?.path?.text;
              const lineNumber = event.data?.line_number;
              const lineText = event.data?.lines?.text;
              if (event.type === "match") {
                matchCount++;
                matchLimitReached = matchCount > effectiveLimit;
                if (!matchLimitReached && filePath && typeof lineNumber === "number") {
                  matches.push({ filePath, lineNumber, lineText });
                }
              }
              const lastMatch = matches.at(-1);
              const windowEnd = (lastMatch?.lineNumber ?? 0) + contextValue;
              const inLastWindow =
                filePath === lastMatch?.filePath &&
                typeof lineNumber === "number" &&
                lineNumber <= windowEnd;
              if (
                filePath &&
                typeof lineNumber === "number" &&
                (matchCount < effectiveLimit || inLastWindow)
              ) {
                const text =
                  lineText ??
                  (!customOps && event.data?.lines?.bytes !== undefined
                    ? Buffer.from(event.data.lines.bytes, "base64").toString("utf8")
                    : undefined);
                if (text !== undefined) {
                  const lines = nativeFiles.get(filePath) ?? new Map<number, string>();
                  lines.set(lineNumber, text);
                  nativeFiles.set(filePath, lines);
                }
              }
              // The extra match can be context for the last retained match. Capture its
              // row, then drain through that window's end (or EOF) before stopping rg.
              if (matchLimitReached && (customOps || !inLastWindow || lineNumber === windowEnd)) {
                stopChild(true);
              }
            });

            spawnedChild.nodeChildProcess.on("error", (error) => {
              childClosed = true;
              settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
            });
            spawnedChild.nodeChildProcess.on("close", (code) => {
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
                const fileCache = new Map<string, string[]>();
                for (const { filePath, lineNumber, lineText: matchText } of matches) {
                  const relativePath = formatPath(filePath);
                  let customLines: string[] | undefined;
                  if (customOps && (contextValue > 0 || matchText === undefined)) {
                    customLines = fileCache.get(filePath);
                    if (!customLines) {
                      try {
                        const content = await customOps.readFile(filePath);
                        customLines = content.replace(/\r\n?/g, "\n").split("\n");
                      } catch {
                        customLines = [];
                      }
                      fileCache.set(filePath, customLines);
                    }
                    if (settled) {
                      return;
                    }
                    if (!customLines.length) {
                      outputLines.push(`${relativePath}:${lineNumber}: (unable to read file)`);
                      continue;
                    }
                  }
                  const nativeLines = nativeFiles.get(filePath);
                  for (
                    let current = Math.max(1, lineNumber - contextValue);
                    current <= lineNumber + contextValue;
                    current++
                  ) {
                    const lineText = customLines
                      ? customLines[current - 1]
                      : nativeLines?.get(current);
                    if (lineText === undefined) {
                      // Native context windows are contiguous; absence is EOF, not
                      // a synthetic empty row after the file's final terminator.
                      break;
                    }
                    const { text, wasTruncated } = truncateLine(
                      lineText.replace(/\r/g, "").replace(/\n$/, ""),
                    );
                    linesTruncated ||= wasTruncated;
                    const separator = current === lineNumber ? ":" : "-";
                    outputLines.push(`${relativePath}${separator}${current}${separator} ${text}`);
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
