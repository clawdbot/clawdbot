import { isTruthyEnvValue } from "../infra/env.js";

const LIVE_OK_PROMPT = "Reply with the word ok.";

export function isLiveTestEnabled(
  extraEnvVars: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return [...extraEnvVars, "LIVE", "OPENCLAW_LIVE_TEST"].some((name) =>
    isTruthyEnvValue(env[name]),
  );
}

export function isLiveProfileKeyModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
}

export function createSingleUserPromptMessage(content = LIVE_OK_PROMPT) {
  return [
    {
      role: "user" as const,
      content,
      timestamp: Date.now(),
    },
  ];
}

export function extractNonEmptyAssistantText(
  content: Array<{
    type?: string;
    text?: string;
  }>,
) {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}
