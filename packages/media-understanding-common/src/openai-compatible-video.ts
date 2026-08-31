// OpenAI-compatible video request/response helpers.

/** Minimal OpenAI-compatible video response payload shape. */
export type OpenAiCompatibleVideoPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
      reasoning_content?: string;
    };
  }>;
};

/** Trim optional strings, falling back when empty. */
export function resolveMediaUnderstandingString(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

/** Coerce text from OpenAI-compatible content or reasoning fields. */
export function coerceOpenAiCompatibleVideoText(
  payload: OpenAiCompatibleVideoPayload,
): string | null {
  const message = payload.choices?.[0]?.message;
  if (!message) {
    return null;
  }
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => part.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    return message.reasoning_content.trim();
  }
  return null;
}

/** Build an OpenAI-compatible request body with an inline data URL video. */
export function buildOpenAiCompatibleVideoRequestBody(params: {
  model: string;
  prompt: string;
  mime: string;
  buffer: Buffer;
}) {
  return {
    model: params.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          {
            type: "video_url",
            video_url: {
              url: `data:${params.mime};base64,${params.buffer.toString("base64")}`,
            },
          },
        ],
      },
    ],
  };
}
