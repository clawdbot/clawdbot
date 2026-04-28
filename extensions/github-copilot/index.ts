import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  coerceSecretRef,
  ensureAuthProfileStore,
  listProfilesForProvider,
  normalizeOptionalSecretInput,
  resolveDefaultSecretProviderAlias,
  upsertAuthProfileWithLock,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const DEFAULT_COPILOT_MODEL = "github-copilot/claude-opus-4.7";
const DEFAULT_COPILOT_PROFILE_ID = "github-copilot:github";
const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex"] as const;

type GithubCopilotPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}

function applyCopilotDefaultModel(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel.trim()
      : typeof existingModel === "object" && typeof existingModel?.primary === "string"
        ? existingModel.primary.trim()
        : "";
  if (existingPrimary) {
    return cfg;
  }
  const fallbacks =
    typeof existingModel === "object" && existingModel !== null && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(fallbacks ? { fallbacks } : undefined),
          primary: DEFAULT_COPILOT_MODEL,
        },
        models: {
          ...defaults?.models,
          [DEFAULT_COPILOT_MODEL]: defaults?.models?.[DEFAULT_COPILOT_MODEL] ?? {},
        },
      },
    },
  };
}

function resolveExistingCopilotTokenProfileId(agentDir?: string): string | undefined {
  const authStore = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(authStore, PROVIDER_ID).find((profileId) => {
    const profile = authStore.profiles[profileId];
    if (profile?.type !== "token") {
      return false;
    }
    return Boolean(
      normalizeOptionalSecretInput(profile.token) || coerceSecretRef(profile.tokenRef)?.id.trim(),
    );
  });
}

