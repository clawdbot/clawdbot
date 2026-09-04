// Chrome MCP stderr capture and redacted diagnostics.
import os from "node:os";
import path from "node:path";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createBoundedUtf8Tail, decodeBoundedUtf8Tail } from "./bounded-utf8-tail.js";
import { redactCdpErrorText } from "./cdp.helpers.js";
import { CHROME_MCP_STDERR_MAX_BYTES } from "./chrome-mcp-contracts.js";

export function decodeChromeMcpStderrTail(buffer: Buffer): string {
  return decodeBoundedUtf8Tail(buffer, CHROME_MCP_STDERR_MAX_BYTES).trim();
}
export function drainStderr(transport: StdioClientTransport): () => string {
  const stream = transport.stderr;
  if (!stream) {
    return () => "";
  }
  const tail = createBoundedUtf8Tail(CHROME_MCP_STDERR_MAX_BYTES);
  stream.on("data", (chunk: Buffer | string) => {
    tail.append(chunk);
  });
  stream.on("error", () => {});
  return () => tail.text().trim();
}

function redactChromeMcpDiagnosticText(text: string): string {
  return redactCdpErrorText(text);
}

export function redactChromeMcpDiagnosticTextWithLocalPaths(text: string): string {
  const homeDir = normalizeOptionalString(os.homedir());
  const homePath = homeDir ? path.resolve(homeDir) : undefined;
  const withHomeRedacted = homePath ? text.split(homePath).join("~") : text;
  return redactChromeMcpDiagnosticText(withHomeRedacted);
}

export function redactChromeMcpLocalPathForDiagnostic(filePath: string): string {
  const homeDir = normalizeOptionalString(os.homedir());
  if (!homeDir || !path.isAbsolute(filePath)) {
    return redactChromeMcpDiagnosticText(filePath);
  }

  const relative = path.relative(path.resolve(homeDir), path.resolve(filePath));
  if (relative === "") {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return redactChromeMcpDiagnosticText(`~/${relative.split(path.sep).join("/")}`);
  }
  return redactChromeMcpDiagnosticText(filePath);
}

export function redactChromeMcpProfileLabelForDiagnostic(profileName: string): string {
  return path.isAbsolute(profileName)
    ? redactChromeMcpLocalPathForDiagnostic(profileName)
    : redactChromeMcpDiagnosticText(profileName);
}
