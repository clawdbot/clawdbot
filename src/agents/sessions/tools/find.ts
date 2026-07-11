import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
/**
 * Built-in find session tool.
 *
 * Searches files by glob through fd/local operations and returns bounded, renderable results.
 */
import { toPosixPath } from "../../../shared/ignore-rules.js";
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
import type { FindToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";

function isInsideGitRepository(searchPath: string): boolean {
  for (let current = searchPath; ;) {
    if (existsSync(path.join(current, ".git"))) {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

const findSchema = Type.Object({
  pattern: Type.String({
    description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
  }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in (default: current directory)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});
export type { FindToolDetails, FindToolInput } from "./tool-contracts.js";

const DEFAULT_LIMIT = 1000;

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Find files matching glob pattern. Returns relative or absolute paths. */
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
  exists: existsSync,
  // This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
  glob: () => [],
};

export interface FindToolOptions {
  /** Custom operations for find. Default: local filesystem plus fd */
  operations?: FindOperations;
}

function formatFindCall(
  args: { pattern: string; path?: string; limit?: number } | undefined,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
  const pattern = str(args?.pattern);
  const rawPath = str(args?.path);
  const pathLocal = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const limit = args?.limit;
  const invalidArg = invalidArgText(theme);
  let text =
    theme.fg("toolTitle", theme.bold("find")) +
    " " +
    (pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
    theme.fg("toolOutput", ` in ${pathLocal === null ? invalidArg : pathLocal}`);
  if (limit !== undefined) {
    text += theme.fg("toolOutput", ` (limit ${limit})`);
  }
  return text;
}

function formatFindResult(
  result: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: FindToolDetails;
  },
  options: ToolRenderResultOptions,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
  showImages: boolean,
): string {
  const resultLimit = result.details?.resultLimitReached;
  return appendSessionToolTruncationWarning(
    formatSessionToolOutput(result, options, theme, showImages, 20),
    theme,
    {
      limit: resultLimit ? { count: resultLimit, noun: "results" } : undefined,
      truncation: result.details?.truncation,
    },
  );
}

function buildFindResult(params: {
  relativized: string[];
  effectiveLimit: number;
  limitNotice: string;
}): {
  content: Array<{ type: "text"; text: string }>;
  details: FindToolDetails | undefined;
} {
  const resultLimitReached = params.relativized.length >= params.effectiveLimit;
  const rawOutput = params.relativized.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let resultOutput = truncation.content;
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (resultLimitReached) {
    notices.push(params.limitNotice);
    details.resultLimitReached = params.effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) {
    resultOutput += `\n\n[${notices.join(". ")}]`;
  }
  return {
    content: [{ type: "text", text: resultOutput }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

export function createFindToolDefinition(
  cwd: string,
  options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
  const customOps = options?.operations;
  return {
    name: "find",
    label: "find",
    description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    parameters: findSchema,
    async execute(
      toolCallId,
      { pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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

        let settled = false;
        let stopChild: (() => void) | undefined;
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          stopChild = undefined;
          fn();
        };
        const onAbort = () => {
          stopChild?.();
          settle(() => reject(new Error("Operation aborted")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const effectiveLimit = normalizePositiveLimit(limit, DEFAULT_LIMIT);
            const ops = customOps ?? defaultFindOperations;

            // If custom operations provide glob(), use that instead of fd.
            if (customOps?.glob) {
              if (!(await ops.exists(searchPath))) {
                settle(() => reject(new Error(`Path not found: ${searchPath}`)));
                return;
              }
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const results = await ops.glob(pattern, searchPath, {
                ignore: ["**/node_modules/**", "**/.git/**"],
                limit: effectiveLimit,
              });
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              if (results.length === 0) {
                settle(() =>
                  resolve({
                    content: [{ type: "text", text: "No files found matching pattern" }],
                    details: undefined,
                  }),
                );
                return;
              }

              // Relativize paths against the search root for stable output.
              const relativized = results.map((p) => {
                if (p.startsWith(searchPath)) {
                  return toPosixPath(p.slice(searchPath.length + 1));
                }
                return toPosixPath(path.relative(searchPath, p));
              });
              settle(() =>
                resolve(
                  buildFindResult({
                    relativized,
                    effectiveLimit,
                    limitNotice: `${effectiveLimit} results limit reached`,
                  }),
                ),
              );
              return;
            }

            // Default implementation uses fd.
            const fdPath = await ensureTool("fd", true);
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            if (!fdPath) {
              settle(() => reject(new Error("fd is not available and could not be downloaded")));
              return;
            }

            const args: string[] = ["--glob", "--color=never", "--hidden"];
            // Outside a repo, fd needs this flag to honor standalone ignore files.
            // Inside a repo, default git-aware traversal preserves nested repo boundaries.
            if (!isInsideGitRepository(searchPath)) {
              args.push("--no-require-git");
            }
            args.push("--max-results", String(effectiveLimit));

            // fd --glob matches against the basename unless --full-path is set; in --full-path
            // mode it matches against the absolute candidate path, so a path-containing
            // pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
            let effectivePattern = pattern;
            if (pattern.includes("/")) {
              args.push("--full-path");
              if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
                effectivePattern = `**/${pattern}`;
              }
            }
            args.push("--", effectivePattern, searchPath);

            const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const rl = createInterface({ input: child.stdout });
            let stderr = "";
            const lines: string[] = [];

            stopChild = () => {
              if (!child.killed) {
                child.kill();
              }
            };

            const cleanup = () => {
              rl.close();
            };
            const onStreamError = (stream: "stdout" | "stderr", error: Error) => {
              if (settled) {
                return;
              }
              stopChild?.();
              cleanup();
              settle(() => reject(new Error(`fd ${stream} error: ${error.message}`)));
            };

            child.stderr?.on("data", (chunk) => {
              stderr = appendBoundedTextTail(stderr, chunk);
            });
            // Readline re-emits input failures, while the stream listener also catches
            // implementations that do not. settle() keeps the shared failure path one-shot.
            rl.on("error", (error) => onStreamError("stdout", error));
            child.stdout?.on("error", (error) => onStreamError("stdout", error));
            child.stderr?.on("error", (error) => onStreamError("stderr", error));

            rl.on("line", (line) => {
              lines.push(line);
            });

            child.on("error", (error) => {
              cleanup();
              settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
            });

            child.on("close", (code) => {
              cleanup();
              if (signal?.aborted) {
                settle(() => reject(new Error("Operation aborted")));
                return;
              }
              const output = lines.join("\n");
              if (code !== 0) {
                const errorMsg = stderr.trim() || `fd exited with code ${code}`;
                settle(() => reject(new Error(errorMsg)));
                return;
              }
              if (!output) {
                settle(() =>
                  resolve({
                    content: [{ type: "text", text: "No files found matching pattern" }],
                    details: undefined,
                  }),
                );
                return;
              }

              const relativized: string[] = [];
              for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, "").trim();
                if (!line) {
                  continue;
                }
                const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
                let relativePath;
                if (line.startsWith(searchPath)) {
                  relativePath = line.slice(searchPath.length + 1);
                } else {
                  relativePath = path.relative(searchPath, line);
                }
                if (hadTrailingSlash && !relativePath.endsWith("/")) {
                  relativePath += "/";
                }
                relativized.push(toPosixPath(relativePath));
              }

              settle(() =>
                resolve(
                  buildFindResult({
                    relativized,
                    effectiveLimit,
                    limitNotice: `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
                  }),
                ),
              );
            });
          } catch (e) {
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            const error = e instanceof Error ? e : new Error(String(e));
            settle(() => reject(error));
          }
        })();
      });
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatFindCall(args, theme));
      return text;
    },
    renderResult(result, optionsLocal, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatFindResult(result, optionsLocal, theme, context.showImages));
      return text;
    },
  };
}

export function createFindTool(
  cwd: string,
  options?: FindToolOptions,
): AgentTool<typeof findSchema> {
  return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