async function resolveCopilotNonInteractiveToken(
  ctx: ProviderAuthMethodNonInteractiveContext,
  flagValue: string | undefined,
) {
  const resolveFromEnvChain = async () => {
    for (const envVar of COPILOT_ENV_VARS) {
      const resolved = await ctx.resolveApiKey({
        provider: PROVIDER_ID,
        flagName: "--github-copilot-token",
        envVar,
        envVarName: envVar,
        allowProfile: false,
        required: false,
      });
      if (resolved) {
        return resolved;
      }
    }
    return null;
  };

  if (ctx.opts.secretInputMode === "ref") {
    const resolved = await resolveFromEnvChain();
    if (resolved) {
      return resolved;
    }
    if (flagValue) {
      ctx.runtime.error(
        [
          "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN is set in env.",
          "Set one of those env vars and omit --github-copilot-token, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      ctx.runtime.exit(1);
    }
    return null;
  }

  const primary = await ctx.resolveApiKey({
    provider: PROVIDER_ID,
    flagValue,
    flagName: "--github-copilot-token",
    envVar: COPILOT_ENV_VARS[0],
    envVarName: COPILOT_ENV_VARS[0],
    allowProfile: false,
    required: false,
  });
  if (primary || flagValue) {
    return primary;
  }

  for (const envVar of COPILOT_ENV_VARS.slice(1)) {
    const resolved = await ctx.resolveApiKey({
      provider: PROVIDER_ID,
      flagName: "--github-copilot-token",
      envVar,
      envVarName: envVar,
      allowProfile: false,
      required: false,
    });
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function runGitHubCopilotNonInteractiveAuth(
  ctx: ProviderAuthMethodNonInteractiveContext,
): Promise<OpenClawConfig | null> {
  const opts = ctx.opts as Record<string, unknown> | undefined;
  const flagValue = normalizeOptionalSecretInput(opts?.githubCopilotToken);
  const resolved = await resolveCopilotNonInteractiveToken(ctx, flagValue);

  let profileId = DEFAULT_COPILOT_PROFILE_ID;
  if (resolved) {
    const useTokenRef = ctx.opts.secretInputMode === "ref" && resolved.source === "env";
    if (useTokenRef && !resolved.envVarName) {
      ctx.runtime.error(
        [
          '--secret-input-mode ref requires an explicit environment variable for provider "github-copilot".',
          "Set COPILOT_GITHUB_TOKEN in env and retry, or use --secret-input-mode plaintext.",
        ].join("\n"),
      );
      ctx.runtime.exit(1);
      return null;
    }
    await upsertAuthProfileWithLock({
      profileId,
      credential: {
        type: "token",
        provider: PROVIDER_ID,
        ...(useTokenRef
          ? {
              tokenRef: {
                source: "env",
                provider: resolveDefaultSecretProviderAlias(ctx.baseConfig, "env", {
                  preferFirstProviderForSource: true,
                }),
                id: resolved.envVarName!,
              },
            }
          : { token: resolved.key }),
      },
      agentDir: ctx.agentDir,
    });
  } else {
    if (flagValue && ctx.opts.secretInputMode === "ref") {
      return null;
    }
    const existingProfileId = resolveExistingCopilotTokenProfileId(ctx.agentDir);
    if (!existingProfileId) {
      ctx.runtime.error(
        "Missing --github-copilot-token (or COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN env var) for --auth-choice github-copilot.",
      );
      ctx.runtime.exit(1);
      return null;
    }
    profileId = existingProfileId;
  }

  return applyCopilotDefaultModel(
    applyAuthProfileConfig(ctx.config, {
      profileId,
      provider: PROVIDER_ID,
      mode: "token",
    }),
  );
}

export default definePluginEntry({
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  description: "Bundled GitHub Copilot provider plugin",
  register(api) {
    const startupPluginConfig = (api.pluginConfig ?? {}) as GithubCopilotPluginConfig;

    function resolveCurrentPluginConfig(config?: OpenClawConfig): GithubCopilotPluginConfig {
      const runtimePluginConfig = resolvePluginConfigObject(config, "github-copilot");
      if (runtimePluginConfig) {
        return runtimePluginConfig as GithubCopilotPluginConfig;
      }
      return config ? {} : startupPluginConfig;
    }

    async function runGitHubCopilotAuth(ctx: ProviderAuthContext) {
      const { githubCopilotLoginCommand } = await loadGithubCopilotRuntime();
      await ctx.prompter.note(
        [
          "This will open a GitHub device login to authorize Copilot.",
          "Requires an active GitHub Copilot subscription.",
        ].join("\n"),
        "GitHub Copilot",
      );

      if (!process.stdin.isTTY) {
        await ctx.prompter.note(
          "GitHub Copilot login requires an interactive TTY.",
          "GitHub Copilot",
        );
        return { profiles: [] };
      }

      try {
        await githubCopilotLoginCommand(
          { yes: true, profileId: "github-copilot:github" },
          ctx.runtime,
        );
      } catch (err) {
        await ctx.prompter.note(`GitHub Copilot login failed: ${String(err)}`, "GitHub Copilot");
        return { profiles: [] };
      }

      const authStore = ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      });
      const credential = authStore.profiles["github-copilot:github"];
      if (!credential || credential.type !== "token") {
        return { profiles: [] };
      }

      return {
        profiles: [
          {
            profileId: DEFAULT_COPILOT_PROFILE_ID,
            credential,
          },
        ],
        defaultModel: DEFAULT_COPILOT_MODEL,
      };
    }

    api.registerMemoryEmbeddingProvider(githubCopilotMemoryEmbeddingProviderAdapter);

    api.registerProvider({
      id: PROVIDER_ID,
      label: "GitHub Copilot",
      docsPath: "/providers/models",
      envVars: COPILOT_ENV_VARS,
      auth: [
        {
          id: "device",
          label: "GitHub device login",
          hint: "Browser device-code flow",
          kind: "device_code",
          run: async (ctx) => await runGitHubCopilotAuth(ctx),
          runNonInteractive: async (ctx) => await runGitHubCopilotNonInteractiveAuth(ctx),
        },
      ],
      wizard: {
        setup: {
          choiceId: "github-copilot",
          choiceLabel: "GitHub Copilot",
          choiceHint: "Device login with your GitHub account",
          methodId: "device",
        },
      },
      catalog: {
        order: "late",
        run: async (ctx) => {
          const pluginConfig = resolveCurrentPluginConfig(ctx.config);
          const discoveryEnabled =
            pluginConfig.discovery?.enabled ?? ctx.config?.models?.copilotDiscovery?.enabled;
          if (discoveryEnabled === false) {
            return null;
          }
          const { DEFAULT_COPILOT_API_BASE_URL, resolveCopilotApiToken } =
            await loadGithubCopilotRuntime();
          const { githubToken, hasProfile } = await resolveFirstGithubToken({
            agentDir: ctx.agentDir,
            config: ctx.config,
            env: ctx.env,
          });
          if (!hasProfile && !githubToken) {
            return null;
          }
          let baseUrl = DEFAULT_COPILOT_API_BASE_URL;
          if (githubToken) {
            try {
              const token = await resolveCopilotApiToken({
                githubToken,
                env: ctx.env,
              });
              baseUrl = token.baseUrl;
            } catch {
              baseUrl = DEFAULT_COPILOT_API_BASE_URL;
            }
          }
          return {
            provider: {
              baseUrl,
              models: [],
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => resolveCopilotForwardCompatModel(ctx),
      wrapStreamFn: wrapCopilotProviderStream,
      buildReplayPolicy: ({ modelId }) => buildGithubCopilotReplayPolicy(modelId),
      resolveThinkingProfile: ({ modelId }) => ({
        levels: [
          { id: "off" },
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          ...(COPILOT_XHIGH_MODEL_IDS.includes(
            (normalizeOptionalLowercaseString(modelId) ?? "") as never,
          )
            ? [{ id: "xhigh" as const }]
            : []),
        ],
      }),
      prepareRuntimeAuth: async (ctx) => {
        const { resolveCopilotApiToken } = await loadGithubCopilotRuntime();
        const token = await resolveCopilotApiToken({
          githubToken: ctx.apiKey,
          env: ctx.env,
        });
        return {
          apiKey: token.token,
          baseUrl: token.baseUrl,
          expiresAt: token.expiresAt,
        };
      },
      resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
      fetchUsageSnapshot: async (ctx) => {
        const { fetchCopilotUsage } = await loadGithubCopilotRuntime();
        return await fetchCopilotUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
      },
    });
  },
});
