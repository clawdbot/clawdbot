import { definePluginEntry, type ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFirstGithubToken } from "./auth.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { PROVIDER_ID, resolveCopilotForwardCompatModel } from "./models.js";
import { buildGithubCopilotReplayPolicy } from "./replay-policy.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
const COPILOT_XHIGH_MODEL_IDS = ["gpt-5.4", "gpt-5.2", "gpt-5.2-codex"] as const;

type GithubCopilotPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}
export default definePluginEntry({
  id: "github-copilot",
  name: "GitHub Copilot Provider",
  description: "Bundled GitHub Copilot provider plugin",
  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as GithubCopilotPluginConfig;

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
            profileId: "github-copilot:github",
            credential,
          },
        ],
        defaultModel: "github-copilot/claude-opus-4.6",
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
