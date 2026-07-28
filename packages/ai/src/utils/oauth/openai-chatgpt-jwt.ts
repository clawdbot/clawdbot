// OpenAI ChatGPT JWT helpers inspect auth claims for ChatGPT OAuth sessions.
const OPENAI_CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export type OpenAICodexJwtPayload = {
  [OPENAI_CODEX_AUTH_CLAIM]?: {
    chatgpt_account_id?: unknown;
  };
  [key: string]: unknown;
};

export function decodeOpenAICodexJwtPayload(token: string): OpenAICodexJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as OpenAICodexJwtPayload)
      : null;
  } catch {
    return null;
  }
}

export function resolveOpenAICodexAccountId(token: string): string | null {
  const accountId =
    decodeOpenAICodexJwtPayload(token)?.[OPENAI_CODEX_AUTH_CLAIM]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}
