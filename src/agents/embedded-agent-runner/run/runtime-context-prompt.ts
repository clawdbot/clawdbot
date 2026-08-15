/**
 * Builds runtime context prompt fragments and custom session messages.
 */
import {
  extractInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentInboundPromptContext } from "./params.js";

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
  details: { source: "openclaw-runtime-context"; runtimeContextCarrier: true };
  timestamp: number;
};

type EmptyTranscriptMode = "model-prompt" | "runtime-event";

type ModelPromptBuildContext = {
  promptBeforeHooks: string;
  transcriptPromptBeforeTransforms: string;
  promptBeforeAnnotation: string;
  prependContext: string;
  appendContext: string;
};

/** Combines inbound context and the current prompt using the channel-provided joiner. */
export function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
  preferResumableText?: boolean;
}): string {
  const contextText =
    params.preferResumableText === true
      ? (params.context?.resumableText ?? params.context?.text)
      : params.context?.text;
  const prefix = contextText?.trim() ?? "";
  if (!prefix) {
    return params.prompt;
  }
  if (!params.prompt) {
    return prefix;
  }
  return [prefix, params.prompt].join(params.context?.promptJoiner ?? "\n\n");
}

function splitLastPromptOccurrence(
  text: string,
  prompt: string,
): { before: string; after: string } | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  return {
    before: text.slice(0, index),
    after: text.slice(index + prompt.length),
  };
}

function replacePromptOccurrenceWithinHookBounds(params: {
  text: string;
  promptBeforeHooks: string;
  transcriptPrompt: string;
  prependContext: string;
  appendContext: string;
}): string | null {
  if (!params.promptBeforeHooks) {
    return null;
  }
  const prependIndex = params.prependContext ? params.text.indexOf(params.prependContext) : -1;
  if (params.prependContext && prependIndex === -1) {
    return null;
  }
  const searchStart = prependIndex === -1 ? 0 : prependIndex + params.prependContext.length;
  const appendIndex = params.appendContext ? params.text.lastIndexOf(params.appendContext) : -1;
  if (params.appendContext && appendIndex < searchStart) {
    return null;
  }
  const searchEnd = appendIndex === -1 ? params.text.length : appendIndex;
  const occurrenceIndex = params.text.lastIndexOf(
    params.promptBeforeHooks,
    searchEnd - params.promptBeforeHooks.length,
  );
  if (
    occurrenceIndex < searchStart ||
    occurrenceIndex + params.promptBeforeHooks.length > searchEnd
  ) {
    return null;
  }
  return `${params.text.slice(0, occurrenceIndex)}${params.transcriptPrompt}${params.text.slice(
    occurrenceIndex + params.promptBeforeHooks.length,
  )}`;
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
  modelPromptBuildContext?: ModelPromptBuildContext;
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
  const modelPromptBuildContext = params.modelPromptBuildContext
    ? {
        promptBeforeHooks: extractInternalRuntimeContext(
          params.modelPromptBuildContext.promptBeforeHooks,
        ).text,
        transcriptPromptBeforeTransforms: extractInternalRuntimeContext(
          params.modelPromptBuildContext.transcriptPromptBeforeTransforms,
        ).text,
        promptBeforeAnnotation: extractInternalRuntimeContext(
          params.modelPromptBuildContext.promptBeforeAnnotation,
        ).text,
        prependContext: extractInternalRuntimeContext(params.modelPromptBuildContext.prependContext)
          .text,
        appendContext: extractInternalRuntimeContext(params.modelPromptBuildContext.appendContext)
          .text,
      }
    : undefined;
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
  const sourcePromptParts = modelPromptBuildContext
    ? splitLastPromptOccurrence(
        modelPromptBuildContext.promptBeforeHooks,
        modelPromptBuildContext.transcriptPromptBeforeTransforms,
      )
    : undefined;
  const outerPromptParts = modelPromptBuildContext
    ? splitLastPromptOccurrence(extracted.text, modelPromptBuildContext.promptBeforeAnnotation)
    : undefined;
  const fallbackPromptParts = !modelPromptBuildContext
    ? modelPrompt
      ? (splitLastPromptOccurrence(extracted.text, modelPrompt.text) ??
        (transcriptPrompt
          ? splitLastPromptOccurrence(extracted.text, transcriptPrompt)
          : undefined))
      : transcriptPrompt
        ? splitLastPromptOccurrence(extracted.text, transcriptPrompt)
        : undefined
    : undefined;
  // Source context sits inside the active prompt; provenance sits outside all
  // prompt transforms. Preserve that nesting order when hiding both.
  const hiddenRuntimeContext = [
    outerPromptParts?.before,
    sourcePromptParts?.before ?? fallbackPromptParts?.before,
    sourcePromptParts?.after ?? fallbackPromptParts?.after,
    outerPromptParts?.after,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
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
          runtimeSystemContext: buildRuntimeContextMessageContent({
            runtimeContext,
            kind: "runtime-event",
          }),
        }
      : {
          prompt: "",
          ...(modelPromptText ? { modelPrompt: modelPromptText } : {}),
        };
  }

  // When hooks added pre-prompt context, modelPromptText still contains the
  // system-event prefix that was separated into runtimeContext. Strip it so
  // events aren't delivered to the model twice (Message A and Message B).
  const hasHiddenSourceContext = Boolean(
    sourcePromptParts?.before.trim() || sourcePromptParts?.after.trim(),
  );
  const returnModelPromptText =
    hasHiddenSourceContext && modelPromptBuildContext && modelPrompt
      ? (replacePromptOccurrenceWithinHookBounds({
          text: modelPromptText,
          promptBeforeHooks: modelPromptBuildContext.promptBeforeHooks,
          transcriptPrompt: modelPromptBuildContext.transcriptPromptBeforeTransforms,
          prependContext: modelPromptBuildContext.prependContext,
          appendContext: modelPromptBuildContext.appendContext,
        }) ?? modelPromptText)
      : modelPromptText;

  return {
    prompt,
    ...(returnModelPromptText.trim() && returnModelPromptText !== prompt
      ? { modelPrompt: returnModelPromptText }
      : {}),
    ...(runtimeContext ? { runtimeContext } : {}),
  };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  // Wrap the runtime context body in delimited internal-context markers so
  // stripInternalRuntimeContext can fully remove the block when it leaks
  // into user-visible surfaces (e.g. Feishu streaming cards, #92589).
  return [
    params.kind === "runtime-event"
      ? OPENCLAW_RUNTIME_EVENT_HEADER
      : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    params.runtimeContext,
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
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
    content: buildRuntimeContextMessageContent({
      runtimeContext: trimmedRuntimeContext,
      kind: "next-turn",
    }),
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    timestamp: Date.now(),
  };
}
