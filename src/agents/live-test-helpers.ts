/**
 * Shared helpers for live provider tests and timeout-wrapped completions.
 */
import { isTruthyEnvValue } from "../infra/env.js";
import { completeSimple } from "../llm/stream.js";
import type { Api, Model } from "../llm/types.js";

// Shared live-test helpers. Live lanes opt in via env flags and use guarded
// model calls so missing credentials skip cleanly instead of hanging tests.
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

/** Return whether a provider requires profile credentials in the current live mode. */
export function requiresLiveProfileCredential(
  provider: string,
  requireProfileKeys: boolean,
): boolean {
  return requireProfileKeys || provider === "openai";
}

/** Resolve whether profile or env credentials should be tried first. */
export function resolveLiveCredentialPrecedence(
  provider: string,
  requireProfileKeys: boolean,
): "profile-first" | "env-first" {
  return requiresLiveProfileCredential(provider, requireProfileKeys)
    ? "profile-first"
    : "env-first";
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

export type CompleteSimpleContent<TApi extends Api = Api> = Awaited<
  ReturnType<typeof completeSimple<TApi>>
>["content"];

/** Write a namespaced live-test progress line to stderr. */
export function logLiveProgress(message: string): void {
  process.stderr.write(`[live] ${message}\n`);
}

/** Run completeSimple with abort and hard-timeout guards for live tests. */
export async function completeSimpleWithTimeout<TApi extends Api>(
  model: Model<TApi>,
  context: Parameters<typeof completeSimple<TApi>>[1],
  options: Parameters<typeof completeSimple<TApi>>[2],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof completeSimple<TApi>>>> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  abortTimer.unref?.();
  try {
    return await Promise.race([
      completeSimple(model, context, {
        ...options,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        const hardTimer = setTimeout(() => {
          reject(new Error(`model call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        hardTimer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(abortTimer);
  }
}
