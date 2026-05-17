import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_RESPONSES_API = "openai-responses";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";

export type CodexLocalRuntimeAttribution = {
  provider: string;
  api?: string;
};

function normalizeRuntimeId(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

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
      provider: OPENAI_CODEX_PROVIDER_ID,
      api: OPENAI_CODEX_RESPONSES_API,
    };
  }

  return {
    provider: params.provider,
    api: params.model.api,
  };
}
