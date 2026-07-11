import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { toErrorObject } from "../../../infra/errors.js";
import { decodeWindowsTextFileBuffer } from "../../../infra/windows-encoding.js";
import type { ImageContent, Model, TextContent } from "../../../llm/types.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
  resolveMediaReferenceLocalPath,
} from "../../../media/media-reference.js";
/**
 * Built-in read session tool.
 *
 * Reads text and image files through local or injected operations with highlighting, resizing, and bounded output.
 */
import { toPosixPath } from "../../../shared/ignore-rules.js";
import { getReadmePath } from "../../config.js";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.js";
import {
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "../../modes/interactive/theme/theme.js";
import type { AgentTool } from "../../runtime/index.js";
import { processImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { normalizePositiveLimit } from "./limits.js";
import { resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.js";
import type { ReadToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});
export type { ReadToolDetails, ReadToolInput } from "./tool-contracts.js";

interface CompactReadClassification {
  kind: "docs" | "resource" | "skill";
  label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
  /** Resolve a user-supplied path for this read backend. */
  resolvePath?: (filePath: string, cwd: string) => string | Promise<string>;
  /** Decode text bytes for this backend. Custom backends default to UTF-8. */
  decodeText?: (params: { buffer: Buffer; absolutePath: string }) => string;
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if file is readable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
  /** Detect image MIME type, return null or undefined for non-images */
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  resolvePath: resolveLocalReadPath,
  decodeText: ({ buffer }) => decodeWindowsTextFileBuffer({ buffer }),
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
  /** Whether to auto-resize images to 2000x2000 max. Default: true */
  autoResizeImages?: boolean;
  /** Custom operations for file reading. Default: local filesystem */
  operations?: ReadOperations;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
  if (args?.offset === undefined && args?.limit === undefined) {
    return "";
  }
  const startLine = args.offset ?? 1;
  const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
  return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme): string {
  const rawPath = str(args?.file_path ?? args?.path);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  const invalidArg = invalidArgText(theme);
  const pathDisplay =
    path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
  return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}

function getNonVisionImageNote(model: Model | undefined): string | undefined {
  if (!model || model.input.includes("image")) {
    return undefined;
  }
  return "[Current model does not support images. The image will be omitted from this request.]";
}

function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function getOpenClawDocsClassification(
  absolutePath: string,
): CompactReadClassification | undefined {
  const packageRoot = dirname(getReadmePath());
  const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  const label = toPosixPath(relativePath);
  if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
    return { kind: "docs", label };
  }
  return undefined;
}

function getCompactReadClassification(
  args: ReadRenderArgs | undefined,
  cwd: string,
): CompactReadClassification | undefined {
  const rawPath = str(args?.file_path ?? args?.path);
  if (!rawPath) {
    return undefined;
  }

  const absolutePath = resolveReadPath(rawPath, cwd);
  const fileName = basename(absolutePath);
  if (fileName === "SKILL.md") {
    return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
  }

  const docsClassification = getOpenClawDocsClassification(absolutePath);
  if (docsClassification) {
    return docsClassification;
  }

  if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
  }

  return undefined;
}

async function resolveLocalReadPath(filePath: string, cwd: string): Promise<string> {
  const normalizedMediaSource = normalizeMediaReferenceSource(filePath);
  if (classifyMediaReferenceSource(normalizedMediaSource).isMediaStoreUrl) {
    return await resolveMediaReferenceLocalPath(normalizedMediaSource);
  }
  return resolveReadPath(filePath, cwd);
}

async function resolveReadToolPath(
  ops: ReadOperations,
  filePath: string,
  cwd: string,
): Promise<string> {
  return await (ops.resolvePath?.(filePath, cwd) ?? resolveReadPath(filePath, cwd));
}

function formatCompactReadCall(
  classification: CompactReadClassification,
  args: ReadRenderArgs | undefined,
  theme: Theme,
): string {
  const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
  if (classification.kind === "skill") {
    return (
      theme.fg("customMessageLabel", `\u001b[1m[skill]\u001b[22m `) +
      theme.fg("customMessageText", classification.label) +
      formatReadLineRange(args, theme) +
      expandHint
    );
  }

  return (
    theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
    " " +
    theme.fg("accent", classification.label) +
    formatReadLineRange(args, theme) +
    expandHint
  );
}

function formatReadResult(
  args: ReadRenderArgs | undefined,
  result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
  options: ToolRenderResultOptions,
  theme: Theme,
  showImages: boolean,
  cwd: string,
  isError: boolean,
): string {
  if (!options.expanded && !isError && getCompactReadClassification(args, cwd)) {
    return "";
  }

  const rawPath = str(args?.file_path ?? args?.path);
  const output = getTextOutput(result, showImages);
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
  const lines = trimTrailingEmptyLines(renderedLines);
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }

  const truncation = result.details?.truncation;
  if (truncation?.truncated) {
    if (truncation.firstLineExceedsLimit) {
      text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
    } else {
      text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
    }
  }
  return text;
}

