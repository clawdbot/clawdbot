import type {
  ContentBlock,
  ImageContent,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import {
  hasNonEmptyString,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "../shared/string-coerce.js";
import { asRecord } from "./record-shared.js";

type GatewayAttachment = {
  type: string;
  mimeType: string;
  content: string;
};

const TOOL_LOCATION_PATH_KEYS = [
  "path",
  "filePath",
  "file_path",
  "targetPath",
  "target_path",
  "targetFile",
  "target_file",
  "sourcePath",
  "source_path",
  "destinationPath",
  "destination_path",
  "oldPath",
  "old_path",
  "newPath",
  "new_path",
  "outputPath",
  "output_path",
  "inputPath",
  "input_path",
] as const;

const TOOL_LOCATION_LINE_KEYS = [
  "line",
  "lineNumber",
  "line_number",
  "startLine",
  "start_line",
] as const;
const TOOL_RESULT_PATH_MARKER_RE = /^(?:FILE|MEDIA):(.+)$/gm;
const TOOL_LOCATION_MAX_DEPTH = 4;
const TOOL_LOCATION_MAX_NODES = 100;

const INLINE_CONTROL_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "\0": "\\0",
  "\r": "\\r",
  "\n": "\\n",
  "\t": "\\t",
  "\v": "\\v",
  "\f": "\\f",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function escapeInlineControlChars(value: string): string {
  let escaped = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      escaped += char;
      continue;
    }

    const isInlineControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (!isInlineControl) {
      escaped += char;
      continue;
    }

    const mapped = INLINE_CONTROL_ESCAPE_MAP[char];
    if (mapped) {
      escaped += mapped;
      continue;
    }

    // Keep escaped control bytes readable and stable in logs/prompts.
    escaped +=
      codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, "0")}`
        : `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

function escapeResourceTitle(value: string): string {
  // Keep title content, but escape characters that can break the resource-link annotation shape.
  return escapeInlineControlChars(value).replace(/[()[\]]/g, (char) => `\\${char}`);
}

function normalizeToolLocationPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 4096 ||
    trimmed.includes("\u0000") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n")
  ) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return decodeURIComponent(parsed.pathname || "") || undefined;
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function normalizeToolLocationLine(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}

function extractToolLocationLine(record: Record<string, unknown>): number | undefined {
  for (const key of TOOL_LOCATION_LINE_KEYS) {
    const line = normalizeToolLocationLine(record[key]);
    if (line !== undefined) {
      return line;
    }
  }
  return undefined;
}

function addToolLocation(
  locations: Map<string, ToolCallLocation>,
  rawPath: string,
  line?: number,
): void {
  const path = normalizeToolLocationPath(rawPath);
  if (!path) {
    return;
  }
  for (const [existingKey, existing] of locations.entries()) {
    if (existing.path !== path) {
      continue;
    }
    if (line === undefined || existing.line === line) {
      return;
    }
    if (existing.line === undefined) {
      locations.delete(existingKey);
    }
  }
  const locationKey = `${path}:${line ?? ""}`;
  if (locations.has(locationKey)) {
    return;
  }
  locations.set(locationKey, line ? { path, line } : { path });
}

function collectLocationsFromTextMarkers(
  text: string,
  locations: Map<string, ToolCallLocation>,
): void {
  for (const match of text.matchAll(TOOL_RESULT_PATH_MARKER_RE)) {
    const candidate = normalizeOptionalString(match[1]);
    if (candidate) {
      addToolLocation(locations, candidate);
    }
  }
}

