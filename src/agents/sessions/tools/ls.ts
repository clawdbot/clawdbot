/**
 * Built-in ls session tool.
 *
 * Lists directory entries through local or injected operations with bounded output rendering.
 */
import { readdir } from "node:fs/promises";
import { Type } from "typebox";
import type { DirectoryEntry } from "../../../infra/directory-entries.js";
import { toErrorObject } from "../../../infra/errors.js";
import type { AgentTool } from "../../runtime/index.js";
import { toolResultFitsBudget, type ToolResultBudget } from "../../tool-result-limits.js";
import type { ToolDefinition } from "../extensions/types.js";
import { normalizePositiveLimit } from "./limits.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";
import {
  formatSessionToolOutput,
  invalidArgText,
  reuseTextComponent,
  shortenPath,
  str,
} from "./render-utils.js";
import type { LsToolDetails, LsToolInput } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory; default cwd." })),
  limit: Type.Optional(Type.Number({ description: "Max entries; default 500." })),
  after: Type.Optional(
    Type.String({ description: "Filename cursor returned by the previous page." }),
  ),
});
const DEFAULT_LIMIT = 500;

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
  readDirectory: (
    absolutePath: string,
    signal?: AbortSignal,
  ) => Promise<DirectoryEntry[]> | DirectoryEntry[];
}

const defaultLsOperations: LsOperations = {
  readDirectory: async (absolutePath) =>
    (await readdir(absolutePath, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
};

export interface LsToolOptions {
  /** Custom operations for directory listing. Default: local filesystem */
  operations?: LsOperations;
  modelBudget?: ToolResultBudget;
}

function formatLsCall(
  args: LsToolInput | undefined,
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
  if (args?.after !== undefined) {
    text += theme.fg("toolOutput", ` (after ${JSON.stringify(args.after)})`);
  }
  return text;
}

function formatLsContinuation(after: string): string {
  return `\n\n[More entries. Continue with the same path and after=${JSON.stringify(after)}.]`;
}

export function createLsToolDefinition(
  cwd: string,
  options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails> {
  const ops = options?.operations ?? defaultLsOperations;
  const resolvePath = options?.operations ? resolveToCwd : resolveLocalPathToCwd;
  return {
    name: "ls",
    label: "ls",
    description:
      "List directory entries in binary filename order, including dotfiles and links. Names are JSON-quoted; / marks actual directories. Pass the returned after cursor with the same path to continue.",
    promptSnippet: "List directory contents",
    parameters: lsSchema,
    async execute(
      toolCallId,
      { path, limit, after }: LsToolInput,
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
          const directoryEntries = await ops.readDirectory(dirPath, signal);
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          const entries = directoryEntries
            .filter((entry) => after === undefined || entry.name > after)
            .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          if (entries.length === 0) {
            return {
              content: [{ type: "text" as const, text: "(empty directory)" }],
              details: { content: "(empty directory)" },
            };
          }
          const fitsPage = (text: string) =>
            Buffer.byteLength(text) <= DEFAULT_MAX_BYTES &&
            toolResultFitsBudget(text, options?.modelBudget);
          const lines: string[] = [];
          let content = "";
          for (const entry of entries) {
            if (lines.length >= effectiveLimit) {
              break;
            }
            const line = JSON.stringify(entry.name + (entry.isDirectory ? "/" : ""));
            const candidate = content ? `${content}\n${line}` : line;
            if (!fitsPage(candidate)) {
              break;
            }
            lines.push(line);
            content = candidate;
          }
          // Complete final pages need no footer. Reserve continuation only after
          // selection, and advance past only the entries that remain visible.
          while (lines.length > 0) {
            const nextAfter =
              lines.length < entries.length ? entries[lines.length - 1]!.name : undefined;
            const output =
              content + (nextAfter === undefined ? "" : formatLsContinuation(nextAfter));
            if (fitsPage(output)) {
              return {
                content: [{ type: "text" as const, text: output }],
                details: { content: output, ...(nextAfter === undefined ? {} : { nextAfter }) },
              };
            }
            lines.pop();
            content = lines.join("\n");
          }
          throw new Error("A directory entry cannot fit within the listing output budget.");
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
      const content = formatSessionToolOutput(result, optionsLocal, theme, context.showImages, 20);
      return reuseTextComponent(context.lastComponent, content);
    },
  };
}

export function createLsTool(
  cwd: string,
  options?: LsToolOptions,
): AgentTool<typeof lsSchema, LsToolDetails> {
  return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
