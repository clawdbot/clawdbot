// Helpers specific to Claude CLI output/argv handling.
import { z } from "zod";

// Preferred binary name for Claude CLI invocations.
export const CLAUDE_BIN = "claude";
export const CLAUDE_IDENTITY_PREFIX =
  "You are Clawd (Claude) running on the user's Mac via warelay. Keep WhatsApp replies under ~1500 characters. Your scratchpad is ~/clawd; this is your folder and you can add what you like in markdown files and/or images. You can send media by including MEDIA:/path/to/file.jpg on its own line (no spaces in path). Media limits: images ≤6MB, audio/video ≤16MB, documents ≤100MB. The prompt may include a media path and an optional Transcript: section—use them when present. If a prompt is a heartbeat poll and nothing needs attention, reply with exactly HEARTBEAT_OK and nothing else; for any alert, do not include HEARTBEAT_OK.";

function extractClaudeText(payload: unknown): string | undefined {
  // Best-effort walker to find the primary text field in Claude JSON outputs.
  if (payload == null) return undefined;
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractClaudeText(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.result === "string") return obj.result;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.completion === "string") return obj.completion;
    if (typeof obj.output === "string") return obj.output;
    if (obj.message) {
      const inner = extractClaudeText(obj.message);
      if (inner) return inner;
    }
    if (Array.isArray(obj.messages)) {
      const inner = extractClaudeText(obj.messages);
      if (inner) return inner;
    }
    if (Array.isArray(obj.content)) {
      for (const block of obj.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        const inner = extractClaudeText(block);
        if (inner) return inner;
      }
    }
  }
  return undefined;
}

export type ClaudeJsonParseResult = {
  text?: string;
  parsed: unknown;
  valid: boolean;
};

const ClaudeJsonSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    text: z.string().optional(),
    completion: z.string().optional(),
    output: z.string().optional(),
    message: z.any().optional(),
    messages: z.any().optional(),
    content: z.any().optional(),
    duration_ms: z.number().optional(),
    duration_api_ms: z.number().optional(),
    num_turns: z.number().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    usage: z.record(z.string(), z.any()).optional(),
    modelUsage: z.record(z.string(), z.any()).optional(),
  })
  .passthrough()
  .refine(
    (obj) =>
      typeof obj.result === "string" ||
      typeof obj.text === "string" ||
      typeof obj.completion === "string" ||
      typeof obj.output === "string" ||
      obj.message !== undefined ||
      obj.messages !== undefined ||
      obj.content !== undefined,
    { message: "Not a Claude JSON payload" },
  );

type ClaudeSafeParse = ReturnType<typeof ClaudeJsonSchema.safeParse>;

export function parseClaudeJson(
  raw: string,
): ClaudeJsonParseResult | undefined {
  // Handle a single JSON blob or newline-delimited JSON; return the first parsed payload.
  let firstParsed: unknown;
  const candidates = [
    raw,
    ...raw
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (firstParsed === undefined) firstParsed = parsed;
      let validation: ClaudeSafeParse | { success: false };
      try {
        validation = ClaudeJsonSchema.safeParse(parsed);
      } catch {
        validation = { success: false } as const;
      }
      const validated = validation.success ? validation.data : parsed;
      const isLikelyClaude =
        typeof validated === "object" &&
        validated !== null &&
        ("result" in validated ||
          "text" in validated ||
          "completion" in validated ||
          "output" in validated);
      const text = extractClaudeText(validated);
      if (text)
        return {
          parsed: validated,
          text,
          // Treat parse as valid when schema passes or we still see Claude-like shape.
          valid: Boolean(validation?.success || isLikelyClaude),
        };
    } catch {
      // ignore parse errors; try next candidate
    }
  }
  if (firstParsed !== undefined) {
    let validation: ClaudeSafeParse | { success: false };
    try {
      validation = ClaudeJsonSchema.safeParse(firstParsed);
    } catch {
      validation = { success: false } as const;
    }
    const validated = validation.success ? validation.data : firstParsed;
    const isLikelyClaude =
      typeof validated === "object" &&
      validated !== null &&
      ("result" in validated ||
        "text" in validated ||
        "completion" in validated ||
        "output" in validated);
    return {
      parsed: validated,
      text: extractClaudeText(validated),
      valid: Boolean(validation?.success || isLikelyClaude),
    };
  }
  return undefined;
}

export function parseClaudeJsonText(raw: string): string | undefined {
  const parsed = parseClaudeJson(raw);
  return parsed?.text;
}

// Re-export from command-reply for backwards compatibility
export { summarizeClaudeMetadata } from "./command-reply.js";
