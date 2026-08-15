// Github Copilot plugin entrypoint registers its OpenClaw integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  definePluginEntry,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderAuthMethodNonInteractiveContext,
  type UnifiedModelCatalogEntry,
  type UnifiedModelCatalogProviderContext,
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
import { resolveFirstGithubToken } from "./auth.js";
import {
  normalizeGithubCopilotDomain,
  PUBLIC_GITHUB_COPILOT_DOMAIN,
  resolveGithubCopilotDomain,
} from "./domain.js";
import { createGithubCopilotDynamicModelHooks } from "./dynamic-models.js";
import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";
import { DEFAULT_COPILOT_MODEL, resolveCopilotExtendedThinkingLevels } from "./model-metadata.js";
import { PROVIDER_ID } from "./models.js";
import {
  buildGithubCopilotAuthDoctorHint,
  formatGithubCopilotApiKey,
  loginGithubCopilotOAuth,
  parseGithubCopilotApiKey,
  refreshGithubCopilotOAuth,
} from "./oauth.js";
import {
  buildGithubCopilotReplayPolicy,
  sanitizeGithubCopilotReplayHistory,
} from "./replay-policy.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";
import { wrapCopilotProviderStream } from "./stream.js";

const COPILOT_ENV_VARS: [string, string, string] = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];
const DEFAULT_COPILOT_PROFILE_ID = "github-copilot:github";

type GithubCopilotPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

async function loadGithubCopilotRuntime() {
  return await import("./register.runtime.js");
}

function resolveCopilotConfiguredPrimary(cfg: OpenClawConfig): string {
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  return typeof existingModel === "string"
    ? existingModel.trim()
    : typeof existingModel === "object" && typeof existingModel?.primary === "string"
      ? existingModel.primary.trim()
      : "";
}

