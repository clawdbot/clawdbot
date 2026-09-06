export const OPENAI_GPT_LIVE_AUTH_REQUIRED = "GPT-Live Talk requires an OpenAI Platform API key";
export const OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE =
  "GPT-Live Talk requires a working OpenAI Platform API key. The selected Platform API-key source could not be resolved; fix or remove it.";
export const OPENAI_GPT_LIVE_PUBLIC_AUTH_REQUIRED =
  "GPT-Live Talk requires either an OpenAI Platform API key or a ChatGPT OAuth subscription profile";
export const OPENAI_GPT_LIVE_PUBLIC_AUTHORED_PLATFORM_AUTH_UNAVAILABLE =
  "GPT-Live Talk requires a working OpenAI Platform API key or ChatGPT OAuth subscription profile. No OAuth profile was available and the selected Platform API-key source could not be resolved; fix or remove it.";

export function projectOpenAIQuicksilverAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message === OPENAI_GPT_LIVE_AUTH_REQUIRED ||
    message === OPENAI_GPT_LIVE_AUTHORED_PLATFORM_AUTH_UNAVAILABLE ||
    message === OPENAI_GPT_LIVE_PUBLIC_AUTH_REQUIRED ||
    message === OPENAI_GPT_LIVE_PUBLIC_AUTHORED_PLATFORM_AUTH_UNAVAILABLE
  ) {
    return message;
  }
  return "OpenAI GPT-Live authentication failed";
}

export function projectOpenAIQuicksilverErrorMessage(
  kind: "gateway" | "provider" | "transport",
): string {
  switch (kind) {
    case "gateway":
      return "OpenAI GPT-Live gateway relay failed";
    case "provider":
      return "OpenAI GPT-Live provider error";
    case "transport":
      return "OpenAI GPT-Live transport failed";
  }
  throw new Error("Unexpected realtime error category");
}
