/**
 * Builds runtime context prompt fragments and custom session messages.
 */
import {
  extractInternalRuntimeContext,
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentInboundPromptContext } from "./params.js";
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE };

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";

type RuntimeContextPromptParts = {
  prompt: string;
  modelPrompt?: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

/** Hidden custom transcript message that carries runtime context into model conversion. */
export type RuntimeContextCustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  details: { source: "openclaw-runtime-context" };
  timestamp: number;
};

type EmptyTranscriptMode = "model-prompt" | "runtime-event";

/** Returns the visible or resumable inbound prompt prefix used before the user prompt. */
export function buildCurrentInboundPromptContextPrefix(
  context: CurrentInboundPromptContext | undefined,
  options?: { preferResumableText?: boolean },
): string {
  const text =
    options?.preferResumableText === true
      ? (context?.resumableText ?? context?.text)
      : context?.text;
  return text?.trim() ?? "";
}

/** Combines inbound context and the current prompt using the channel-provided joiner. */
export function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
  preferResumableText?: boolean;
}): string {
  const prefix = buildCurrentInboundPromptContextPrefix(params.context, {
    preferResumableText: params.preferResumableText,
  });
  if (!prefix) {
    return params.prompt;
  }
  if (!params.prompt) {
    return prefix;
  }
  return [prefix, params.prompt].join(params.context?.promptJoiner ?? "\n\n");
}

function removeLastPromptOccurrence(text: string, prompt: string): string | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + prompt.length).trimStart();
  return [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

/**
 * Separates user-authored prompt text from hidden runtime context. Transcript
 * prompt stays user-visible; model prompt may carry runtime-only additions that
 * should be delivered as hidden context instead of persisted as user text.
 */
export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  modelPrompt?: string;
  emptyTranscriptMode?: EmptyTranscriptMode;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  const shouldExtractInternalRuntimeContext = transcriptPrompt !== undefined;
  const extracted = shouldExtractInternalRuntimeContext
    ? extractInternalRuntimeContext(params.effectivePrompt)
    : { text: params.effectivePrompt };
  const modelPrompt =
    params.modelPrompt === undefined
      ? undefined
      : shouldExtractInternalRuntimeContext
        ? extractInternalRuntimeContext(params.modelPrompt)
        : { text: params.modelPrompt };
  const modelPromptText = modelPrompt?.text ?? transcriptPrompt ?? extracted.text;
  const prompt = transcriptPrompt ?? extracted.text;
  if (!prompt.trim() && params.emptyTranscriptMode === "model-prompt") {
    return {
      prompt: extracted.text,
      ...(modelPromptText.trim() && modelPromptText !== extracted.text
        ? { modelPrompt: modelPromptText }
        : {}),
      ...(extracted.runtimeContext ? { runtimeContext: extracted.runtimeContext } : {}),
    };
  }
  const hiddenRuntimeContext = modelPrompt
    ? (removeLastPromptOccurrence(extracted.text, modelPrompt.text)?.trim() ??
      (transcriptPrompt
        ? removeLastPromptOccurrence(extracted.text, transcriptPrompt)?.trim()
        : undefined))
    : transcriptPrompt
      ? removeLastPromptOccurrence(extracted.text, transcriptPrompt)?.trim()
      : undefined;
  // The hidden context is whatever remains after removing the last visible
  // prompt occurrence, plus any explicit internal runtime-context block.
  const runtimeContext =
    [hiddenRuntimeContext, extracted.runtimeContext]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n") || (!prompt.trim() ? extracted.text.trim() : undefined);
  if (!prompt.trim()) {
    return runtimeContext
      ? {
          prompt: OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
          ...(modelPromptText.trim() && modelPromptText !== OPENCLAW_RUNTIME_EVENT_USER_PROMPT
            ? { modelPrompt: modelPromptText }
            : {}),
          runtimeContext,
          runtimeOnly: true,
          runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext),
        }
      : {
          prompt: "",
          ...(modelPromptText ? { modelPrompt: modelPromptText } : {}),
        };
  }

  return {
    prompt,
    ...(modelPromptText.trim() && modelPromptText !== prompt
      ? { modelPrompt: modelPromptText }
      : {}),
    ...(runtimeContext ? { runtimeContext } : {}),
  };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  return [
    params.kind === "runtime-event"
      ? OPENCLAW_RUNTIME_EVENT_HEADER
      : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    params.runtimeContext,
  ].join("\n");
}

/** Builds the hidden next-turn system context payload for model conversion. */
export function buildRuntimeContextSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "next-turn" });
}

/** Builds the hidden runtime-event system context payload for empty runtime-only turns. */
export function buildRuntimeEventSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "runtime-event" });
}

/** Creates a non-displayed custom transcript message for runtime context, if any exists. */
export function buildRuntimeContextCustomMessage(
  runtimeContext: string | undefined,
): RuntimeContextCustomMessage | undefined {
  const trimmedRuntimeContext = runtimeContext?.trim();
  if (!trimmedRuntimeContext) {
    return undefined;
  }
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content: buildRuntimeContextSystemContext(trimmedRuntimeContext),
    display: false,
    details: { source: "openclaw-runtime-context" },
    timestamp: Date.now(),
  };
}