function collectToolLocations(
  value: unknown,
  locations: Map<string, ToolCallLocation>,
  state: { visited: number },
  depth: number,
): void {
  if (state.visited >= TOOL_LOCATION_MAX_NODES || depth > TOOL_LOCATION_MAX_DEPTH) {
    return;
  }
  state.visited += 1;

  if (typeof value === "string") {
    collectLocationsFromTextMarkers(value, locations);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolLocations(item, locations, state, depth + 1);
      if (state.visited >= TOOL_LOCATION_MAX_NODES) {
        return;
      }
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const line = extractToolLocationLine(record);
  for (const key of TOOL_LOCATION_PATH_KEYS) {
    const rawPath = record[key];
    if (typeof rawPath === "string") {
      addToolLocation(locations, rawPath, line);
    }
  }

  const content = Array.isArray(record.content) ? record.content : undefined;
  if (content) {
    for (const block of content) {
      const entry = asRecord(block);
      if (entry?.type === "text" && typeof entry.text === "string") {
        collectLocationsFromTextMarkers(entry.text, locations);
      }
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (key === "content") {
      continue;
    }
    collectToolLocations(nested, locations, state, depth + 1);
    if (state.visited >= TOOL_LOCATION_MAX_NODES) {
      return;
    }
  }
}

export function extractTextFromPrompt(prompt: ContentBlock[], maxBytes?: number): string {
  const parts: string[] = [];
  // Track accumulated byte count per block to catch oversized prompts before full concatenation
  let totalBytes = 0;
  for (const block of prompt) {
    let blockText: string | undefined;
    if (block.type === "text") {
      blockText = block.text;
    } else if (block.type === "resource") {
      const resource = block.resource as { text?: string } | undefined;
      if (resource?.text) {
        blockText = resource.text;
      }
    } else if (block.type === "resource_link") {
      const title = block.title ? ` (${escapeResourceTitle(block.title)})` : "";
      const uri = block.uri ? escapeInlineControlChars(block.uri) : "";
      blockText = uri ? `[Resource link${title}] ${uri}` : `[Resource link${title}]`;
    }
    if (blockText !== undefined) {
      // Guard: reject before allocating the full concatenated string
      if (maxBytes !== undefined) {
        const separatorBytes = parts.length > 0 ? 1 : 0; // "\n" added by join() between blocks
        totalBytes += separatorBytes + Buffer.byteLength(blockText, "utf-8");
        if (totalBytes > maxBytes) {
          throw new Error(`Prompt exceeds maximum allowed size of ${maxBytes} bytes`);
        }
      }
      parts.push(blockText);
    }
  }
  return parts.join("\n");
}

export function extractAttachmentsFromPrompt(prompt: ContentBlock[]): GatewayAttachment[] {
  const attachments: GatewayAttachment[] = [];
  for (const block of prompt) {
    if (block.type !== "image") {
      continue;
    }
    const image = block as ImageContent;
    if (!image.data || !image.mimeType) {
      continue;
    }
    attachments.push({
      type: "image",
      mimeType: image.mimeType,
      content: image.data,
    });
  }
  return attachments;
}

export function formatToolTitle(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
): string {
  const base = name ?? "tool";
  if (!args || Object.keys(args).length === 0) {
    return base;
  }
  const parts = Object.entries(args).map(([key, value]) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const safe = raw.length > 100 ? `${raw.slice(0, 100)}...` : raw;
    return `${key}: ${safe}`;
  });
  // Sanitize at the source so session updates and permission requests never
  // inherit raw control bytes from untrusted tool arguments.
  return escapeInlineControlChars(`${base}: ${parts.join(", ")}`);
}

export function inferToolKind(name?: string): ToolKind {
  if (!name) {
    return "other";
  }
  const normalized = normalizeLowercaseStringOrEmpty(name);
  if (normalized.includes("read")) {
    return "read";
  }
  if (normalized.includes("write") || normalized.includes("edit")) {
    return "edit";
  }
  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }
  if (normalized.includes("move") || normalized.includes("rename")) {
    return "move";
  }
  if (normalized.includes("search") || normalized.includes("find")) {
    return "search";
  }
  if (normalized.includes("exec") || normalized.includes("run") || normalized.includes("bash")) {
    return "execute";
  }
  if (normalized.includes("fetch") || normalized.includes("http")) {
    return "fetch";
  }
  return "other";
}

export function extractToolCallContent(value: unknown): ToolCallContent[] | undefined {
  if (hasNonEmptyString(value)) {
    return value.trim()
      ? [
          {
            type: "content",
            content: {
              type: "text",
              text: value,
            },
          },
        ]
      : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const contents: ToolCallContent[] = [];
  const blocks = Array.isArray(record.content) ? record.content : [];
  for (const block of blocks) {
    const entry = asRecord(block);
    if (entry?.type === "text" && hasNonEmptyString(entry.text)) {
      contents.push({
        type: "content",
        content: {
          type: "text",
          text: entry.text,
        },
      });
    }
  }

  if (contents.length > 0) {
    return contents;
  }

  const fallbackText =
    readStringValue(record.text) ??
    readStringValue(record.message) ??
    readStringValue(record.error);

  if (!hasNonEmptyString(fallbackText)) {
    return undefined;
  }

  return [
    {
      type: "content",
      content: {
        type: "text",
        text: fallbackText,
      },
    },
  ];
}

export function extractToolCallLocations(...values: unknown[]): ToolCallLocation[] | undefined {
  const locations = new Map<string, ToolCallLocation>();
  for (const value of values) {
    collectToolLocations(value, locations, { visited: 0 }, 0);
  }
  return locations.size > 0 ? [...locations.values()] : undefined;
}