export function createReadToolDefinition(
  cwd: string,
  options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    async execute(
      toolCallId,
      { path, offset, limit }: { path: string; offset?: number; limit?: number },
      signal?: AbortSignal,
      onUpdate?,
      ctx?,
    ) {
      void toolCallId;
      void onUpdate;
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1)) {
        throw new Error("Offset must be an integer at least 1");
      }
      return new Promise<{
        content: (TextContent | ImageContent)[];
        details: ReadToolDetails | undefined;
      }>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        void (async () => {
          try {
            const absolutePath = await resolveReadToolPath(ops, path, cwd);
            // Check if file exists and is readable.
            await ops.access(absolutePath);
            if (aborted) {
              return;
            }
            const mimeType = ops.detectImageMimeType
              ? await ops.detectImageMimeType(absolutePath)
              : undefined;
            let content: (TextContent | ImageContent)[];
            let details: ReadToolDetails | undefined;
            const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
            if (mimeType) {
              // Read image as binary.
              const buffer = await ops.readFile(absolutePath);
              const base64 = buffer.toString("base64");
              const processed = await processImage(
                { type: "image", data: base64, mimeType },
                { autoResizeImages },
              );
              if (!processed.ok) {
                let textNote = `Read image file [${mimeType}]\n${processed.message}`;
                if (nonVisionImageNote) {
                  textNote += `\n${nonVisionImageNote}`;
                }
                content = [{ type: "text", text: textNote }];
              } else {
                let textNote = `Read image file [${processed.image.mimeType}]`;
                if (processed.hints.length > 0) {
                  textNote += `\n${processed.hints.join("\n")}`;
                }
                if (nonVisionImageNote) {
                  textNote += `\n${nonVisionImageNote}`;
                }
                content = [{ type: "text", text: textNote }, processed.image];
              }
            } else {
              // Read text content.
              const buffer = await ops.readFile(absolutePath);
              const textContent =
                ops.decodeText?.({ buffer, absolutePath }) ?? buffer.toString("utf8");
              const allLines = textContent.split("\n");
              const totalFileLines = allLines.length;
              // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
              const startLine = offset === undefined ? 0 : offset - 1;
              const startLineDisplay = startLine + 1;
              // Check if offset is out of bounds.
              if (startLine >= allLines.length) {
                throw new Error(
                  `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
                );
              }
              let selectedContent: string;
              let userLimitedLines: number | undefined;
              // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
              if (limit !== undefined) {
                const normalizedLimit = normalizePositiveLimit(limit, DEFAULT_MAX_LINES);
                const endLine = Math.min(startLine + normalizedLimit, allLines.length);
                selectedContent = allLines.slice(startLine, endLine).join("\n");
                userLimitedLines = endLine - startLine;
              } else {
                selectedContent = allLines.slice(startLine).join("\n");
              }
              // Apply truncation, respecting both line and byte limits.
              const truncation = truncateHead(selectedContent);
              let outputText: string;
              if (truncation.firstLineExceedsLimit) {
                // First line alone exceeds the byte limit. Point the model at a bash fallback.
                const firstLine = allLines.at(startLine);
                if (firstLine === undefined) {
                  throw new Error("Requested line is outside the file.");
                }
                const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf-8"));
                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${quotePosixShellArg(path)} | head -c ${DEFAULT_MAX_BYTES}]`;
                details = { truncation };
              } else if (truncation.truncated) {
                // Truncation occurred. Build an actionable continuation notice.
                const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                const nextOffset = endLineDisplay + 1;
                outputText = truncation.content;
                if (truncation.truncatedBy === "lines") {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                }
                details = { truncation };
              } else if (
                userLimitedLines !== undefined &&
                startLine + userLimitedLines < allLines.length
              ) {
                // User-specified limit stopped early, but the file still has more content.
                const remaining = allLines.length - (startLine + userLimitedLines);
                const nextOffset = startLine + userLimitedLines + 1;
                outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
              } else {
                // No truncation and no remaining user-limited content.
                outputText = truncation.content;
              }
              content = [{ type: "text", text: outputText }];
            }

            if (aborted) {
              return;
            }
            signal?.removeEventListener("abort", onAbort);
            resolve({ content, details });
          } catch (error: unknown) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) {
              reject(toErrorObject(error, "Non-Error rejection"));
            }
          }
        })();
      });
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const classification = !context.expanded
        ? getCompactReadClassification(args, context.cwd)
        : undefined;
      text.setText(
        classification
          ? formatCompactReadCall(classification, args, theme)
          : formatReadCall(args, theme),
      );
      return text;
    },
    renderResult(result, optionsLocal, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(
        formatReadResult(
          context.args,
          result,
          optionsLocal,
          theme,
          context.showImages,
          context.cwd,
          context.isError,
        ),
      );
      return text;
    },
  };
}

export function createReadTool(
  cwd: string,
  options?: ReadToolOptions,
): AgentTool<typeof readSchema> {
  return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
