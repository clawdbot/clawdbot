import fs from "node:fs/promises";

export async function readFileTailLines(
  filePath: string,
  maxLines: number,
): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const lines = raw.replace(/\r/g, "").split("\n");
  const out = lines.slice(Math.max(0, lines.length - maxLines));
  return out
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function countMatches(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  return haystack.split(needle).length - 1;
}

function shorten(message: string, maxLen: number): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLen - 1))}…`;
}

function normalizeGwsLine(line: string): string {
  return line
    .replace(/\s+runId=[^\s]+/g, "")
    .replace(/\s+conn=[^\s]+/g, "")
    .replace(/\s+id=[^\s]+/g, "")
    .replace(/\s+error=Error:.*$/g, "")
    .trim();
}

function consumeJsonBlock(
  lines: string[],
  startIndex: number,
): { json: string; endIndex: number } | null {
  const startLine = lines[startIndex] ?? "";
  const braceAt = startLine.indexOf("{");
  if (braceAt < 0) return null;

  const parts: string[] = [startLine.slice(braceAt)];
  let depth =
    countMatches(parts[0] ?? "", "{") - countMatches(parts[0] ?? "", "}");
  let i = startIndex;
  while (depth > 0 && i + 1 < lines.length) {
    i += 1;
    const next = lines[i] ?? "";
    parts.push(next);
    depth += countMatches(next, "{") - countMatches(next, "}");
  }
  return { json: parts.join("\n"), endIndex: i };
}

export function summarizeLogTail(
  rawLines: string[],
  opts?: { maxLines?: number },
): string[] {
  const maxLines = Math.max(6, opts?.maxLines ?? 26);

  const out: string[] = [];
  const groups = new Map<
    string,
    { count: number; index: number; base: string }
  >();

  const addGroup = (key: string, base: string) => {
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    groups.set(key, { count: 1, index: out.length, base });
    out.push(base);
  };

  const addLine = (line: string) => {
    const trimmed = line.trimEnd();
    if (!trimmed) return;
    out.push(trimmed);
  };

  const lines = rawLines.map((line) => line.trimEnd()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmedStart = line.trimStart();
    if (
      (trimmedStart.startsWith('"') ||
        trimmedStart === "}" ||
        trimmedStart === "{" ||
        trimmedStart.startsWith("}") ||
        trimmedStart.startsWith("{")) &&
      !trimmedStart.startsWith("[") &&
      !trimmedStart.startsWith("#")
    ) {
      // Tail can cut in the middle of a JSON blob; drop orphaned JSON fragments.
      continue;
    }

    // "[openai-codex] Token refresh failed: 401 { ...json... }"
    const tokenRefresh = line.match(
      /^\[([^\]]+)\]\s+Token refresh failed:\s*(\d+)\s*(\{)?\s*$/,
    );
    if (tokenRefresh) {
      const tag = tokenRefresh[1] ?? "unknown";
      const status = tokenRefresh[2] ?? "unknown";
      const block = consumeJsonBlock(lines, i);
      if (block) {
        i = block.endIndex;
        const parsed = (() => {
          try {
            return JSON.parse(block.json) as {
              error?: { code?: string; message?: string };
            };
          } catch {
            return null;
          }
        })();
        const code = parsed?.error?.code?.trim() || null;
        const msg = parsed?.error?.message?.trim() || null;
        const msgShort = msg
          ? msg.toLowerCase().includes("signing in again")
            ? "re-auth required"
            : shorten(msg, 52)
          : null;
        const base = `[${tag}] token refresh ${status}${code ? ` ${code}` : ""}${msgShort ? ` · ${msgShort}` : ""}`;
        addGroup(
          `token:${tag}:${status}:${code ?? ""}:${msgShort ?? ""}`,
          base,
        );
        continue;
      }
    }

    // "Embedded agent failed before reply: OAuth token refresh failed for openai-codex: ..."
    const embedded = line.match(
      /^Embedded agent failed before reply:\s+OAuth token refresh failed for ([^:]+):/,
    );
    if (embedded) {
      const provider = embedded[1]?.trim() || "unknown";
      addGroup(
        `embedded:${provider}`,
        `Embedded agent: OAuth token refresh failed (${provider})`,
      );
      continue;
    }

    // "[gws] ⇄ res ✗ agent ... errorCode=UNAVAILABLE errorMessage=Error: OAuth token refresh failed ... runId=..."
    if (
      line.startsWith("[gws]") &&
      line.includes("errorCode=UNAVAILABLE") &&
      line.includes("OAuth token refresh failed")
    ) {
      const normalized = normalizeGwsLine(line);
      addGroup(`gws:${normalized}`, normalized);
      continue;
    }

    addLine(line);
  }

  for (const g of groups.values()) {
    if (g.count <= 1) continue;
    out[g.index] = `${g.base} ×${g.count}`;
  }

  const deduped: string[] = [];
  for (const line of out) {
    if (deduped[deduped.length - 1] === line) continue;
    deduped.push(line);
  }

  if (deduped.length <= maxLines) return deduped;

  const head = Math.min(6, Math.floor(maxLines / 3));
  const tail = Math.max(1, maxLines - head - 1);
  const kept = [
    ...deduped.slice(0, head),
    `… ${deduped.length - head - tail} lines omitted …`,
    ...deduped.slice(-tail),
  ];
  return kept;
}

export function pickGatewaySelfPresence(presence: unknown): {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
} | null {
  if (!Array.isArray(presence)) return null;
  const entries = presence as Array<Record<string, unknown>>;
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ?? null;
  if (!self) return null;
  return {
    host: typeof self.host === "string" ? self.host : undefined,
    ip: typeof self.ip === "string" ? self.ip : undefined,
    version: typeof self.version === "string" ? self.version : undefined,
    platform: typeof self.platform === "string" ? self.platform : undefined,
  };
}
