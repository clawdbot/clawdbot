import { constants } from "node:fs";
import { access as fsAccess, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasErrnoCode, toErrorObject } from "../../../infra/errors.js";
import { readRegularFile } from "../../../infra/regular-file.js";
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
import { levenshteinDistance } from "../../../shared/levenshtein-distance.js";
import { getReadmePath } from "../../config.js";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.js";
import {
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "../../modes/interactive/theme/theme.js";
import type { AgentTool } from "../../runtime/index.js";
import { processImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeType } from "../../utils/mime.js";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { normalizePositiveLimit } from "./limits.js";
import { getReadPathVariants, resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.js";
import type { ReadToolDetails, ReadToolTruncationDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

const readSchema = Type.Object({
  path: Type.String({ description: "File path; relative/absolute." }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "Start line; 1-based." })),
  limit: Type.Optional(Type.Number({ description: "Max lines." })),
});

const ReadTruncationOutputSchema = Type.Object(
  {
    truncated: Type.Literal(true),
    truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes")]),
    totalLines: Type.Integer({ minimum: 0 }),
    totalBytes: Type.Integer({ minimum: 0 }),
    outputLines: Type.Integer({ minimum: 0 }),
    outputBytes: Type.Integer({ minimum: 0 }),
    lastLinePartial: Type.Boolean(),
    firstLineExceedsLimit: Type.Boolean(),
    maxLines: Type.Integer({ minimum: 1 }),
    maxBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const ReadToolOutputSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("text"), content: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("image"),
      content: Type.String(),
      mimeType: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("truncated"),
      content: Type.String(),
      truncation: ReadTruncationOutputSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("not_found"),
      status: Type.Literal("not_found"),
      path: Type.String(),
      optional: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
]);

function withoutTruncationContent(truncation: TruncationResult): ReadToolTruncationDetails {
  const { content: _content, ...details } = truncation;
  return details;
}

function createReadDetails(
  content: (TextContent | ImageContent)[],
  truncation?: TruncationResult,
): ReadToolDetails {
  const text = content.find((part): part is TextContent => part.type === "text")?.text ?? "";
  const image = content.find((part): part is ImageContent => part.type === "image");
  if (image) {
    return { kind: "image", content: text, mimeType: image.mimeType };
  }
  if (truncation) {
    return {
      kind: "truncated",
      content: text,
      truncation: withoutTruncationContent(truncation),
    };
  }
  return { kind: "text", content: text };
}

function normalizeReadError(error: unknown, filePath: string): Error {
  if (hasErrnoCode(error, "EISDIR")) {
    return new Error(
      `Read requires a file path, but ${filePath} is a directory. List the directory, then read a specific file.`,
    );
  }
  return toErrorObject(error, "Non-Error rejection");
}

function regularFileReadError(filePath: string): Error {
  return new Error(`Read only supports regular files; no read was attempted: ${filePath}`);
}

async function assertLocalReadableFile(filePath: string): Promise<void> {
  const stat = await fsStat(filePath);
  if (stat.isDirectory()) {
    throw Object.assign(new Error(`Read requires a file: ${filePath}`), { code: "EISDIR" });
  }
  if (!stat.isFile()) {
    throw regularFileReadError(filePath);
  }
  await fsAccess(filePath, constants.R_OK);
}

async function suggestLocalReadPaths(filePath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsReaddir(dirname(filePath));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return [];
    }
    throw error;
  }
  const requested = basename(filePath).toLowerCase();
  const maxDistance = Math.max(1, Math.floor(requested.length * 0.4));
  return entries
    .map((entry) => ({ entry, distance: levenshteinDistance(requested, entry.toLowerCase()) }))
    .filter(({ entry, distance }) => entry !== basename(filePath) && distance <= maxDistance)
    .toSorted(
      (left, right) => left.distance - right.distance || left.entry.localeCompare(right.entry),
    )
    .slice(0, 3)
    .map(({ entry }) => entry);
}

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
  detectImageMimeType?: (
    absolutePath: string,
    buffer: Buffer,
  ) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
  resolvePath: resolveLocalReadPath,
  decodeText: ({ buffer }) => decodeWindowsTextFileBuffer({ buffer }),
  readFile: async (filePath) => (await readRegularFile({ filePath })).buffer,
  access: assertLocalReadableFile,
};

