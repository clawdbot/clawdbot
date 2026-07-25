import { isTruthyEnvValue } from "../infra/env.js";

const LIVE_OK_PROMPT = "Reply with the word ok.";

/** Return whether live tests are enabled by standard or caller-specific env flags. */
export function isLiveTestEnabled(
  extraEnvVars: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return [...extraEnvVars, "LIVE", "OPENCLAW_LIVE_TEST"].some((name) =>
    isTruthyEnvValue(env[name]),
  );
}

/** Return whether live tests must prefer profile credentials over env keys. */
export function isLiveProfileKeyModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS);
}

/** Build a single user-message prompt for simple live model probes. */
export function createSingleUserPromptMessage(content = LIVE_OK_PROMPT) {
  return [
    {
      role: "user" as const,
      content,
      timestamp: Date.now(),
    },
  ];
}

/** Extract non-empty assistant text from content blocks. */
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
