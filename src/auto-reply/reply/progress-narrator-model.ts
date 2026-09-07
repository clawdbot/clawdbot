// Utility-model preparation and completion for progress narration.
import { runIsolatedCompletion } from "../../agents/isolated-completion.js";
import { prepareUtilityCompletionForAgent } from "../../agents/utility-completion.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";

const NARRATION_TIMEOUT_MS = 10_000;
const NOTES_IN_PROMPT = 15;
const USER_MESSAGE_PROMPT_CHARS = 500;
// Reasoning-capable utility models spend output tokens before the short
// visible text; a tiny cap can leave no text (same budget as label generation).
const NARRATION_MAX_TOKENS = 4_096;

const NARRATION_SYSTEM_PROMPT = [
  "You write the live status line for an AI assistant that is working on a chat request.",
  "Describe what the assistant is doing right now in one or two short plain sentences, under 200 characters total.",
  "Use simple present tense and plain language a non-technical reader understands.",
  "No emoji, no markdown, no lists, no tool or API jargon, no quotation marks.",
  "If something failed, mention it briefly.",
  "Reply with the status text only.",
].join(" ");

export type ProgressNarrationInput = {
  userMessage: string;
  activityNotes: readonly string[];
  previousText: string;
};

export function truncateAtWordBoundary(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) {
    return text;
  }
  const head = chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd();
  const boundary = head.search(/\s+\S*$/u);
  if (boundary > Math.floor(maxChars * 0.6)) {
    return `${head.slice(0, boundary).trimEnd()}…`;
  }
  return `${head}…`;
}

function buildNarrationUserPrompt(input: ProgressNarrationInput): string {
  const request = truncateAtWordBoundary(
    input.userMessage.replace(/\s+/g, " ").trim(),
    USER_MESSAGE_PROMPT_CHARS,
  );
  const notes = input.activityNotes.slice(-NOTES_IN_PROMPT);
  return [
    `Request:\n${request || "(none)"}`,
    `Recent activity (oldest first):\n${notes.map((note) => `- ${note}`).join("\n") || "- (none yet)"}`,
    `Previous status: ${input.previousText || "(none)"}`,
  ].join("\n\n");
}

export async function prepareNarrationModel(params: { cfg: OpenClawConfig; agentId: string }) {
  try {
    return await prepareUtilityCompletionForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      useUtilityModel: true,
    });
  } catch (err) {
    logVerbose(`progress-narrator: model preparation failed: ${String(err)}`);
    return null;
  }
}

export async function generateNarrationWithUtilityModel(params: {
  cfg: OpenClawConfig;
  prepared: NonNullable<Awaited<ReturnType<typeof prepareNarrationModel>>>;
  input: ProgressNarrationInput;
  abortSignal?: AbortSignal;
}): Promise<{ text: string | null; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NARRATION_TIMEOUT_MS);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, controller.signal])
    : controller.signal;
  try {
    signal.throwIfAborted();
    const result = await runIsolatedCompletion({
      ...params.prepared,
      config: params.cfg,
      systemPrompt: NARRATION_SYSTEM_PROMPT,
      prompt: buildNarrationUserPrompt(params.input),
      timeoutMs: NARRATION_TIMEOUT_MS,
      abortSignal: signal,
      streamParams: {
        maxTokens: NARRATION_MAX_TOKENS,
        temperature: 0.3,
      },
    });
    const text = result.text.trim();
    return { text: text || null };
  } catch (err) {
    logVerbose(`progress-narrator: completion failed: ${String(err)}`);
    return { text: null, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
