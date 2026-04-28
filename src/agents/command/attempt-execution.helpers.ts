import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../../auto-reply/tokens.js";
import {
  type ClaudeCliFallbackSeed,
  readClaudeCliFallbackSeed,
} from "../../gateway/cli-session-history.js";

/** Maximum number of JSONL records to inspect before giving up. */
const SESSION_FILE_MAX_RECORDS = 500;
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");

function normalizeClaudeCliSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("/") || trimmed.includes("\\")) {
    return undefined;
  }
  return trimmed;
}

async function jsonlFileHasAssistantMessage(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }

    const fh = await fs.open(filePath, "r");
    try {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
      let recordCount = 0;
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        recordCount++;
        if (recordCount > SESSION_FILE_MAX_RECORDS) {
          break;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = obj as Record<string, unknown> | null;
        if ((rec?.message as Record<string, unknown> | undefined)?.role === "assistant") {
          return true;
        }
      }
      return false;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Check whether a session transcript file exists and contains at least one
 * assistant message, indicating that the SessionManager has flushed the
 * initial user+assistant exchange to disk.
 */
export async function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean> {
  return await jsonlFileHasAssistantMessage(sessionFile);
}

export async function claudeCliSessionTranscriptHasContent(params: {
  sessionId: string | undefined;
  homeDir?: string;
}): Promise<boolean> {
  const sessionId = normalizeClaudeCliSessionId(params.sessionId);
  if (!sessionId) {
    return false;
  }
  const homeDir = params.homeDir?.trim() || process.env.HOME || os.homedir();
  const projectsDir = path.join(homeDir, CLAUDE_PROJECTS_RELATIVE_DIR);
  let projectEntries: import("node:fs").Dirent[];
  try {
    projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);
    if (await jsonlFileHasAssistantMessage(candidate)) {
      return true;
    }
  }
  return false;
}

export function resolveFallbackRetryPrompt(params: {
  body: string;
  isFallbackRetry: boolean;
  sessionHasHistory?: boolean;
  priorContextPrelude?: string;
}): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  const prelude = params.priorContextPrelude?.trim();
  if (!params.sessionHasHistory && !prelude) {
    return params.body;
  }
  // Even with persisted session history, fully replacing the body with a
  // generic "continue where you left off" message strips the original task
  // from the fallback model's view. Agents then have to reconstruct the
  // instruction from history alone, which is fragile and sometimes
  // impossible. Prepend the retry context to the original body instead so
  // the fallback model has both the recovery signal AND the task. (#65760)
  const retryMarked = `[Retry after the previous model attempt failed or timed out]\n\n${params.body}`;
  return prelude ? `${prelude}\n\n${retryMarked}` : retryMarked;
}

const CLAUDE_CLI_FALLBACK_PRELUDE_DEFAULT_CHAR_BUDGET = 8_000;
const CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS = 64;

type FallbackTurnLikeMessage = Record<string, unknown>;

function extractFallbackTurnText(message: FallbackTurnLikeMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as Record<string, unknown>;
    if (typeof rec.text === "string") {
      parts.push(rec.text);
      continue;
    }
    // Tool calls: render as a compact "(tool: name)" hint so the fallback
    // model sees the conversation flow without the full tool argument blob,
    // which is rarely useful out of context and chews through char budget.
    if (rec.type === "tool_use" && typeof rec.name === "string") {
      parts.push(`(tool call: ${rec.name})`);
      continue;
    }
    if (rec.type === "tool_result") {
      const inner = typeof rec.content === "string" ? rec.content : undefined;
      if (inner) {
        parts.push(`(tool result: ${inner})`);
      } else {
        parts.push("(tool result)");
      }
    }
  }
  return parts.join("\n").trim();
}

function formatFallbackTurns(
  turns: ReadonlyArray<FallbackTurnLikeMessage>,
  remainingBudget: number,
): { text: string; consumed: number } {
  if (turns.length === 0 || remainingBudget <= 0) {
    return { text: "", consumed: 0 };
  }
  const lines: string[] = [];
  let consumed = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (!turn || typeof turn !== "object") {
      continue;
    }
    const role = turn.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = extractFallbackTurnText(turn);
    if (!text) {
      continue;
    }
    const line = `${role}: ${text}`;
    if (consumed + line.length + 1 > remainingBudget) {
      break;
    }
    lines.unshift(line);
    consumed += line.length + 1;
  }
  return { text: lines.join("\n"), consumed };
}

