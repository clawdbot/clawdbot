import {
  loginOpenAICodex,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
} from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { ClawdbotConfig } from "../config/config.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import { githubCopilotLoginCommand } from "../providers/github-copilot-auth.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  isRemoteEnvironment,
  loginAntigravityVpsAware,
} from "./antigravity-oauth.js";
import {
  buildTokenProfileId,
  validateAnthropicSetupToken,
} from "./auth-token.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";
import {
  applyAuthProfileConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiProviderConfig,
  applyMinimaxConfig,
  applyMinimaxHostedConfig,
  applyMinimaxHostedProviderConfig,
  applyMinimaxProviderConfig,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applyZaiConfig,
  MINIMAX_HOSTED_MODEL_REF,
  setAnthropicApiKey,
  setGeminiApiKey,
  setMinimaxApiKey,
  setOpencodeZenApiKey,
  setZaiApiKey,
  writeOAuthCredentials,
  ZAI_DEFAULT_MODEL_REF,
} from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import type { AuthChoice } from "./onboard-types.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";
import { OPENCODE_ZEN_DEFAULT_MODEL } from "./opencode-zen-model-default.js";

export async function warnIfModelConfigLooksOff(
  config: ClawdbotConfig,
  prompter: WizardPrompter,
  options?: { agentId?: string; agentDir?: string },
) {
  const agentModelOverride = options?.agentId
    ? resolveAgentConfig(config, options.agentId)?.model?.trim()
    : undefined;
  const configWithModel =
    agentModelOverride && agentModelOverride.length > 0
      ? {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              model: {
                ...(typeof config.agents?.defaults?.model === "object"
                  ? config.agents.defaults.model
                  : undefined),
                primary: agentModelOverride,
              },
            },
          },
        }
      : config;
  const ref = resolveConfiguredModelRef({
    cfg: configWithModel,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const warnings: string[] = [];
  const catalog = await loadModelCatalog({
    config: configWithModel,
    useCache: false,
  });
  if (catalog.length > 0) {
    const known = catalog.some(
      (entry) => entry.provider === ref.provider && entry.id === ref.model,
    );
    if (!known) {
      warnings.push(
        `Model not found: ${ref.provider}/${ref.model}. Update agents.defaults.model or run /models list.`,
      );
    }
  }

  const store = ensureAuthProfileStore(options?.agentDir);
  const hasProfile = listProfilesForProvider(store, ref.provider).length > 0;
  const envKey = resolveEnvApiKey(ref.provider);
  const customKey = getCustomProviderApiKey(config, ref.provider);
  if (!hasProfile && !envKey && !customKey) {
    warnings.push(
      `No auth configured for provider "${ref.provider}". The agent may fail until credentials are added.`,
    );
  }

  if (ref.provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      warnings.push(
        `Detected OpenAI Codex OAuth. Consider setting agents.defaults.model to ${OPENAI_CODEX_DEFAULT_MODEL}.`,
      );
    }
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}

export async function applyAuthChoice(params: {
  authChoice: AuthChoice;
  config: ClawdbotConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir?: string;
  setDefaultModel: boolean;
  agentId?: string;
}): Promise<{ config: ClawdbotConfig; agentModelOverride?: string }> {
  let nextConfig = params.config;
  let agentModelOverride: string | undefined;

  const noteAgentModel = async (model: string) => {
    if (!params.agentId) return;
    await params.prompter.note(
      `Default model set to ${model} for agent "${params.agentId}".`,
      "Model configured",
    );
  };

  if (params.authChoice === "claude-cli") {
    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    const hasClaudeCli = Boolean(store.profiles[CLAUDE_CLI_PROFILE_ID]);
    if (!hasClaudeCli && process.platform === "darwin") {
      await params.prompter.note(
        [
          "macOS will show a Keychain prompt next.",
          'Choose "Always Allow" so the launchd gateway can start without prompts.',
          'If you choose "Allow" or "Deny", each restart will block on a Keychain alert.',
        ].join("\n"),
        "Claude CLI Keychain",
      );
      const proceed = await params.prompter.confirm({
        message: "Check Keychain for Claude CLI credentials now?",
        initialValue: true,
      });
      if (!proceed) {
        return { config: nextConfig, agentModelOverride };
      }
    }

    const storeWithKeychain = hasClaudeCli
      ? store
      : ensureAuthProfileStore(params.agentDir, {
          allowKeychainPrompt: true,
        });

    if (!storeWithKeychain.profiles[CLAUDE_CLI_PROFILE_ID]) {
      if (process.stdin.isTTY) {
        const runNow = await params.prompter.confirm({
          message: "Run `claude setup-token` now?",
          initialValue: true,
        });
        if (runNow) {
          const res = await (async () => {
            const { spawnSync } = await import("node:child_process");
            return spawnSync("claude", ["setup-token"], { stdio: "inherit" });
          })();
          if (res.error) {
            await params.prompter.note(
              `Failed to run claude: ${String(res.error)}`,
              "Claude setup-token",
            );
          }
        }
      } else {
        await params.prompter.note(
          "`claude setup-token` requires an interactive TTY.",
          "Claude setup-token",
        );
      }

      const refreshed = ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: true,
      });
      if (!refreshed.profiles[CLAUDE_CLI_PROFILE_ID]) {
        await params.prompter.note(
          process.platform === "darwin"
            ? 'No Claude CLI credentials found in Keychain ("Claude Code-credentials") or ~/.claude/.credentials.json.'
            : "No Claude CLI credentials found at ~/.claude/.credentials.json.",
          "Claude CLI OAuth",
        );
        return { config: nextConfig, agentModelOverride };
      }
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "token",
    });
  } else if (
    params.authChoice === "setup-token" ||
    params.authChoice === "oauth"
  ) {
    await params.prompter.note(
      [
        "This will run `claude setup-token` to create a long-lived Anthropic token.",
        "Requires an interactive TTY and a Claude Pro/Max subscription.",
      ].join("\n"),
      "Anthropic setup-token",
    );

    if (!process.stdin.isTTY) {
      await params.prompter.note(
        "`claude setup-token` requires an interactive TTY.",
        "Anthropic setup-token",
      );
      return { config: nextConfig, agentModelOverride };
    }

    const proceed = await params.prompter.confirm({
      message: "Run `claude setup-token` now?",
      initialValue: true,
    });
    if (!proceed) return { config: nextConfig, agentModelOverride };

    const res = await (async () => {
      const { spawnSync } = await import("node:child_process");
      return spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    })();
    if (res.error) {
      await params.prompter.note(
        `Failed to run claude: ${String(res.error)}`,
        "Anthropic setup-token",
      );
      return { config: nextConfig, agentModelOverride };
    }
    if (typeof res.status === "number" && res.status !== 0) {
      await params.prompter.note(
        `claude setup-token failed (exit ${res.status})`,
        "Anthropic setup-token",
      );
      return { config: nextConfig, agentModelOverride };
    }

    const store = ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: true,
    });
    if (!store.profiles[CLAUDE_CLI_PROFILE_ID]) {
      await params.prompter.note(
        `No Claude CLI credentials found after setup-token. Expected ${CLAUDE_CLI_PROFILE_ID}.`,
        "Anthropic setup-token",
      );
      return { config: nextConfig, agentModelOverride };
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "token",
    });
  } else if (params.authChoice === "token") {
    const provider = (await params.prompter.select({
      message: "Token provider",
      options: [{ value: "anthropic", label: "Anthropic (only supported)" }],
    })) as "anthropic";
    await params.prompter.note(
      [
        "Run `claude setup-token` in your terminal.",
        "Then paste the generated token below.",
      ].join("\n"),
      "Anthropic token",
    );

    const tokenRaw = await params.prompter.text({
      message: "Paste Anthropic setup-token",
      validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
    });
    const token = String(tokenRaw).trim();

    const profileNameRaw = await params.prompter.text({
      message: "Token name (blank = default)",
      placeholder: "default",
    });
    const namedProfileId = buildTokenProfileId({
      provider,
      name: String(profileNameRaw ?? ""),
    });

    upsertAuthProfile({
      profileId: namedProfileId,
      agentDir: params.agentDir,
      credential: {
        type: "token",
        provider,
        token,
      },
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: namedProfileId,
      provider,
      mode: "token",
    });
  } else if (params.authChoice === "openai-api-key") {
    const envKey = resolveEnvApiKey("openai");
    if (envKey) {
      const useExisting = await params.prompter.confirm({
        message: `Use existing OPENAI_API_KEY (${envKey.source})?`,
        initialValue: true,
      });
      if (useExisting) {
        const result = upsertSharedEnvVar({
          key: "OPENAI_API_KEY",
          value: envKey.apiKey,
        });
        if (!process.env.OPENAI_API_KEY) {
          process.env.OPENAI_API_KEY = envKey.apiKey;
        }
        await params.prompter.note(
          `Copied OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
          "OpenAI API key",
        );
        return { config: nextConfig, agentModelOverride };
      }
    }

    const key = await params.prompter.text({
      message: "Enter OpenAI API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const trimmed = String(key).trim();
    const result = upsertSharedEnvVar({
      key: "OPENAI_API_KEY",
      value: trimmed,
    });
    process.env.OPENAI_API_KEY = trimmed;
    await params.prompter.note(
      `Saved OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
      "OpenAI API key",
    );
  } else if (params.authChoice === "openai-codex") {
    const isRemote = isRemoteEnvironment();
    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, paste the redirect URL back here.",
          ].join("\n")
        : [
            "Browser will open for OpenAI authentication.",
            "If the callback doesn't auto-complete, paste the redirect URL.",
            "OpenAI OAuth uses localhost:1455 for the callback.",
          ].join("\n"),
      "OpenAI Codex OAuth",
    );
    const spin = params.prompter.progress("Starting OAuth flow…");
    let manualCodePromise: Promise<string> | undefined;
    try {
      const creds = await loginOpenAICodex({
        onAuth: async ({ url }) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            params.runtime.log(
              `\nOpen this URL in your LOCAL browser:\n\n${url}\n`,
            );
            manualCodePromise = params.prompter
              .text({
                message: "Paste the redirect URL (or authorization code)",
                validate: (value) => (value?.trim() ? undefined : "Required"),
              })
              .then((value) => String(value));
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            params.runtime.log(`Open: ${url}`);
          }
        },
        onPrompt: async (prompt) => {
          if (manualCodePromise) {
            return manualCodePromise;
          }
          const code = await params.prompter.text({
            message: prompt.message,
            placeholder: prompt.placeholder,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          });
          return String(code);
        },
        onProgress: (msg) => spin.update(msg),
      });
      spin.stop("OpenAI OAuth complete");
      if (creds) {
        await writeOAuthCredentials(
          "openai-codex" as unknown as OAuthProvider,
          creds,
          params.agentDir,
        );
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          mode: "oauth",
        });
        if (params.setDefaultModel) {
          const applied = applyOpenAICodexModelDefault(nextConfig);
          nextConfig = applied.next;
          if (applied.changed) {
            await params.prompter.note(
              `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
              "Model configured",
            );
          }
        } else {
          agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
          await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
        }
      }
    } catch (err) {
      spin.stop("OpenAI OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.clawd.bot/start/faq",
        "OAuth help",
      );
    }
  } else if (params.authChoice === "codex-cli") {
    const store = ensureAuthProfileStore(params.agentDir);
    if (!store.profiles[CODEX_CLI_PROFILE_ID]) {
      await params.prompter.note(
        "No Codex CLI credentials found at ~/.codex/auth.json.",
        "Codex CLI OAuth",
      );
      return { config: nextConfig, agentModelOverride };
    }
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: CODEX_CLI_PROFILE_ID,
      provider: "openai-codex",
      mode: "oauth",
    });
    if (params.setDefaultModel) {
      const applied = applyOpenAICodexModelDefault(nextConfig);
      nextConfig = applied.next;
      if (applied.changed) {
        await params.prompter.note(
          `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
          "Model configured",
        );
      }
    } else {
      agentModelOverride = OPENAI_CODEX_DEFAULT_MODEL;
      await noteAgentModel(OPENAI_CODEX_DEFAULT_MODEL);
    }
  } else if (params.authChoice === "antigravity") {
    const isRemote = isRemoteEnvironment();
    await params.prompter.note(
      isRemote
        ? [
            "You are running in a remote/VPS environment.",
            "A URL will be shown for you to open in your LOCAL browser.",
            "After signing in, copy the redirect URL and paste it back here.",
          ].join("\n")
        : [
            "Browser will open for Google authentication.",
            "Sign in with your Google account that has Antigravity access.",
            "The callback will be captured automatically on localhost:51121.",
          ].join("\n"),
      "Google Antigravity OAuth",
    );
    const spin = params.prompter.progress("Starting OAuth flow…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAntigravityVpsAware(
        async (url) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            params.runtime.log(
              `\nOpen this URL in your LOCAL browser:\n\n${url}\n`,
            );
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            params.runtime.log(`Open: ${url}`);
          }
        },
        (msg) => spin.update(msg),
      );
      spin.stop("Antigravity OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials(
          "google-antigravity",
          oauthCreds,
          params.agentDir,
        );
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: `google-antigravity:${oauthCreds.email ?? "default"}`,
          provider: "google-antigravity",
          mode: "oauth",
        });
        const modelKey = "google-antigravity/claude-opus-4-5-thinking";
        nextConfig = {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              models: {
                ...nextConfig.agents?.defaults?.models,
                [modelKey]:
                  nextConfig.agents?.defaults?.models?.[modelKey] ?? {},
              },
            },
          },
        };
        if (params.setDefaultModel) {
          const existingModel = nextConfig.agents?.defaults?.model;
          nextConfig = {
            ...nextConfig,
            agents: {
              ...nextConfig.agents,
              defaults: {
                ...nextConfig.agents?.defaults,
                model: {
                  ...(existingModel &&
                  "fallbacks" in (existingModel as Record<string, unknown>)
                    ? {
                        fallbacks: (existingModel as { fallbacks?: string[] })
                          .fallbacks,
                      }
                    : undefined),
                  primary: modelKey,
                },
              },
            },
          };
          await params.prompter.note(
            `Default model set to ${modelKey}`,
            "Model configured",
          );
        } else {
          agentModelOverride = modelKey;
          await noteAgentModel(modelKey);
        }
      }
    } catch (err) {
      spin.stop("Antigravity OAuth failed");
      params.runtime.error(String(err));
      await params.prompter.note(
        "Trouble with OAuth? See https://docs.clawd.bot/start/faq",
        "OAuth help",
      );
    }
  } else if (params.authChoice === "gemini-api-key") {
    const key = await params.prompter.text({
      message: "Enter Gemini API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setGeminiApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      const applied = applyGoogleGeminiModelDefault(nextConfig);
      nextConfig = applied.next;
      if (applied.changed) {
        await params.prompter.note(
          `Default model set to ${GOOGLE_GEMINI_DEFAULT_MODEL}`,
          "Model configured",
        );
      }
    } else {
      agentModelOverride = GOOGLE_GEMINI_DEFAULT_MODEL;
      await noteAgentModel(GOOGLE_GEMINI_DEFAULT_MODEL);
    }
  } else if (params.authChoice === "zai-api-key") {
    const key = await params.prompter.text({
      message: "Enter Z.AI API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setZaiApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "zai:default",
      provider: "zai",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      nextConfig = applyZaiConfig(nextConfig);
      await params.prompter.note(
        `Default model set to ${ZAI_DEFAULT_MODEL_REF}`,
        "Model configured",
      );
    } else {
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            models: {
              ...nextConfig.agents?.defaults?.models,
              [ZAI_DEFAULT_MODEL_REF]: {
                ...nextConfig.agents?.defaults?.models?.[ZAI_DEFAULT_MODEL_REF],
                alias:
                  nextConfig.agents?.defaults?.models?.[ZAI_DEFAULT_MODEL_REF]
                    ?.alias ?? "GLM",
              },
            },
          },
        },
      };
      agentModelOverride = ZAI_DEFAULT_MODEL_REF;
      await noteAgentModel(ZAI_DEFAULT_MODEL_REF);
    }
  } else if (params.authChoice === "apiKey") {
    const key = await params.prompter.text({
      message: "Enter Anthropic API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setAnthropicApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  } else if (params.authChoice === "minimax-cloud") {
    const key = await params.prompter.text({
      message: "Enter MiniMax API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setMinimaxApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      nextConfig = applyMinimaxHostedConfig(nextConfig);
    } else {
      nextConfig = applyMinimaxHostedProviderConfig(nextConfig);
      agentModelOverride = MINIMAX_HOSTED_MODEL_REF;
      await noteAgentModel(MINIMAX_HOSTED_MODEL_REF);
    }
  } else if (params.authChoice === "minimax") {
    if (params.setDefaultModel) {
      nextConfig = applyMinimaxConfig(nextConfig);
    } else {
      nextConfig = applyMinimaxProviderConfig(nextConfig);
      agentModelOverride = "lmstudio/minimax-m2.1-gs32";
      await noteAgentModel("lmstudio/minimax-m2.1-gs32");
    }
  } else if (params.authChoice === "minimax-api") {
    const key = await params.prompter.text({
      message: "Enter MiniMax API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setMinimaxApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      nextConfig = applyMinimaxApiConfig(nextConfig);
    } else {
      nextConfig = applyMinimaxApiProviderConfig(nextConfig);
      agentModelOverride = "minimax/MiniMax-M2.1";
      await noteAgentModel("minimax/MiniMax-M2.1");
    }
  } else if (params.authChoice === "github-copilot") {
    await params.prompter.note(
      [
        "This will open a GitHub device login to authorize Copilot.",
        "Requires an active GitHub Copilot subscription.",
      ].join("\n"),
      "GitHub Copilot",
    );

    if (!process.stdin.isTTY) {
      await params.prompter.note(
        "GitHub Copilot login requires an interactive TTY.",
        "GitHub Copilot",
      );
      return { config: nextConfig, agentModelOverride };
    }

    try {
      await githubCopilotLoginCommand({ yes: true }, params.runtime);
    } catch (err) {
      await params.prompter.note(
        `GitHub Copilot login failed: ${String(err)}`,
        "GitHub Copilot",
      );
      return { config: nextConfig, agentModelOverride };
    }

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "github-copilot:github",
      provider: "github-copilot",
      mode: "token",
    });

    if (params.setDefaultModel) {
      const model = "github-copilot/gpt-4o";
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            model: {
              ...(typeof nextConfig.agents?.defaults?.model === "object"
                ? nextConfig.agents.defaults.model
                : undefined),
              primary: model,
            },
          },
        },
      };
      await params.prompter.note(
        `Default model set to ${model}`,
        "Model configured",
      );
    }
  } else if (params.authChoice === "opencode-zen") {
    await params.prompter.note(
      [
        "OpenCode Zen provides access to Claude, GPT, Gemini, and more models.",
        "Get your API key at: https://opencode.ai/auth",
        "Requires an active OpenCode Zen subscription.",
      ].join("\n"),
      "OpenCode Zen",
    );
    const key = await params.prompter.text({
      message: "Enter OpenCode Zen API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setOpencodeZenApiKey(String(key).trim(), params.agentDir);
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "opencode:default",
      provider: "opencode",
      mode: "api_key",
    });
    if (params.setDefaultModel) {
      nextConfig = applyOpencodeZenConfig(nextConfig);
      await params.prompter.note(
        `Default model set to ${OPENCODE_ZEN_DEFAULT_MODEL}`,
        "Model configured",
      );
    } else {
      nextConfig = applyOpencodeZenProviderConfig(nextConfig);
      agentModelOverride = OPENCODE_ZEN_DEFAULT_MODEL;
      await noteAgentModel(OPENCODE_ZEN_DEFAULT_MODEL);
    }
  }

  return { config: nextConfig, agentModelOverride };
}

export function resolvePreferredProviderForAuthChoice(
  choice: AuthChoice,
): string | undefined {
  switch (choice) {
    case "oauth":
    case "setup-token":
    case "claude-cli":
    case "token":
    case "apiKey":
      return "anthropic";
    case "openai-codex":
    case "codex-cli":
      return "openai-codex";
    case "openai-api-key":
      return "openai";
    case "gemini-api-key":
      return "google";
    case "antigravity":
      return "google-antigravity";
    case "minimax-cloud":
    case "minimax-api":
      return "minimax";
    case "minimax":
      return "lmstudio";
    case "opencode-zen":
      return "opencode";
    case "github-copilot":
      return "github-copilot";
    default:
      return undefined;
  }
}
