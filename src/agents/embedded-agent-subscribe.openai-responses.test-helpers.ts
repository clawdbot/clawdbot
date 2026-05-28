export type OpenAiResponsesTextEventPhase = "commentary" | "final_answer";

export function createOpenAiResponsesTextBlock(params: {
  text: string;
  id: string;
  phase?: OpenAiResponsesTextEventPhase;
}) {
  return {
    type: "text",
    text: params.text,
    textSignature: JSON.stringify({
      v: 1,
      id: params.id,
      ...(params.phase ? { phase: params.phase } : {}),
    }),
  };
}

export function createOpenAiResponsesPartial(params: {
  text: string;
  id: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
}) {
  return {
    role: "assistant",
    content: [
      createOpenAiResponsesTextBlock({
        text: params.text,
        id: params.id,
        phase: params.signaturePhase,
      }),
    ],
    ...(params.partialPhase ? { phase: params.partialPhase } : {}),
    stopReason: "stop",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.2",
    usage: {},
    timestamp: 0,
  };
}

export function createOpenAiResponsesTextEvent(params: {
  type: "text_delta" | "text_end";
  text: string;
  delta?: string;
  id?: string;
  signaturePhase?: OpenAiResponsesTextEventPhase;
  partialPhase?: OpenAiResponsesTextEventPhase;
  messagePhase?: OpenAiResponsesTextEventPhase;
  content?: unknown[];
  partial?: ReturnType<typeof createOpenAiResponsesPartial>;
}) {
  const partial =
    params.partial ??
    (params.id
      ? createOpenAiResponsesPartial({
          text: params.text,
          id: params.id,
          signaturePhase: params.signaturePhase,
          partialPhase: params.partialPhase,
        })
      : undefined);

  return {
    type: "message_update",
    message: {
      role: "assistant",
      ...(params.messagePhase ? { phase: params.messagePhase } : {}),
      content: params.content ?? [],
    },
    assistantMessageEvent: {
      type: params.type,
      ...(params.type === "text_delta"
        ? { delta: params.delta ?? params.text }
        : { content: params.text }),
      ...(partial ? { partial } : {}),
    },
  } as never;
}
