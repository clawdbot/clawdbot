// Parses Chrome MCP tool results and formats redacted tool failures.
import path from "node:path";
import {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { toErrorObject } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { asRecord } from "../record-shared.js";
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
    const record = asRecord(entry);
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
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
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

export function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
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
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw toErrorObject(lastError, "Non-Error thrown");
  }
  return null;
}