async function detectReadImageMimeType(
  ops: ReadOperations,
  buffer: Buffer,
  absolutePath: string,
): Promise<string | null | undefined> {
  if (ops.detectImageMimeType) {
    return await ops.detectImageMimeType(absolutePath, buffer);
  }
  return detectSupportedImageMimeType(buffer);
}

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
  const normalizedLimit =
    args.limit !== undefined ? normalizePositiveLimit(args.limit, DEFAULT_MAX_LINES) : undefined;
  const endLine = normalizedLimit !== undefined ? startLine + normalizedLimit - 1 : "";
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
): Promise<{ absolutePath: string; note?: string }> {
  const absolutePath = await (ops.resolvePath?.(filePath, cwd) ?? resolveReadPath(filePath, cwd));
  try {
    await ops.access(absolutePath);
    return { absolutePath };
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
      throw error;
    }

    const matches: string[] = [];
    for (const candidate of getReadPathVariants(absolutePath)) {
      try {
        await ops.access(candidate);
        matches.push(candidate);
      } catch (candidateError) {
        if (!hasErrnoCode(candidateError, "ENOENT") && !hasErrnoCode(candidateError, "ENOTDIR")) {
          throw candidateError;
        }
      }
    }

    if (matches.length > 1) {
      throw new Error(
        `Read path is ambiguous: ${basename(absolutePath)} matches ${matches.map((match) => basename(match)).join(", ")}.`,
        { cause: error },
      );
    }
    const match = matches[0];
    if (match !== undefined) {
      return {
        absolutePath: match,
        note: `[Resolved filename: ${basename(absolutePath)} -> ${basename(match)}.]`,
      };
    }

    const suggestions =
      ops === defaultReadOperations ? await suggestLocalReadPaths(absolutePath) : [];
    const suggestion = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    throw Object.assign(
      new Error(`File not found: ${absolutePath}.${suggestion}`, { cause: error }),
      {
        code: "ENOENT",
      },
    );
  }
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

  const truncation = result.details?.kind === "truncated" ? result.details.truncation : undefined;
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
): ToolDefinition<typeof readSchema, ReadToolDetails> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  const ops = options?.operations ?? defaultReadOperations;
  return {
    name: "read",
    label: "read",
    description: `Read text/image file (jpg/png/gif/webp/bmp); images attach. Text caps ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Large/full file: continue offset/limit.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    outputSchema: ReadToolOutputSchema,
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
        details: ReadToolDetails;
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
            const { absolutePath, note } = await resolveReadToolPath(ops, path, cwd);
            if (aborted) {
              return;
            }
            const buffer = await ops.readFile(absolutePath);
            const mimeType = await detectReadImageMimeType(ops, buffer, absolutePath);
            let content: (TextContent | ImageContent)[];
            let truncationDetails: TruncationResult | undefined;
            const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
            if (mimeType) {
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
              const decodedText =
                ops.decodeText?.({ buffer, absolutePath }) ?? buffer.toString("utf8");
              const textContent = (
                decodedText.startsWith("\uFEFF") ? decodedText.slice(1) : decodedText
              ).replaceAll("\r\n", "\n");
              const allLines = textContent.split("\n");
              if (allLines.at(-1) === "") {
                allLines.pop();
              }
              const totalFileLines = allLines.length;
              // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
              const startLine = offset === undefined ? 0 : offset - 1;
              const startLineDisplay = startLine + 1;
              let outputText: string;
              if (totalFileLines === 0) {
                outputText =
                  buffer.length === 0
                    ? "File is empty (0 bytes)."
                    : `File contains no readable text (${buffer.length} bytes).`;
              } else if (startLine >= totalFileLines) {
                outputText = `Offset ${offset} is beyond end of file (${totalFileLines} lines total). Retry with offset <= ${totalFileLines}.`;
              } else {
                const endLine =
                  limit === undefined
                    ? totalFileLines
                    : Math.min(
                        startLine + normalizePositiveLimit(limit, DEFAULT_MAX_LINES),
                        totalFileLines,
                      );
                const selectedLines = allLines.slice(startLine, endLine);
                const userLimitedLines = limit === undefined ? undefined : endLine - startLine;
                if (selectedLines.every((line) => line.length === 0)) {
                  const selectedLineCount = selectedLines.length;
                  const subject =
                    startLine === 0 && endLine === totalFileLines ? "File" : "Selected range";
                  outputText = `${subject} contains ${selectedLineCount} blank line${selectedLineCount === 1 ? "" : "s"}.`;
                  if (userLimitedLines !== undefined && endLine < totalFileLines) {
                    const remaining = totalFileLines - endLine;
                    outputText += `\n\n[${remaining} more line${remaining === 1 ? "" : "s"} in file. Use offset=${endLine + 1} to continue.]`;
                  }
                } else {
                  let selectedContent = selectedLines.join("\n");
                  if (endLine === totalFileLines && textContent.endsWith("\n")) {
                    selectedContent += "\n";
                  }
                  const truncation = truncateHead(selectedContent);
                  if (truncation.firstLineExceedsLimit) {
                    const lineBreak = selectedContent.indexOf("\n");
                    const firstLine =
                      lineBreak === -1 ? selectedContent : selectedContent.slice(0, lineBreak);
                    const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf-8"));
                    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${quotePosixShellArg(path)} | head -c ${DEFAULT_MAX_BYTES}]`;
                    truncationDetails = { ...truncation, totalLines: totalFileLines };
                  } else if (truncation.truncated) {
                    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                    const nextOffset = endLineDisplay + 1;
                    outputText = truncation.content;
                    if (truncation.truncatedBy === "lines") {
                      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                    } else {
                      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                    }
                    truncationDetails = { ...truncation, totalLines: totalFileLines };
                  } else if (
                    userLimitedLines !== undefined &&
                    startLine + userLimitedLines < totalFileLines
                  ) {
                    const remaining = totalFileLines - (startLine + userLimitedLines);
                    const nextOffset = startLine + userLimitedLines + 1;
                    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
                  } else {
                    outputText = truncation.content;
                  }
                }
              }
              content = [{ type: "text", text: outputText }];
            }

            if (note && content[0]?.type === "text") {
              content = [
                { ...content[0], text: `${note}\n${content[0].text}` },
                ...content.slice(1),
              ];
            }

            if (aborted) {
              return;
            }
            signal?.removeEventListener("abort", onAbort);
            resolve({ content, details: createReadDetails(content, truncationDetails) });
          } catch (error: unknown) {
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) {
              reject(normalizeReadError(error, path));
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
