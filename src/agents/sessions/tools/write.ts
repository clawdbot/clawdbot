/**
 * Built-in write session tool.
 *
 * Writes files through queued local or injected operations with readback/idempotency metadata.
 */
import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { getLanguageFromPath, highlightCode } from "../../modes/interactive/theme/theme.js";
import type { AgentTool } from "../../runtime/index.js";
import { textResult } from "../../tools/common.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import {
  invalidArgText,
  normalizeDisplayText,
  replaceTabs,
  shortenPath,
  str,
} from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const writeSchema = Type.Object({
  path: Type.String({
    description: "File path; relative/absolute.",
  }),
  content: Type.String({ description: "File content." }),
});
export type { WriteToolInput } from "./tool-contracts.js";

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Create directory recursively */
  mkdir: (dir: string) => Promise<void>;
  /** Optional readback used to recover when a write succeeded but the tool aborted before returning */
  readFile?: (absolutePath: string) => Promise<Buffer | string>;
  /** Optional stat used to avoid reporting success for files that already matched before execution */
  statFile?: (absolutePath: string) => Promise<WriteToolFileStat | null>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
  readFile: (path) => fsReadFile(path),
  statFile: async (path) => {
    try {
      const stat = await fsStat(path);
      return {
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } as const;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  },
};

export interface WriteToolOptions {
  /** Custom operations for file writing. Default: local filesystem */
  operations?: WriteOperations;
}

type WriteToolFileStat = {
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs?: number;
};

type WriteToolPrecheck = {
  state: "different" | "same" | "unknown";
  beforeStat?: WriteToolFileStat | null;
};

const WRITE_PRECHECK_READ_LIMIT_BYTES = 1024 * 1024;

type WriteHighlightCache = {
  rawPath: string | null;
  lang: string;
  rawContent: string;
  normalizedLines: string[];
  highlightedLines: string[];
};

class WriteCallRenderComponent extends Text {
  cache?: WriteHighlightCache;

  constructor() {
    super("", 0, 0);
  }
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
  const highlighted = highlightCode(line, lang);
  return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
  const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
  if (prefixCount === 0) {
    return;
  }
  const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
  const prefixHighlighted = highlightCode(prefixSource, cache.lang);
  for (let i = 0; i < prefixCount; i++) {
    cache.highlightedLines[i] =
      prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
  }
}

function rebuildWriteHighlightCacheFull(
  rawPath: string | null,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) {
    return undefined;
  }
  const displayContent = normalizeDisplayText(fileContent);
  const normalized = replaceTabs(displayContent);
  return {
    rawPath,
    lang,
    rawContent: fileContent,
    normalizedLines: normalized.split("\n"),
    highlightedLines: highlightCode(normalized, lang),
  };
}

function updateWriteHighlightCacheIncremental(
  cache: WriteHighlightCache | undefined,
  rawPath: string | null,
  fileContent: string,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) {
    return undefined;
  }
  if (!cache) {
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  }
  if (cache.lang !== lang || cache.rawPath !== rawPath) {
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  }
  if (!fileContent.startsWith(cache.rawContent)) {
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  }
  if (fileContent.length === cache.rawContent.length) {
    return cache;
  }

  const deltaRaw = fileContent.slice(cache.rawContent.length);
  const deltaDisplay = normalizeDisplayText(deltaRaw);
  const deltaNormalized = replaceTabs(deltaDisplay);
  cache.rawContent = fileContent;
  if (cache.normalizedLines.length === 0) {
    cache.normalizedLines.push("");
    cache.highlightedLines.push("");
  }

  const segments = deltaNormalized.split("\n");
  const lastIndex = cache.normalizedLines.length - 1;
  const firstSegment = segments.at(0);
  const currentLastLine = cache.normalizedLines.at(lastIndex);
  if (firstSegment === undefined || currentLastLine === undefined) {
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  }
  cache.normalizedLines[lastIndex] = currentLastLine + firstSegment;
  cache.highlightedLines[lastIndex] = highlightSingleLine(
    cache.normalizedLines[lastIndex],
    cache.lang,
  );
  for (const segment of segments.slice(1)) {
    cache.normalizedLines.push(segment);
    cache.highlightedLines.push(highlightSingleLine(segment, cache.lang));
  }
  refreshWriteHighlightPrefix(cache);
  return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}

function formatWriteCall(
  args: { path?: string; file_path?: string; content?: string } | undefined,
  options: ToolRenderResultOptions,
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
  cache: WriteHighlightCache | undefined,
): string {
  const rawPath = str(args?.file_path ?? args?.path);
  const fileContent = str(args?.content);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  const invalidArg = invalidArgText(theme);
  let text = `${theme.fg("toolTitle", theme.bold("write"))} ${path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...")}`;

  if (fileContent === null) {
    text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
  } else if (fileContent) {
    const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
    const renderedLines = lang
      ? (cache?.highlightedLines ??
        highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
      : normalizeDisplayText(fileContent).split("\n");
    const lines = trimTrailingEmptyLines(renderedLines);
    const totalLines = lines.length;
    const maxLines = options.expanded ? lines.length : 10;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
    }
  }

  return text;
}

function formatWriteResult(
  result: {
    content: Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    isError?: boolean;
  },
  theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string | undefined {
  if (!result.isError) {
    return undefined;
  }
  const output = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
  if (!output) {
    return undefined;
  }
  return `\n${theme.fg("error", output)}`;
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return true;
  }
  return error instanceof Error && error.message.includes("No such file or directory");
}