/**
 * Format a previously-harvested Claude CLI session into a labeled prelude
 * suitable for prepending to a fallback candidate's prompt. Behavior matches
 * Claude Code's own resume strategy after compaction: prefer the explicit
 * summary, then append the most recent turns up to a char budget.
 *
 * Returns an empty string when neither a summary nor any usable turn fits in
 * the budget; callers can treat that as "no context to seed".
 */
export function formatClaudeCliFallbackPrelude(
  seed: ClaudeCliFallbackSeed,
  options?: { charBudget?: number },
): string {
  const charBudget = Math.max(
    CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS,
    options?.charBudget ?? CLAUDE_CLI_FALLBACK_PRELUDE_DEFAULT_CHAR_BUDGET,
  );
  const heading = "## Prior session context (from claude-cli)";
  const sections: string[] = [heading];
  let remaining = charBudget - heading.length;
  if (seed.summaryText) {
    const summarySection = `\nSummary of earlier conversation:\n${seed.summaryText}`;
    if (summarySection.length <= remaining) {
      sections.push(summarySection);
      remaining -= summarySection.length;
    } else {
      // Truncate the summary at a word boundary if it's huge; clearly mark
      // the truncation so the fallback model treats the prelude as a hint,
      // not exhaustive state.
      const slice = seed.summaryText.slice(0, Math.max(0, remaining - 64));
      const lastBreak = slice.lastIndexOf(" ");
      const trimmed = lastBreak > 0 ? slice.slice(0, lastBreak).trimEnd() : slice.trimEnd();
      sections.push(`\nSummary of earlier conversation (truncated):\n${trimmed} …`);
      remaining = 0;
    }
  }
  if (remaining > CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS && seed.recentTurns.length > 0) {
    const { text } = formatFallbackTurns(
      seed.recentTurns as ReadonlyArray<FallbackTurnLikeMessage>,
      remaining - 32,
    );
    if (text) {
      sections.push(`\nRecent turns:\n${text}`);
    }
  }
  // No summary AND no fittable turns => nothing to seed beyond the heading,
  // which would just confuse the model. Drop the prelude entirely.
  if (sections.length === 1) {
    return "";
  }
  return sections.join("\n");
}

/**
 * Read the Claude CLI session pointed to by `cliSessionId` and format a
 * fallback prelude. Returns `""` when no session file is found or when the
 * harvested seed has no usable content.
 */
export function buildClaudeCliFallbackContextPrelude(params: {
  cliSessionId: string | undefined;
  homeDir?: string;
  charBudget?: number;
}): string {
  const sessionId = params.cliSessionId?.trim();
  if (!sessionId) {
    return "";
  }
  const seed = readClaudeCliFallbackSeed({ cliSessionId: sessionId, homeDir: params.homeDir });
  if (!seed) {
    return "";
  }
  return formatClaudeCliFallbackPrelude(seed, { charBudget: params.charBudget });
}

export function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  let rawVisibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { rawText: string; delta: string } => {
    if (!base) {
      return { rawText: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { rawText: chunk, delta };
    }
    return {
      rawText: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (startsWithSilentToken(trimmedLeadCandidate, SILENT_REPLY_TOKEN)) {
          const stripped = stripLeadingSilentToken(leadCandidate, SILENT_REPLY_TOKEN);
          if (stripped) {
            pendingSilentPrefix = "";
            rawVisibleText = leadCandidate;
            visibleText = stripped;
            return { text: stripped, delta: stripped };
          }
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          rawVisibleText = leadCandidate;
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(rawVisibleText, chunk);
      rawVisibleText = nextVisible.rawText;
      if (!nextVisible.delta) {
        return null;
      }
      visibleText = `${visibleText}${nextVisible.delta}`;
      return { text: visibleText, delta: nextVisible.delta };
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}
