// Parse and bound JSON object inputs for `openclaw mcp call`.
import fs from "node:fs/promises";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringifiedOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

const MCP_CALL_INPUT_MAX_BYTES = 1024 * 1024;

// Typed so the caller can tell an overflow from an ordinary read failure without
// matching on error text, which a file path or fs message could otherwise spoof.
class McpCallInputTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`MCP call input exceeds ${maxBytes} bytes.`);
    this.name = "McpCallInputTooLargeError";
  }
}

type McpCallInputOptions = {
  input?: string;
  inputFile?: string;
};

type McpCallInputParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function parseMcpCallJsonObject(raw: string, sourceLabel: string): McpCallInputParseResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: `${sourceLabel} must contain one JSON object.` };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: `${sourceLabel} must be valid JSON containing exactly one object.`,
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: `${sourceLabel} must be a JSON object, not an array or scalar.`,
    };
  }
  return { ok: true, value };
}

async function readBoundedStdin(maxBytes = MCP_CALL_INPUT_MAX_BYTES): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--input-file - refuses to read from an interactive terminal; pipe a JSON object or pass --input.",
    );
  }
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes,
    onOverflow: ({ maxBytes: limit }) => new McpCallInputTooLargeError(limit),
  });
  return bytes.toString("utf8");
}

async function readBoundedInputFile(
  filePath: string,
  maxBytes = MCP_CALL_INPUT_MAX_BYTES,
): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    // Check the size here so overflow surfaces as our typed error; the bounded
    // read stays as the backstop for a file that grows after this stat.
    const { size } = await handle.stat();
    if (size > maxBytes) {
      throw new McpCallInputTooLargeError(maxBytes);
    }
    return (await readFileDescriptorBounded(handle.fd, maxBytes)).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Resolve tool arguments for `openclaw mcp call`.
 * Omitted input means `{}`. Exactly one of `--input` or `--input-file` may be set.
 * `--input-file -` reads one JSON object from stdin.
 */
export async function resolveMcpCallInput(
  opts: McpCallInputOptions,
): Promise<McpCallInputParseResult> {
  const inline = normalizeStringifiedOptionalString(opts.input);
  const file = normalizeStringifiedOptionalString(opts.inputFile);
  if (inline !== undefined && file !== undefined) {
    return {
      ok: false,
      error: "Specify only one of --input or --input-file.",
    };
  }
  if (inline === undefined && file === undefined) {
    return { ok: true, value: {} };
  }
  if (inline !== undefined) {
    if (Buffer.byteLength(inline, "utf8") > MCP_CALL_INPUT_MAX_BYTES) {
      return {
        ok: false,
        error: new McpCallInputTooLargeError(MCP_CALL_INPUT_MAX_BYTES).message,
      };
    }
    return parseMcpCallJsonObject(inline, "--input");
  }
  const filePath = file as string;
  try {
    const raw = filePath === "-" ? await readBoundedStdin() : await readBoundedInputFile(filePath);
    return parseMcpCallJsonObject(raw, filePath === "-" ? "stdin" : "--input-file");
  } catch (err) {
    if (err instanceof McpCallInputTooLargeError) {
      return { ok: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (filePath === "-") {
      return { ok: false, error: message };
    }
    return {
      ok: false,
      error: `Failed to read --input-file ${filePath}: ${message}`,
    };
  }
}
