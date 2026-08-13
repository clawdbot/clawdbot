import { formatErrorMessage } from "../infra/errors.js";
import { buildRealtimeVoiceAgentConsultChatMessage } from "./agent-consult-tool.js";

export type RealtimeVoiceConsultToolCallOutcome =
  | { kind: "exact-speech-echo"; text: string }
  | { kind: "consult"; message: string }
  | { kind: "malformed"; error: string };

/** Build the internal user message that asks a realtime model to speak exact text. */
export function buildRealtimeVoiceSpeakExactMessage(params: {
  text: string;
  surfaceLabel: string;
}): string {
  return [
    "Internal OpenClaw voice playback result.",
    "Do not call openclaw_agent_consult or any other tool for this message.",
    `Speak this exact OpenClaw answer to ${params.surfaceLabel}, without adding, removing, or rephrasing words.`,
    `Answer: ${JSON.stringify(params.text)}`,
  ].join("\n");
}

/** Classify a provider consult call before normal agent delegation. */
export function classifyRealtimeVoiceConsultToolCall(
  args: unknown,
  options: { retainedExactSpeechTexts: readonly string[] },
): RealtimeVoiceConsultToolCallOutcome {
  const message = collectRealtimeConsultArgStrings(args).join("\n");
  // The retained set is the session-owned fact that authorizes the bypass; the
  // marker alone is untrusted model tool-call text and must never select the
  // privileged replay path on its own.
  if (message.includes("Speak this exact OpenClaw answer")) {
    const text = readJsonStringAfterLabel(message, "Answer:");
    if (text !== undefined && options.retainedExactSpeechTexts.includes(text)) {
      return { kind: "exact-speech-echo", text };
    }
  }

  // Once completed speech leaves this session-local retained set, a late echo
  // intentionally falls through to a normal consult instead of guessing.
  for (const text of options.retainedExactSpeechTexts) {
    if (text && message.includes(JSON.stringify(text))) {
      return { kind: "exact-speech-echo", text };
    }
  }

  try {
    return { kind: "consult", message: buildRealtimeVoiceAgentConsultChatMessage(args) };
  } catch (error) {
    return { kind: "malformed", error: formatErrorMessage(error) };
  }
}

function collectRealtimeConsultArgStrings(args: unknown): string[] {
  if (!args || typeof args !== "object") {
    return typeof args === "string" ? [args] : [];
  }
  const values: string[] = [];
  for (const key of ["question", "prompt", "query", "task", "context", "responseStyle"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") {
      values.push(value);
    }
  }
  return values;
}

function readJsonStringAfterLabel(text: string, label: string): string | undefined {
  const labelIndex = text.indexOf(label);
  if (labelIndex < 0) {
    return undefined;
  }
  const quoteIndex = text.indexOf('"', labelIndex + label.length);
  if (quoteIndex < 0) {
    return undefined;
  }
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    if (text[index] !== '"' || isEscapedQuote(text, index)) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text.slice(quoteIndex, index + 1));
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isEscapedQuote(text: string, quoteIndex: number): boolean {
  let backslashes = 0;
  for (let index = quoteIndex - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
