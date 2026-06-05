/**
 * Resolves the provider/api attribution used when a local Codex runtime is
 * backed by OpenAI auth but should still report Codex Responses semantics.
 */
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_CODEX_RESPONSES_API = "openai-chatgpt-responses";

/** Provider identity that downstream telemetry should attribute to the local Codex turn. */
export type CodexLocalRuntimeAttribution = {
  provider: string;
  api?: string;
};

function normalizeRuntimeId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

/** Maps local Codex runtime plans onto the provider/api pair exposed to event projection. */
export function resolveCodexLocalRuntimeAttribution(
  params: EmbeddedRunAttemptParams,
): CodexLocalRuntimeAttribution {
  const authProfileProvider = normalizeRuntimeId(
    params.runtimePlan?.auth?.authProfileProviderForAuth,
  );
  if (
    normalizeRuntimeId(params.runtimePlan?.observability.harnessId) === "codex" &&
    authProfileProvider !== OPENAI_PROVIDER_ID &&
    normalizeRuntimeId(params.model.provider) === OPENAI_PROVIDER_ID &&
    normalizeRuntimeId(params.model.api) === OPENAI_RESPONSES_API
  ) {
    return {
      provider: OPENAI_PROVIDER_ID,
      api: OPENAI_CODEX_RESPONSES_API,
    };
  }

  return {
    provider: params.provider,
    api: params.model.api,
  };
}