async function readOriginalWriteState(
  absolutePath: string,
  content: string,
  ops: WriteOperations,
): Promise<WriteToolPrecheck> {
  if (!ops.statFile) {
    return { state: "unknown" };
  }
  let stat: WriteToolFileStat | null;
  try {
    stat = await ops.statFile(absolutePath);
  } catch (error) {
    return { state: isMissingFileError(error) ? "different" : "unknown" };
  }
  if (!stat) {
    return { state: "different", beforeStat: stat };
  }
  if (stat.type !== "file") {
    return { state: "unknown", beforeStat: stat };
  }
  if (stat.size !== Buffer.byteLength(content, "utf8")) {
    return { state: "different", beforeStat: stat };
  }
  if (!ops.readFile || stat.size > WRITE_PRECHECK_READ_LIMIT_BYTES) {
    return { state: "unknown", beforeStat: stat };
  }

  try {
    const originalContent = await ops.readFile(absolutePath);
    const originalText = Buffer.isBuffer(originalContent)
      ? originalContent.toString("utf8")
      : originalContent;
    return {
      state: originalText === content ? "same" : "different",
      beforeStat: stat,
    };
  } catch {
    return { state: "unknown", beforeStat: stat };
  }
}

async function didWriteMetadataChange(
  absolutePath: string,
  beforeStat: WriteToolFileStat | null | undefined,
  ops: WriteOperations,
): Promise<boolean> {
  if (!beforeStat || !ops.statFile) {
    return false;
  }
  const afterStat = await ops.statFile(absolutePath).catch(() => null);
  if (!afterStat || afterStat.type !== "file") {
    return false;
  }
  return afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs;
}

function isWriteRecoveryCandidate(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function successfulWriteResult(path: string, content: string) {
  return textResult(
    `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
    undefined,
  );
}

async function recoverSuccessfulWrite(params: {
  absolutePath: string;
  content: string;
  error: unknown;
  ops: WriteOperations;
  path: string;
  precheck: WriteToolPrecheck;
  signal?: AbortSignal;
}) {
  if (!params.ops.readFile || !isWriteRecoveryCandidate(params.error, params.signal)) {
    return null;
  }
  const readback = await params.ops.readFile(params.absolutePath).catch(() => undefined);
  const currentContent = Buffer.isBuffer(readback) ? readback.toString("utf8") : readback;
  const changed =
    params.precheck.state === "different" ||
    (params.precheck.state === "unknown" &&
      (await didWriteMetadataChange(params.absolutePath, params.precheck.beforeStat, params.ops)));
  if (currentContent !== params.content || !changed) {
    return null;
  }
  return successfulWriteResult(params.path, params.content);
}

export function createWriteToolDefinition(
  cwd: string,
  options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
  const ops = options?.operations ?? defaultWriteOperations;
  return {
    name: "write",
    label: "write",
    description: "Write/overwrite file; creates parent directories.",
    promptSnippet: "Create/overwrite files",
    promptGuidelines: ["Use only new files/complete rewrites."],
    parameters: writeSchema,
    async execute(
      toolCallId,
      { path, content }: { path: string; content: string },
      signal?: AbortSignal,
      onUpdate?,
      ctx?,
    ) {
      void toolCallId;
      void onUpdate;
      void ctx;
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);
      return withFileMutationQueue(absolutePath, async () => {
        const precheck = await readOriginalWriteState(absolutePath, content, ops);
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        // Terminal no-op: file already has identical content.
        if (precheck.state === "same") {
          return {
            ...textResult(
              `No changes made to ${path}. The file already has identical content.`,
              undefined,
            ),
            terminate: true,
          };
        }
        try {
          await ops.mkdir(dir);
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          await ops.writeFile(absolutePath, content);
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          return successfulWriteResult(path, content);
        } catch (error: unknown) {
          const recovered = await recoverSuccessfulWrite({
            absolutePath,
            content,
            error,
            ops,
            path,
            precheck,
            signal,
          });
          if (recovered) {
            return recovered;
          }
          throw error;
        }
      });
    },
    renderCall(args, theme, context) {
      const renderArgs = args as
        | { path?: string; file_path?: string; content?: string }
        | undefined;
      const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
      const fileContent = str(renderArgs?.content);
      const component =
        (context.lastComponent as WriteCallRenderComponent | undefined) ??
        new WriteCallRenderComponent();
      if (fileContent !== null) {
        component.cache = context.argsComplete
          ? rebuildWriteHighlightCacheFull(rawPath, fileContent)
          : updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
      } else {
        component.cache = undefined;
      }
      component.setText(
        formatWriteCall(
          renderArgs,
          { expanded: context.expanded, isPartial: context.isPartial },
          theme,
          component.cache,
        ),
      );
      return component;
    },
    renderResult(result, optionsLocal, theme, context) {
      void optionsLocal;
      const output = formatWriteResult({ ...result, isError: context.isError }, theme);
      if (!output) {
        const component = (context.lastComponent as Container | undefined) ?? new Container();
        component.clear();
        return component;
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(output);
      return text;
    },
  };
}

export function createWriteTool(
  cwd: string,
  options?: WriteToolOptions,
): AgentTool<typeof writeSchema> {
  return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