function applyCopilotDefaultModel(cfg: OpenClawConfig, modelRef: string): OpenClawConfig {
  if (resolveCopilotConfiguredPrimary(cfg)) {
    return cfg;
  }
  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
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
          primary: modelRef,
        },
        models: {
          ...defaults?.models,
          [modelRef]: defaults?.models?.[modelRef] ?? {},
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

function resolveExistingCopilotAuthResult(agentDir?: string): ProviderAuthResult | null {
  const profileId = resolveExistingCopilotTokenProfileId(agentDir);
  if (!profileId) {
    return null;
  }
  const authStore = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const credential = authStore.profiles[profileId];
  if (!credential || credential.type !== "token") {
    return null;
  }
  return {
    profiles: [
      {
        profileId,
        credential,
      },
    ],
  };
}

async function resolveInteractiveCopilotStarterModel(params: {
  ctx: ProviderAuthContext;
  githubToken: string;
  githubDomain: string;
}): Promise<Pick<ProviderAuthResult, "defaultModel" | "notes">> {
  try {
    const { resolveCopilotStarterModel } = await loadGithubCopilotRuntime();
    return {
      defaultModel: await resolveCopilotStarterModel({
        githubToken: params.githubToken,
        env: params.ctx.env ?? process.env,
        githubDomain: params.githubDomain,
        config: params.ctx.config,
      }),
    };
  } catch {
    // Interactive auth must not discard a valid durable credential when live
    // discovery is transiently unavailable. The following model picker can
    // retry discovery or let the user retain an explicit model selection.
    return {
      notes: [
        "GitHub Copilot authentication succeeded, but no eligible live model could be selected. Choose a model after checking your Copilot plan and organization policy.",
      ],
    };
  }
}

// Persists the chosen enterprise Copilot host under the provider's free-form
// params bag. The completions base URL is derived at runtime (token proxy hint
// or tenant fallback), so only the host is stored here. Mirror of
// clearGithubCopilotDomainConfigPatch; both are provider-owned and live with the
// plugin rather than the shared SDK.
function buildGithubCopilotDomainConfigPatch(domain: string): Partial<OpenClawConfig> {
  const normalized = normalizeGithubCopilotDomain(domain);
  return {
    models: {
      providers: {
        [PROVIDER_ID]: { params: { githubDomain: normalized } },
      },
    },
  } as unknown as Partial<OpenClawConfig>;
}

// Removes a previously persisted enterprise domain so config falls back to the
// "no config == github.com" default. Undefined leaves are deleted on merge.
function clearGithubCopilotDomainConfigPatch(): Partial<OpenClawConfig> {
  return {
    models: {
      providers: {
        [PROVIDER_ID]: { params: { githubDomain: undefined } },
      },
    },
  } as unknown as Partial<OpenClawConfig>;
}

function applyGithubCopilotDomainToConfig(
  config: OpenClawConfig,
  domain: string,
  previousDomain: string,
): OpenClawConfig {
  const isEnterprise = domain !== PUBLIC_GITHUB_COPILOT_DOMAIN;
  const shouldClear = !isEnterprise && previousDomain !== PUBLIC_GITHUB_COPILOT_DOMAIN;
  if (!isEnterprise && !shouldClear) {
    return config;
  }

  const models = config.models ?? {};
  const providers = models.providers ?? {};
  const provider = providers[PROVIDER_ID];
  const params: Record<string, unknown> = {};
  if (provider?.params) {
    Object.assign(params, provider.params);
  }
  if (isEnterprise) {
    params.githubDomain = domain;
  } else {
    delete params.githubDomain;
  }
  const nextProviders = { ...providers };
  if (provider) {
    nextProviders[PROVIDER_ID] = { ...provider, params };
  } else {
    // Source config accepts partial provider inputs; catalog materialization
    // supplies baseUrl/models before runtime consumption.
    Object.assign(nextProviders, { [PROVIDER_ID]: { params } });
  }

  return {
    ...config,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
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
  let githubToken = resolved?.key ?? "";
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
    const existing = await resolveFirstGithubToken({
      agentDir: ctx.agentDir,
      config: ctx.config,
      env: process.env,
      profileId,
    });
    githubToken = existing.githubToken;
  }

  const resolvedDomain = resolveGithubCopilotDomain({ config: ctx.config });
  const previousDomain = resolveGithubCopilotDomain({ env: {}, config: ctx.config });
  const configWithDomain = applyGithubCopilotDomainToConfig(
    ctx.config,
    resolvedDomain,
    previousDomain,
  );

  let starterModel: string | undefined;
  if (!resolveCopilotConfiguredPrimary(configWithDomain)) {
    const { resolveCopilotStarterModel } = await loadGithubCopilotRuntime();
    starterModel = await resolveCopilotStarterModel({
      githubToken,
      env: process.env,
      githubDomain: resolvedDomain,
      config: configWithDomain,
    });
  } else if (resolved) {
    // An explicit model does not need starter selection, but a newly supplied
    // credential must still be validated before it can replace stored auth.
    const { resolveCopilotRuntimeAuth } = await loadGithubCopilotRuntime();
    await resolveCopilotRuntimeAuth({
      githubToken,
      env: process.env,
      githubDomain: resolvedDomain,
      config: configWithDomain,
    });
  }

  // Validate the credential and its account-visible default before persisting
  // a newly supplied token. A failed unattended setup must not leave partial
  // auth state that appears usable on the next run.
  if (resolved) {
    const useTokenRef = ctx.opts.secretInputMode === "ref" && resolved.source === "env";
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
  }

  const configWithAuth = applyAuthProfileConfig(configWithDomain, {
    profileId,
    provider: PROVIDER_ID,
    mode: "token",
  });
  return starterModel ? applyCopilotDefaultModel(configWithAuth, starterModel) : configWithAuth;
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
    const dynamicModels = createGithubCopilotDynamicModelHooks({
      discoveryEnabled: (config) => resolveCurrentPluginConfig(config).discovery?.enabled !== false,
    });

    async function runGithubCopilotUnifiedLiveCatalog(
      ctx: UnifiedModelCatalogProviderContext,
    ): Promise<UnifiedModelCatalogEntry[] | null> {
      const result = await dynamicModels.runCatalog(ctx);
      if (!result || !("provider" in result)) {
        return null;
      }
      return (result.provider.models ?? []).map((model) => {
        const entry: UnifiedModelCatalogEntry = {
          kind: "text",
          provider: PROVIDER_ID,
          model: model.id,
          source: "live",
        };
        if (model.name) {
          entry.label = model.name;
        }
        return entry;
      });
    }

    async function promptForEnterpriseDomain(ctx: ProviderAuthContext): Promise<string | null> {
      // COPILOT_GITHUB_DOMAIN is authoritative for every runtime routing path
      // (token refresh, usage, completions). Honor it here too when it is set so
      // the persisted config and freshly minted token can never diverge from the
      // host the runtime actually calls; a typed prompt value could otherwise
      // silently disagree with the env override.
      const envDomain = ctx.env?.COPILOT_GITHUB_DOMAIN?.trim();
      if (envDomain) {
        const normalizedEnv = normalizeGithubCopilotDomain(envDomain);
        await ctx.prompter.note(
          `Using the GitHub Enterprise domain from COPILOT_GITHUB_DOMAIN (${normalizedEnv}). Unset it to enter a different domain interactively.`,
          "GitHub Copilot",
        );
        return normalizedEnv;
      }
      const current = resolveGithubCopilotDomain({ env: ctx.env, config: ctx.config });
      const value = await ctx.prompter.text({
        message: "GitHub Enterprise domain (data residency)",
        placeholder: "your-org.ghe.com",
        initialValue: current === PUBLIC_GITHUB_COPILOT_DOMAIN ? "" : current,
        validate: (raw) => {
          const trimmed = raw.trim();
          if (!trimmed) {
            return "Enter your GitHub Enterprise domain (for example your-org.ghe.com).";
          }
          if (
            normalizeGithubCopilotDomain(trimmed) === PUBLIC_GITHUB_COPILOT_DOMAIN &&
            trimmed.toLowerCase() !== PUBLIC_GITHUB_COPILOT_DOMAIN
          ) {
            // GitHub's GHE docs list derived service hosts (api.<tenant>.ghe.com,
            // copilot-api.<tenant>.ghe.com) that users are likely to paste; point
            // them at the tenant root instead of the generic hostname message.
            if (trimmed.toLowerCase().endsWith(".ghe.com")) {
              return "Enter your tenant root (for example your-org.ghe.com), not a service host like api.your-org.ghe.com — service endpoints are derived automatically.";
            }
            return "Enter a github.com or *.ghe.com hostname without scheme or path (for example your-org.ghe.com).";
          }
          return undefined;
        },
      });
      const domain = normalizeGithubCopilotDomain(value);
      return domain;
    }

    async function runGitHubCopilotDeviceAuth(
      ctx: ProviderAuthContext,
      domain: string,
    ): Promise<ProviderAuthResult> {
      const normalizedDomain = normalizeGithubCopilotDomain(domain);
      const isEnterprise = normalizedDomain !== PUBLIC_GITHUB_COPILOT_DOMAIN;
      // Domain the currently stored profile was actually minted under. This must
      // come from PERSISTED CONFIG ONLY (never COPILOT_GITHUB_DOMAIN): a
      // successful login writes its tenant to config (enterprise) or leaves it
      // absent (github.com), so config reflects the stored token's true tenant.
      // Reading env here would let an env-selected tenant masquerade as the
      // previous domain, making domainChanged=false and offering to reuse a
      // public-minted token instead of forcing a fresh tenant device login.
      const previousDomain = resolveGithubCopilotDomain({ env: {}, config: ctx.config });
      const domainChanged = previousDomain !== normalizedDomain;
      // Enterprise logins persist the tenant domain. Switching back to github.com
      // clears any persisted tenant so the default (no config == github.com) is
      // restored; github.com stays absent otherwise to avoid redundant noise.
      const configPatch = isEnterprise
        ? buildGithubCopilotDomainConfigPatch(normalizedDomain)
        : previousDomain !== PUBLIC_GITHUB_COPILOT_DOMAIN
          ? clearGithubCopilotDomainConfigPatch()
          : undefined;

      const existing = resolveExistingCopilotAuthResult(ctx.agentDir);
      // Only offer to reuse the stored token when it was minted for the same
      // domain. A domain switch (either direction) must re-run the device flow so
      // the token is tenant-scoped to the domain being written to config.
      if (existing && !domainChanged) {
        const runLogin = await ctx.prompter.confirm({
          message: "GitHub Copilot auth already exists. Re-run login?",
          initialValue: false,
        });
        if (!runLogin) {
          const profileId = existing.profiles[0]?.profileId;
          const { githubToken } = await resolveFirstGithubToken({
            agentDir: ctx.agentDir,
            config: ctx.config,
            env: ctx.env ?? process.env,
            ...(profileId ? { profileId } : {}),
          });
          const starter = await resolveInteractiveCopilotStarterModel({
            ctx,
            githubToken,
            githubDomain: normalizedDomain,
          });
          return { ...existing, ...starter, ...(configPatch ? { configPatch } : {}) };
        }
      } else if (existing && domainChanged) {
        await ctx.prompter.note(
          isEnterprise
            ? `Switching to ${normalizedDomain} requires a new tenant login to authorize Copilot for that domain.`
            : "Switching back to github.com requires a new login to authorize Copilot for the public domain.",
          "GitHub Copilot",
        );
      }

      await ctx.prompter.note(
        [
          isEnterprise
            ? `This will open a GitHub Enterprise device login (${normalizedDomain}) to authorize Copilot.`
            : "This will open a GitHub device login to authorize Copilot.",
          "Requires an active GitHub Copilot subscription.",
        ].join("\n"),
        "GitHub Copilot",
      );

      const { runGitHubCopilotDeviceFlow } = await import("./login.js");

      const result = await runGitHubCopilotDeviceFlow(
        {
          showCode: async ({ verificationUrl, userCode, expiresInMs }) => {
            const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
            if (ctx.isRemote) {
              await ctx.openUrl(verificationUrl);
            }
            await ctx.prompter.note(
              [
                "Open this URL in your browser and enter the code below.",
                `URL: ${verificationUrl}`,
                `Code: ${userCode}`,
                `Code expires in ${expiresInMinutes} minutes. Never share it.`,
                "",
                "If a browser does not open automatically after you continue, copy the URL manually.",
              ].join("\n"),
              "Authorize GitHub Copilot",
            );
          },
          ...(ctx.isRemote
            ? {}
            : {
                openUrl: async (url: string) => {
                  await ctx.openUrl(url);
                },
              }),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
        normalizedDomain,
      );

      if (result.status === "access_denied") {
        await ctx.prompter.note("GitHub Copilot login was cancelled.", "GitHub Copilot");
        return { profiles: [] };
      }

      if (result.status === "expired") {
        await ctx.prompter.note(
          "The GitHub device code expired. Retry login to get a new code.",
          "GitHub Copilot",
        );
        return { profiles: [] };
      }

      const starter = await resolveInteractiveCopilotStarterModel({
        ctx,
        githubToken: result.accessToken,
        githubDomain: normalizedDomain,
      });
      return {
        profiles: [
          {
            profileId: DEFAULT_COPILOT_PROFILE_ID,
            credential: {
              type: "token" as const,
              provider: PROVIDER_ID,
              token: result.accessToken,
            },
          },
        ],
        ...starter,
        ...(configPatch ? { configPatch } : {}),
      };
    }

    async function runGitHubCopilotAuth(ctx: ProviderAuthContext) {
      return await runGitHubCopilotDeviceAuth(ctx, PUBLIC_GITHUB_COPILOT_DOMAIN);
    }

    async function runGitHubCopilotEnterpriseAuth(ctx: ProviderAuthContext) {
      const domain = await promptForEnterpriseDomain(ctx);
      if (!domain) {
        await ctx.prompter.note("Enterprise login cancelled.", "GitHub Copilot");
        return { profiles: [] };
      }
      if (domain === PUBLIC_GITHUB_COPILOT_DOMAIN) {
        await ctx.prompter.note(
          "github.com is the default — use the standard GitHub Copilot login instead of the enterprise (data residency) option.",
          "GitHub Copilot",
        );
        return { profiles: [] };
      }
      return await runGitHubCopilotDeviceAuth(ctx, domain);
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
          starterModel: DEFAULT_COPILOT_MODEL,
          run: async (ctx) => await runGitHubCopilotAuth(ctx),
          runNonInteractive: async (ctx) => await runGitHubCopilotNonInteractiveAuth(ctx),
        },
        {
          id: "device-enterprise",
          label: "GitHub Enterprise device login (data residency)",
          hint: "Device-code flow against your *.ghe.com tenant",
          kind: "device_code",
          run: async (ctx) => await runGitHubCopilotEnterpriseAuth(ctx),
          wizard: {
            choiceId: "github-copilot-enterprise",
            choiceLabel: "GitHub Copilot (Enterprise / data residency)",
            choiceHint: "Device login against your GitHub Enterprise (*.ghe.com) tenant",
            methodId: "device-enterprise",
            assistantPriority: 2,
            modelSelection: {
              promptWhenAuthChoiceProvided: true,
            },
          },
        },
      ],
      wizard: {
        setup: {
          choiceId: "github-copilot",
          choiceLabel: "GitHub Copilot",
          choiceHint: "Device login with your GitHub account",
          methodId: "device",
          assistantPriority: 1,
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
          },
        },
      },
      catalog: {
        order: "late",
        run: dynamicModels.runCatalog,
      },
      prepareDynamicModel: dynamicModels.prepareDynamicModel,
      resolveDynamicModel: dynamicModels.resolveDynamicModel,
      preferRuntimeResolvedModel: dynamicModels.preferRuntimeResolvedModel,
      formatApiKey: formatGithubCopilotApiKey,
      loginOAuth: loginGithubCopilotOAuth,
      refreshOAuth: async (credential) => refreshGithubCopilotOAuth(credential),
      buildAuthDoctorHint: buildGithubCopilotAuthDoctorHint,
      wrapStreamFn: wrapCopilotProviderStream,
      buildReplayPolicy: ({ modelId }) => buildGithubCopilotReplayPolicy(modelId),
      sanitizeReplayHistory: sanitizeGithubCopilotReplayHistory,
      resolveThinkingProfile: ({ modelId, compat }) => {
        const extendedLevels = resolveCopilotExtendedThinkingLevels(modelId, compat);
        return {
          levels: [
            { id: "off" },
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            ...extendedLevels.map((id) => ({ id })),
          ],
        };
      },
      prepareRuntimeAuth: async (ctx) => {
        const source = parseGithubCopilotApiKey(ctx.apiKey);
        const { resolveCopilotRuntimeAuth } = await loadGithubCopilotRuntime();
        const auth = await resolveCopilotRuntimeAuth({
          githubToken: source.githubToken,
          env: ctx.env,
          githubDomain: resolveGithubCopilotDomain({
            env: ctx.env,
            explicit: source.githubDomain,
            config: ctx.config,
          }),
        });
        return {
          apiKey: auth.apiKey,
          baseUrl: auth.baseUrl,
          request: { headers: buildCopilotRuntimeHeaders() },
        };
      },
      resolveUsageAuth: async (ctx) => await ctx.resolveOAuthToken(),
      fetchUsageSnapshot: async (ctx) => {
        const { fetchCopilotUsage } = await loadGithubCopilotRuntime();
        return await fetchCopilotUsage(
          ctx.token,
          ctx.timeoutMs,
          ctx.fetchFn,
          resolveGithubCopilotDomain({ env: ctx.env, config: ctx.config }),
        );
      },
    });
    api.registerModelCatalogProvider({
      provider: PROVIDER_ID,
      kinds: ["text"],
      liveCatalog: runGithubCopilotUnifiedLiveCatalog,
    });
  },
});
