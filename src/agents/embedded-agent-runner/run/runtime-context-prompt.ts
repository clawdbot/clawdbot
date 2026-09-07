/**
 * Builds runtime context prompt fragments and custom session messages.
 */
import type { Context, UserMessage } from "../../../llm/types.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
  type RuntimeContextFragment,
} from "../../internal-runtime-context.js";
import type { CurrentInboundPromptContext } from "./params.js";

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";

/** Hidden custom transcript message that carries runtime context into model conversion. */
export type RuntimeContextCustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  details: {
    source: "openclaw-runtime-context";
    runtimeContextCarrier: true;
    fragments?: RuntimeContextFragment[];
  };
  timestamp: number;
};

/** Appends turn additions to both full and resumed projections without changing their provenance. */
export function appendCurrentInboundContext(
  context: CurrentInboundPromptContext | undefined,
  fragments: RuntimeContextFragment[],
  legacyText = fragments.map((fragment) => fragment.text).join("\n\n"),
): CurrentInboundPromptContext {
  const append = (text?: string) => [text, legacyText].filter(Boolean).join("\n\n");
  return {
    ...context,
    text: append(context?.text),
    ...(context?.resumableText !== undefined
      ? { resumableText: append(context.resumableText) }
      : {}),
    fragments: [
      ...(context?.fragments ??
        (context?.text ? [{ kind: "conversation-data" as const, text: context.text }] : [])),
      ...fragments,
    ],
  };
}

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
  return [prefix, params.prompt].filter(Boolean).join(params.context?.promptJoiner ?? "\n\n");
}

/** Selects explicit producer context without interpreting any prompt text as provenance. */
export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  fragments?: RuntimeContextFragment[];
  allowRuntimeOnly?: boolean;
}) {
  const fragments = params.fragments?.filter((fragment) => fragment.text.trim());
  const runtimeContext = fragments?.map((fragment) => fragment.text).join("\n\n") ?? "";
  const transcriptPrompt = params.transcriptPrompt ?? params.effectivePrompt;
  const runtimeOnly =
    !transcriptPrompt.trim() && Boolean(runtimeContext) && params.allowRuntimeOnly !== false;
  const prompt = runtimeOnly
    ? OPENCLAW_RUNTIME_EVENT_USER_PROMPT
    : transcriptPrompt || params.effectivePrompt;
  return {
    prompt,
    modelPrompt:
      params.effectivePrompt && params.effectivePrompt !== prompt
        ? params.effectivePrompt
        : undefined,
    runtimeContext: runtimeContext || undefined,
    ...(runtimeOnly ? { runtimeOnly: true } : {}),
  };
}

export function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  // Next-turn carriers carry only the delimited body: the stable system prompt
  // explains the markers once, and the delimiters are what hasInternalRuntimeContext
  // and the leak strippers key on. Runtime events keep their preface because the
  // model receives no user message alongside them.
  return [
    ...(params.kind === "runtime-event"
      ? [OPENCLAW_RUNTIME_EVENT_HEADER, OPENCLAW_RUNTIME_CONTEXT_NOTICE, ""]
      : []),
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    params.runtimeContext,
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

/** Creates a non-displayed custom transcript message for runtime context, if any exists. */
export function buildRuntimeContextCustomMessage(
  runtimeContext: string | undefined,
  fragments?: RuntimeContextFragment[],
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
    details: {
      source: "openclaw-runtime-context",
      runtimeContextCarrier: true,
      ...(fragments?.length ? { fragments } : {}),
    },
    timestamp: Date.now(),
  };
}

/** Project per-request instructions into the transient carrier without changing history. */
export function prependRuntimeContextForModel(
  messages: Context["messages"],
  runtimeContext: string,
): Context["messages"] {
  if (!runtimeContext.trim()) {
    return messages;
  }
  const carrierIndex = messages.findIndex(
    (message) => message.role === "user" && message.runtimeContextCarrier === true,
  );
  const carrier = messages[carrierIndex];
  const prepend = (text: string) =>
    text.startsWith(`${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`)
      ? `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${runtimeContext}\n\n${text.slice(INTERNAL_RUNTIME_CONTEXT_BEGIN.length + 1)}`
      : buildRuntimeContextMessageContent({
          runtimeContext: [runtimeContext, text].filter(Boolean).join("\n\n"),
          kind: "next-turn",
        });
  if (carrier?.role !== "user") {
    return [
      ...messages,
      {
        role: "user",
        content: prepend(""),
        runtimeContextCarrier: true,
        timestamp: messages.at(-1)?.timestamp ?? 0,
      },
    ];
  }
  const content = carrier.content;
  const firstTextIndex =
    typeof content === "string" ? -1 : content.findIndex((part) => part.type === "text");
  const updated: UserMessage = {
    ...carrier,
    content:
      typeof content === "string"
        ? prepend(content)
        : firstTextIndex < 0
          ? [{ type: "text", text: prepend("") }, ...content]
          : content.map((part, index) =>
              index === firstTextIndex && part.type === "text"
                ? Object.assign({}, part, { text: prepend(part.text) })
                : part,
            ),
  };
  return messages.map((message, index) => (index === carrierIndex ? updated : message));
}
