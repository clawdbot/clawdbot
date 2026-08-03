/**
 * Shared contract fixtures for agent auth profile runtime behavior.
 */
import {
  resolveProviderIdForAuth,
  type ProviderAuthAliasLookupParams,
} from "../../../agents/provider-auth-aliases.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";

export const AUTH_PROFILE_RUNTIME_CONTRACT = {
  sessionId: "session-auth-contract",
  sessionKey: "agent:main:auth-contract",
  runId: "run-auth-contract",
  workspacePrompt: "continue with the bound Codex profile",
  openAiProvider: "openai",
  openAiCodexProvider: "openai",
  codexCliProvider: "codex-cli",
  codexHarnessProvider: "codex",
  claudeCliProvider: "claude-cli",
  openAiProfileId: "openai:work",
  openAiCodexProfileId: "openai:work",
  anthropicProfileId: "anthropic:work",
} as const;

export function createAuthAliasManifestRegistry(): PluginManifestRegistry {
  return {
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/openclaw-auth-contract-plugin",
        source: "test",
        manifestPath: "/tmp/openclaw-auth-contract-plugin/plugin.json",
        providerAuthAliases: {
          [AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider]:
            AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
          [AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider]:
            AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
        },
        providerAuthChoices: [
          {
            provider: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
            method: "oauth",
            choiceId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiProvider,
            deprecatedChoiceIds: [
              AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProvider,
              AUTH_PROFILE_RUNTIME_CONTRACT.codexCliProvider,
            ],
          },
        ],
      },
    ],
    diagnostics: [],
  };
}

export function expectedForwardedAuthProfile(params: {
  provider: string;
  authProfileProvider: string;
  aliasLookupParams: ProviderAuthAliasLookupParams;
  sessionAuthProfileId: string | undefined;
}): string | undefined {
  return resolveProviderIdForAuth(params.provider, params.aliasLookupParams) ===
    resolveProviderIdForAuth(params.authProfileProvider, params.aliasLookupParams)
    ? params.sessionAuthProfileId
    : undefined;
}
