import { existsSync } from "node:fs";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runUtf8CommandWithTimeout, type SpawnResult } from "../../../process/exec.js";
/**
 * Built-in find session tool.
 *
 * Searches files by glob through fd/local operations and returns bounded, renderable results.
 */
import { normalizeNativePathSeparators } from "../../../shared/ignore-rules.js";
import type { AgentTool } from "../../runtime/index.js";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { normalizePositiveLimit, SESSION_TOOL_STDERR_TAIL_BYTES } from "./limits.js";
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
    description: "File glob, e.g. **/*.ts.",
  }),
  path: Type.Optional(Type.String({ description: "Search dir; default cwd." })),
  limit: Type.Optional(Type.Integer({ description: "Max results; default 1000." })),
});
const DEFAULT_LIMIT = 1000;
// fd can stall on a broken filesystem or network mount without exiting or
// emitting output. Bound the silence, not the total runtime: any stdout line
// or stderr chunk re-arms the timer, so a healthy long search keeps running
// and only a silent child is killed.
const FD_STALL_TIMEOUT_MS = 60_000;

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
  theme: typeof import("../../modes/interactive/theme/theme.js").interactiveAgentTheme,
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
  theme: typeof import("../../modes/interactive/theme/theme.js").interactiveAgentTheme,
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
  const resultLimitReached = params.relativized.length > params.effectiveLimit;
  const rawOutput = params.relativized.slice(0, params.effectiveLimit).join("\n");
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
    description: `Find by glob; paths relative to search dir. Respects .gitignore. Caps ${DEFAULT_LIMIT} results/${DEFAULT_MAX_BYTES / 1024}KB.`,
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
        const settle = (fn: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        // The runner owns killing the child once it is spawned (via this
        // signal); settlement only needs to stop listening and reject.
        const onAbort = () => {
          settle(() => reject(new Error("Operation aborted")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            if (Number.isFinite(limit) && !Number.isInteger(limit)) {
              settle(() => reject(new Error("Limit must be an integer")));
              return;
            }
            const searchPath = resolveToCwd(searchDir || ".", cwd);
            const effectiveLimit = normalizePositiveLimit(limit, DEFAULT_LIMIT);
            // One extra candidate distinguishes an exact-size result from a truncated one.
            const observationLimit = effectiveLimit + 1;
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
                limit: observationLimit,
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
              const relativized = results.slice(0, observationLimit).map((p) => {
                if (p.startsWith(searchPath)) {
                  return normalizeNativePathSeparators(p.slice(searchPath.length + 1));
                }
                return normalizeNativePathSeparators(path.relative(searchPath, p));
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
            args.push("--max-results", String(observationLimit));

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

            let result: SpawnResult;
            try {
              // The runner owns the child lifecycle: noOutputTimeoutMs re-arms
              // on every raw stdout/stderr chunk, so a healthy long search
              // keeps running and only a silent fd is killed. fd output is
              // bounded by --max-results, so buffering via the runner capture
              // is safe.
              result = await runUtf8CommandWithTimeout([fdPath, ...args], {
                noOutputTimeoutMs: FD_STALL_TIMEOUT_MS,
                signal,
                // A failed output stream must kill fd immediately, matching
                // the pre-refactor stopChild-on-error behavior; otherwise a
                // wedged child could outlive the tool call.
                terminateOnOutputError: true,
                // Keep the pre-refactor stderr bound; the runner default tail
                // is 16 MiB.
                maxOutputBytes: { stderr: SESSION_TOOL_STDERR_TAIL_BYTES },
              });
            } catch (error) {
              const outputErrorStream =
                error instanceof Error && "outputErrorStream" in error
                  ? error.outputErrorStream
                  : undefined;
              const message = error instanceof Error ? error.message : String(error);
              if (outputErrorStream === "stdout" || outputErrorStream === "stderr") {
                settle(() => reject(new Error(`fd ${outputErrorStream} error: ${message}`)));
              } else {
                settle(() => reject(new Error(`Failed to run fd: ${message}`)));
              }
              return;
            }
            if (settled) {
              return;
            }
            if (signal?.aborted) {
              settle(() => reject(new Error("Operation aborted")));
              return;
            }
            if (result.noOutputTimedOut) {
              settle(() =>
                reject(
                  new Error(
                    `fd timed out after ${FD_STALL_TIMEOUT_MS / 1000} seconds without output`,
                  ),
                ),
              );
              return;
            }
            if (result.outputErrorStream) {
              settle(() =>
                reject(new Error(`fd ${result.outputErrorStream} error: output stream failed`)),
              );
              return;
            }
            const lines = result.stdout.split("\n");
            const output = lines.join("\n");
            if (result.code !== 0) {
              const errorMsg = result.stderr.trim() || `fd exited with code ${result.code}`;
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
              relativized.push(normalizeNativePathSeparators(relativePath));
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
