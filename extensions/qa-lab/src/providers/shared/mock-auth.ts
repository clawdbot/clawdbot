import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { applyAuthProfileConfig } from "openclaw/plugin-sdk/provider-auth-api-key";
import { resolveQaAgentAuthDir, writeQaAuthProfiles } from "./auth-store.js";

/** Providers the mock harness stages placeholder credentials for by default. */
export const QA_MOCK_AUTH_PROVIDERS = Object.freeze(["openai", "anthropic"] as const);

/** Agent IDs the mock harness stages credentials under. */
export const QA_MOCK_AUTH_AGENT_IDS = Object.freeze(["main", "qa"] as const);

export function buildQaMockProfileId(provider: string): string {
  return `qa-mock-${provider}`;
}

/**
 * In mock provider modes the qa suite runs against an embedded mock server
 * instead of a real provider API. The mock does not validate credentials, but
 * the agent auth layer still needs a matching `api_key` auth profile in
 * `auth-profiles.json` before it will route the request through
 * `providerBaseUrl`. Without this staging step, every scenario fails with
 * `FailoverError: No API key found for provider "openai"` before the mock
 * server ever sees a request.
 *
 * Stages a placeholder `api_key` profile per provider in each of the agent
 * dirs the qa suite uses (`main` for the runtime config, `qa` for scenario
 * runs) and returns a config with matching `auth.profiles` entries so the
 * runtime accepts the profile on the first lookup.
 *
 * The placeholder value `qa-mock-not-a-real-key` is intentionally not
 * shaped like a real API key (no `sk-` prefix that would trip secret
 * scanners). It only needs to be non-empty to pass the credential
 * serializer; anything beyond that is ignored by the mock.
 */
export async function stageQaMockAuthProfiles(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  agentIds?: readonly string[];
  providers?: readonly string[];
}): Promise<OpenClawConfig> {
  const agentIds = [...new Set(params.agentIds ?? QA_MOCK_AUTH_AGENT_IDS)];
  const providers = [...new Set(params.providers ?? QA_MOCK_AUTH_PROVIDERS)];
  let next = params.cfg;
  for (const agentId of agentIds) {
    await writeQaAuthProfiles({
      agentDir: resolveQaAgentAuthDir({ stateDir: params.stateDir, agentId }),
      profiles: Object.fromEntries(
        providers.map((provider) => [
          buildQaMockProfileId(provider),
          {
            type: "api_key",
            provider,
            key: "qa-mock-not-a-real-key",
            displayName: `QA mock ${provider} credential`,
          },
        ]),
      ),
    });
  }
  for (const provider of providers) {
    next = applyAuthProfileConfig(next, {
      profileId: buildQaMockProfileId(provider),
      provider,
      mode: "api_key",
      displayName: `QA mock ${provider} credential`,
    });
  }
  return next;
}
