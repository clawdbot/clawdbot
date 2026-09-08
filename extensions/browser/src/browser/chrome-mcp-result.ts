// Parses Chrome MCP tool results and formats redacted tool failures.
import path from "node:path";
import {
  asNullableRecord,
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { toErrorObject } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { redactCdpUrl } from "./cdp.helpers.js";
import {
  CHROME_CONNECTION_TOOL_ERROR_RE,
  DEVTOOLS_ACTIVE_PORT_RE,
  STALE_SELECTED_PAGE_ERROR,
  type ChromeMcpStructuredPage,
  type ChromeMcpToolResult,
  type NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import {
  redactChromeMcpDiagnosticTextWithLocalPaths,
  redactChromeMcpProfileLabelForDiagnostic,
} from "./chrome-mcp-diagnostics.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asNullableRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: readStringValue(record.url),
      selected: record.selected === true,
    });
  }
  return out;
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asNullableRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asNullableRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: normalizeOptionalString(match[2]),
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

export function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function normalizeSnapshotFields(record: Record<string, unknown>): ChromeMcpSnapshotNode {
  const snapshotValue = record.value;
  return {
    id: readStringValue(record.id),
    role: readStringValue(record.role),
    name: readStringValue(record.name),
    ...(typeof snapshotValue === "string" ||
    typeof snapshotValue === "number" ||
    typeof snapshotValue === "boolean"
      ? { value: snapshotValue }
      : {}),
    description: readStringValue(record.description),
  };
}

function normalizeSnapshotNode(value: unknown): ChromeMcpSnapshotNode | null {
  const rootRecord = asNullableRecord(value);
  if (!rootRecord) {
    return null;
  }
  const root = normalizeSnapshotFields(rootRecord);
  const pending = [{ record: rootRecord, node: root }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !Array.isArray(current.record.children)) {
      continue;
    }
    const children: ChromeMcpSnapshotNode[] = [];
    for (const child of current.record.children) {
      const record = asNullableRecord(child);
      if (!record) {
        continue;
      }
      const node = normalizeSnapshotFields(record);
      children.push(node);
      pending.push({ record, node });
    }
    current.node.children = children;
  }
  return root;
}

export function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = normalizeSnapshotNode(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

export function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function formatChromeMcpEndpointForDiagnostic(browserUrl: string): string {
  return redactToolPayloadText(redactCdpUrl(browserUrl) ?? browserUrl);
}

export function formatChromeMcpToolErrorMessage(params: {
  profileName: string;
  options: NormalizedChromeMcpProfileOptions;
  toolName: string;
  message: string;
}): string {
  const detail = redactChromeMcpDiagnosticTextWithLocalPaths(params.message);
  const profileLabel = redactChromeMcpProfileLabelForDiagnostic(params.profileName);
  if (params.options.browserUrl && CHROME_CONNECTION_TOOL_ERROR_RE.test(params.message)) {
    return (
      `Chrome MCP tool "${params.toolName}" failed for profile "${profileLabel}" while using ` +
      `the configured Chrome endpoint (${formatChromeMcpEndpointForDiagnostic(params.options.browserUrl)}). ` +
      `Details: ${detail}`
    );
  }
  if (
    !params.options.browserUrl &&
    params.options.userDataDir &&
    DEVTOOLS_ACTIVE_PORT_RE.test(params.message)
  ) {
    const cdpUrlPath = path.isAbsolute(params.profileName)
      ? "this existing-session profile's cdpUrl"
      : `browser.profiles.${params.profileName}.cdpUrl`;
    return (
      `${detail} If this browser was started with --remote-debugging-port, set ${cdpUrlPath} ` +
      "to that DevTools endpoint instead of relying on Chrome MCP auto-connect."
    );
  }
  return detail;
}

export function shouldReconnectForToolError(name: string, message: string): boolean {
  return name === "list_pages" && message.includes(STALE_SELECTED_PAGE_ERROR);
}

export function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      // MCP fence delimiters occupy lines; backticks inside JSON strings are data.
      const match = candidate.match(
        /^[\t ]*```json[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*```[\t ]*\r?$/im,
      );
      return JSON.parse(match?.[1]?.trim() || candidate.trim());
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw toErrorObject(lastError, "Non-Error thrown");
  }
  return null;
}
