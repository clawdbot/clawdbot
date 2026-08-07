import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

type ParsedQmdSnippet = { snippet: string; startLine?: number; endLine?: number };

const QMD_ENVELOPE_RE =
  /^\uFEFF?(?:(\d+): ?)?@@\s*-(\d+),(\d+)(?:\s*@@(?:\s*\(\d+\s+before,\s*\d+\s+after\))?)?(?:\r?\n|$)/;
const MCP_NUMBERED_LINE_RE = /^(\d+):(?: ?)(.*)$/;
const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

export function parseQmdSnippet(
  raw: string,
  transport: "cli" | "mcp",
  maxChars: number,
): ParsedQmdSnippet {
  const truncate = (value: string) => truncateUtf16Safe(value, maxChars);
  const scanChars = Math.min(
    Number.MAX_SAFE_INTEGER,
    maxChars * (transport === "mcp" ? 20 : 1) + 4096,
  );
  const bounded = truncateUtf16Safe(raw, scanChars);
  const match = QMD_ENVELOPE_RE.exec(bounded);
  const headerNumber = Number(match?.[1]);
  const startLine = Number(match?.[2]);
  const count = Number(match?.[3]);
  const endLine = startLine + count - 1;
  const expectedTransport =
    transport === "mcp" ? positiveSafeInteger(headerNumber) : match?.[1] === undefined;
  if (!match || !expectedTransport || ![startLine, count, endLine].every(positiveSafeInteger)) {
    return { snippet: truncate(raw) };
  }

  const body = bounded.slice(match[0].length);
  if (transport === "cli") {
    return { snippet: truncate(body), startLine, endLine };
  }
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const trailingNewline = body.length > 0 && lines.at(-1) === "";
  if (trailingNewline) {
    lines.pop();
  }
  const numbered = lines.map((line) => MCP_NUMBERED_LINE_RE.exec(line));
  const complete = numbered.every(
    (line, index) => line && Number(line[1]) === headerNumber + index + 1,
  );
  const cleaned = complete
    ? numbered.map((line) => line![2]!).join(newline) + (trailingNewline ? newline : "")
    : body;
  return { snippet: truncate(cleaned), startLine, endLine };
}
