import path from "node:path";

import {
  confirm as clackConfirm,
  intro as clackIntro,
  multiselect as clackMultiselect,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  text as clackText,
  spinner,
} from "@clack/prompts";
import {
  loginOpenAICodex,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  upsertAuthProfile,
} from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { createCliProgress } from "../cli/progress.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildServiceEnvironment } from "../daemon/service-env.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import { listChatProviders } from "../providers/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  stylePromptHint,
  stylePromptMessage,
  stylePromptTitle,
} from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { resolveUserPath, sleep } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import {
  isRemoteEnvironment,
  loginAntigravityVpsAware,
} from "./antigravity-oauth.js";
import { buildAuthChoiceOptions } from "./auth-choice-options.js";
import {
  buildTokenProfileId,
  validateAnthropicSetupToken,
} from "./auth-token.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import {
  applyGoogleGeminiModelDefault,
  GOOGLE_GEMINI_DEFAULT_MODEL,
} from "./google-gemini-model-default.js";
import { healthCommand } from "./health.js";
import {
  applyAuthProfileConfig,
  applyMinimaxConfig,
  applyMinimaxHostedConfig,
  setAnthropicApiKey,
  setGeminiApiKey,
  setMinimaxApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  openUrl,
  printWizardHeader,
  probeGatewayReachable,
  randomToken,
  resolveControlUiLinks,
  summarizeExistingConfig,
} from "./onboard-helpers.js";
import { setupProviders } from "./onboard-providers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "./openai-codex-model-default.js";
import { ensureSystemdUserLingerInteractive } from "./systemd-linger.js";

type WizardSection =
  | "model"
  | "providers"
  | "gateway"
  | "daemon"
  | "workspace"
  | "skills"
  | "health";

type ProvidersWizardMode = "configure" | "remove";

type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
};

const intro = (message: string) =>
  clackIntro(stylePromptTitle(message) ?? message);
const outro = (message: string) =>
  clackOutro(stylePromptTitle(message) ?? message);
const note = (message: string, title?: string) =>
  clackNote(message, stylePromptTitle(title));
const text = (params: Parameters<typeof clackText>[0]) =>
  clackText({
    ...params,
    message: stylePromptMessage(params.message),
  });
const confirm = (params: Parameters<typeof clackConfirm>[0]) =>
  clackConfirm({
    ...params,
    message: stylePromptMessage(params.message),
  });
const select = <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  clackSelect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined
        ? opt
        : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });
const multiselect = <T>(params: Parameters<typeof clackMultiselect<T>>[0]) =>
  clackMultiselect({
    ...params,
    message: stylePromptMessage(params.message),
    options: params.options.map((opt) =>
      opt.hint === undefined
        ? opt
        : { ...opt, hint: stylePromptHint(opt.hint) },
    ),
  });

const startOscSpinner = (label: string) => {
  const spin = spinner();
  spin.start(theme.accent(label));
  const osc = createCliProgress({
    label,
    indeterminate: true,
    enabled: true,
    fallback: "none",
  });
  return {
    update: (message: string) => {
      spin.message(theme.accent(message));
      osc.setLabel(message);
    },
    stop: (message: string) => {
      osc.done();
      spin.stop(message);
    },
  };
};

async function promptGatewayConfig(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<{
  config: ClawdbotConfig;
  port: number;
  token?: string;
}> {
  const portRaw = guardCancel(
    await text({
      message: "Gateway port",
      initialValue: String(resolveGatewayPort(cfg)),
      validate: (value) =>
        Number.isFinite(Number(value)) ? undefined : "Invalid port",
    }),
    runtime,
  );
  const port = Number.parseInt(String(portRaw), 10);

  let bind = guardCancel(
    await select({
      message: "Gateway bind",
      options: [
        { value: "loopback", label: "Loopback (127.0.0.1)" },
        { value: "lan", label: "LAN" },
        { value: "tailnet", label: "Tailnet" },
        { value: "auto", label: "Auto" },
      ],
    }),
    runtime,
  ) as "loopback" | "lan" | "tailnet" | "auto";

  let authMode = guardCancel(
    await select({
      message: "Gateway auth",
      options: [
        { value: "off", label: "Off (loopback only)" },
        { value: "token", label: "Token" },
        { value: "password", label: "Password" },
      ],
    }),
    runtime,
  ) as "off" | "token" | "password";

  const tailscaleMode = guardCancel(
    await select({
      message: "Tailscale exposure",
      options: [
        { value: "off", label: "Off", hint: "No Tailscale exposure" },
        {
          value: "serve",
          label: "Serve",
          hint: "Private HTTPS for your tailnet (devices on Tailscale)",
        },
        {
          value: "funnel",
          label: "Funnel",
          hint: "Public HTTPS via Tailscale Funnel (internet)",
        },
      ],
    }),
    runtime,
  ) as "off" | "serve" | "funnel";

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    note(
      [
        "Docs:",
        "https://docs.clawd.bot/gateway/tailscale",
        "https://docs.clawd.bot/web",
      ].join("\n"),
      "Tailscale",
    );
    tailscaleResetOnExit = Boolean(
      guardCancel(
        await confirm({
          message: "Reset Tailscale serve/funnel on exit?",
          initialValue: false,
        }),
        runtime,
      ),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    note(
      "Tailscale requires bind=loopback. Adjusting bind to loopback.",
      "Note",
    );
    bind = "loopback";
  }

  if (authMode === "off" && bind !== "loopback") {
    note("Non-loopback bind requires auth. Switching to token auth.", "Note");
    authMode = "token";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  let next = cfg;

  if (authMode === "token") {
    const tokenInput = guardCancel(
      await text({
        message: "Gateway token (blank to generate)",
        initialValue: randomToken(),
      }),
      runtime,
    );
    gatewayToken = String(tokenInput).trim() || randomToken();
    next = {
      ...next,
      gateway: {
        ...next.gateway,
        auth: { ...next.gateway?.auth, mode: "token", token: gatewayToken },
      },
    };
  }

  if (authMode === "password") {
    const password = guardCancel(
      await text({
        message: "Gateway password",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    next = {
      ...next,
      gateway: {
        ...next.gateway,
        auth: {
          ...next.gateway?.auth,
          mode: "password",
          password: String(password).trim(),
        },
      },
    };
  }

  next = {
    ...next,
    gateway: {
      ...next.gateway,
      mode: "local",
      port,
      bind,
      tailscale: {
        ...next.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  return { config: next, port, token: gatewayToken };
}

async function promptAuthConfig(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig> {
  const authChoice = guardCancel(
    await select({
      message: "Model/auth choice",
      options: buildAuthChoiceOptions({
        store: ensureAuthProfileStore(undefined, {
          allowKeychainPrompt: false,
        }),
        includeSkip: true,
        includeClaudeCliIfMissing: true,
      }),
    }),
    runtime,
  ) as
    | "oauth"
    | "setup-token"
    | "claude-cli"
    | "token"
    | "openai-codex"
    | "openai-api-key"
    | "codex-cli"
    | "antigravity"
    | "gemini-api-key"
    | "apiKey"
    | "minimax-cloud"
    | "minimax"
    | "skip";

  let next = cfg;

  if (authChoice === "claude-cli") {
    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: false,
    });
    if (!store.profiles[CLAUDE_CLI_PROFILE_ID] && process.stdin.isTTY) {
      note(
        [
          "No Claude CLI credentials found yet.",
          "If you have a Claude Pro/Max subscription, run `claude setup-token`.",
        ].join("\n"),
        "Claude CLI",
      );
      const runNow = guardCancel(
        await confirm({
          message: "Run `claude setup-token` now?",
          initialValue: true,
        }),
        runtime,
      );
      if (runNow) {
        const res = await (async () => {
          const { spawnSync } = await import("node:child_process");
          return spawnSync("claude", ["setup-token"], { stdio: "inherit" });
        })();
        if (res.error) {
          note(
            `Failed to run claude: ${String(res.error)}`,
            "Claude setup-token",
          );
        }
      }
    }
    next = applyAuthProfileConfig(next, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "token",
    });
  } else if (authChoice === "setup-token" || authChoice === "oauth") {
    note(
      [
        "This will run `claude setup-token` to create a long-lived Anthropic token.",
        "Requires an interactive TTY and a Claude Pro/Max subscription.",
      ].join("\n"),
      "Anthropic setup-token",
    );

    if (!process.stdin.isTTY) {
      note(
        "`claude setup-token` requires an interactive TTY.",
        "Anthropic setup-token",
      );
      return next;
    }

    const runNow = guardCancel(
      await confirm({
        message: "Run `claude setup-token` now?",
        initialValue: true,
      }),
      runtime,
    );
    if (!runNow) return next;

    const res = await (async () => {
      const { spawnSync } = await import("node:child_process");
      return spawnSync("claude", ["setup-token"], { stdio: "inherit" });
    })();
    if (res.error) {
      note(
        `Failed to run claude: ${String(res.error)}`,
        "Anthropic setup-token",
      );
      return next;
    }
    if (typeof res.status === "number" && res.status !== 0) {
      note(
        `claude setup-token failed (exit ${res.status})`,
        "Anthropic setup-token",
      );
      return next;
    }

    const store = ensureAuthProfileStore(undefined, {
      allowKeychainPrompt: true,
    });
    if (!store.profiles[CLAUDE_CLI_PROFILE_ID]) {
      note(
        `No Claude CLI credentials found after setup-token. Expected ${CLAUDE_CLI_PROFILE_ID}.`,
        "Anthropic setup-token",
      );
      return next;
    }

    next = applyAuthProfileConfig(next, {
      profileId: CLAUDE_CLI_PROFILE_ID,
      provider: "anthropic",
      mode: "token",
    });
  } else if (authChoice === "token") {
    const provider = guardCancel(
      await select({
        message: "Token provider",
        options: [
          {
            value: "anthropic",
            label: "Anthropic (only supported)",
          },
        ],
      }),
      runtime,
    ) as "anthropic";

    note(
      [
        "Run `claude setup-token` in your terminal.",
        "Then paste the generated token below.",
      ].join("\n"),
      "Anthropic token",
    );

    const tokenRaw = guardCancel(
      await text({
        message: "Paste Anthropic setup-token",
        validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
      }),
      runtime,
    );
    const token = String(tokenRaw).trim();

    const profileNameRaw = guardCancel(
      await text({
        message: "Token name (blank = default)",
        placeholder: "default",
      }),
      runtime,
    );
    const profileId = buildTokenProfileId({
      provider,
      name: String(profileNameRaw ?? ""),
    });

    upsertAuthProfile({
      profileId,
      credential: {
        type: "token",
        provider,
        token,
      },
    });

    next = applyAuthProfileConfig(next, { profileId, provider, mode: "token" });
  } else if (authChoice === "openai-api-key") {
    const envKey = resolveEnvApiKey("openai");
    if (envKey) {
      const useExisting = guardCancel(
        await confirm({
          message: `Use existing OPENAI_API_KEY (${envKey.source})?`,
          initialValue: true,
        }),
        runtime,
      );
      if (useExisting) {
        const result = upsertSharedEnvVar({
          key: "OPENAI_API_KEY",
          value: envKey.apiKey,
        });
        if (!process.env.OPENAI_API_KEY) {
          process.env.OPENAI_API_KEY = envKey.apiKey;
        }
        note(
          `Copied OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
          "OpenAI API key",
        );
      }
    }

    const key = guardCancel(
      await text({
        message: "Enter OpenAI API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    const trimmed = String(key).trim();
    const result = upsertSharedEnvVar({
      key: "OPENAI_API_KEY",
      value: trimmed,
    });
    process.env.OPENAI_API_KEY = trimmed;
    note(
      `Saved OPENAI_API_KEY to ${result.path} for launchd compatibility.`,
      "OpenAI API key",
    );
  } else if (authChoice === "openai-codex") {
    const isRemote = isRemoteEnvironment();
    note(
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
    const spin = startOscSpinner("Starting OAuth flow…");
    let manualCodePromise: Promise<string> | undefined;
    try {
      const creds = await loginOpenAICodex({
        onAuth: async ({ url }) => {
          if (isRemote) {
            spin.update("OAuth URL ready (see below)…");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
            manualCodePromise = text({
              message: "Paste the redirect URL (or authorization code)",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }).then((value) => String(guardCancel(value, runtime)));
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            runtime.log(`Open: ${url}`);
          }
        },
        onPrompt: async (prompt) => {
          if (manualCodePromise) return manualCodePromise;
          const code = guardCancel(
            await text({
              message: prompt.message,
              placeholder: prompt.placeholder,
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          );
          return String(code);
        },
        onProgress: (msg) => spin.update(msg),
      });
      spin.stop("OpenAI OAuth complete");
      if (creds) {
        await writeOAuthCredentials(
          "openai-codex" as unknown as OAuthProvider,
          creds,
        );
        next = applyAuthProfileConfig(next, {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          mode: "oauth",
        });
        const applied = applyOpenAICodexModelDefault(next);
        next = applied.next;
        if (applied.changed) {
          note(
            `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
            "Model configured",
          );
        }
      }
    } catch (err) {
      spin.stop("OpenAI OAuth failed");
      runtime.error(String(err));
      note("Trouble with OAuth? See https://docs.clawd.bot/start/faq", "OAuth");
    }
  } else if (authChoice === "codex-cli") {
    next = applyAuthProfileConfig(next, {
      profileId: CODEX_CLI_PROFILE_ID,
      provider: "openai-codex",
      mode: "oauth",
    });
    const applied = applyOpenAICodexModelDefault(next);
    next = applied.next;
    if (applied.changed) {
      note(
        `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
        "Model configured",
      );
    }
  } else if (authChoice === "antigravity") {
    const isRemote = isRemoteEnvironment();
    note(
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
    const spin = startOscSpinner("Starting OAuth flow…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAntigravityVpsAware(
        async (url) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            runtime.log(`Open: ${url}`);
          }
        },
        (msg) => spin.update(msg),
      );
      spin.stop("Antigravity OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("google-antigravity", oauthCreds);
        next = applyAuthProfileConfig(next, {
          profileId: `google-antigravity:${oauthCreds.email ?? "default"}`,
          provider: "google-antigravity",
          mode: "oauth",
        });
        // Set default model to Claude Opus 4.5 via Antigravity
        const existingDefaults = next.agents?.defaults;
        const existingModel = existingDefaults?.model;
        const existingModels = existingDefaults?.models;
        next = {
          ...next,
          agents: {
            ...next.agents,
            defaults: {
              ...existingDefaults,
              model: {
                ...(existingModel &&
                "fallbacks" in (existingModel as Record<string, unknown>)
                  ? {
                      fallbacks: (existingModel as { fallbacks?: string[] })
                        .fallbacks,
                    }
                  : undefined),
                primary: "google-antigravity/claude-opus-4-5-thinking",
              },
              models: {
                ...existingModels,
                "google-antigravity/claude-opus-4-5-thinking":
                  existingModels?.[
                    "google-antigravity/claude-opus-4-5-thinking"
                  ] ?? {},
              },
            },
          },
        };
        note(
          "Default model set to google-antigravity/claude-opus-4-5-thinking",
          "Model configured",
        );
      }
    } catch (err) {
      spin.stop("Antigravity OAuth failed");
      runtime.error(String(err));
      note("Trouble with OAuth? See https://docs.clawd.bot/start/faq", "OAuth");
    }
  } else if (authChoice === "gemini-api-key") {
    const key = guardCancel(
      await text({
        message: "Enter Gemini API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    await setGeminiApiKey(String(key).trim());
    next = applyAuthProfileConfig(next, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    });
    const applied = applyGoogleGeminiModelDefault(next);
    next = applied.next;
    if (applied.changed) {
      note(
        `Default model set to ${GOOGLE_GEMINI_DEFAULT_MODEL}`,
        "Model configured",
      );
    }
  } else if (authChoice === "apiKey") {
    const key = guardCancel(
      await text({
        message: "Enter Anthropic API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    await setAnthropicApiKey(String(key).trim());
    next = applyAuthProfileConfig(next, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  } else if (authChoice === "minimax-cloud") {
    const key = guardCancel(
      await text({
        message: "Enter MiniMax API key",
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
      runtime,
    );
    await setMinimaxApiKey(String(key).trim());
    next = applyAuthProfileConfig(next, {
      profileId: "minimax:default",
      provider: "minimax",
      mode: "api_key",
    });
    next = applyMinimaxHostedConfig(next);
  } else if (authChoice === "minimax") {
    next = applyMinimaxConfig(next);
  }

  const currentModel =
    typeof next.agents?.defaults?.model === "string"
      ? next.agents?.defaults?.model
      : (next.agents?.defaults?.model?.primary ?? "");
  const preferAnthropic =
    authChoice === "claude-cli" ||
    authChoice === "setup-token" ||
    authChoice === "token" ||
    authChoice === "oauth" ||
    authChoice === "apiKey";
  const modelInitialValue =
    preferAnthropic && !currentModel.startsWith("anthropic/")
      ? "anthropic/claude-opus-4-5"
      : currentModel;

  const modelInput = guardCancel(
    await text({
      message: "Default model (blank to keep)",
      initialValue: modelInitialValue,
    }),
    runtime,
  );
  const model = String(modelInput ?? "").trim();
  if (model) {
    const existingDefaults = next.agents?.defaults;
    const existingModel = existingDefaults?.model;
    const existingModels = existingDefaults?.models;
    next = {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...existingDefaults,
          model: {
            ...(existingModel &&
            "fallbacks" in (existingModel as Record<string, unknown>)
              ? {
                  fallbacks: (existingModel as { fallbacks?: string[] })
                    .fallbacks,
                }
              : undefined),
            primary: model,
          },
          models: {
            ...existingModels,
            [model]: existingModels?.[model] ?? {},
          },
        },
      },
    };
  }

  return next;
}

async function maybeInstallDaemon(params: {
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
  daemonRuntime?: GatewayDaemonRuntime;
}) {
  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  let shouldCheckLinger = false;
  let shouldInstall = true;
  let daemonRuntime = params.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (loaded) {
    const action = guardCancel(
      await select({
        message: "Gateway service already installed",
        options: [
          { value: "restart", label: "Restart" },
          { value: "reinstall", label: "Reinstall" },
          { value: "skip", label: "Skip" },
        ],
      }),
      params.runtime,
    );
    if (action === "restart") {
      await service.restart({ stdout: process.stdout });
      shouldCheckLinger = true;
      shouldInstall = false;
    }
    if (action === "skip") return;
    if (action === "reinstall") {
      await service.uninstall({ env: process.env, stdout: process.stdout });
    }
  }

  if (shouldInstall) {
    if (!params.daemonRuntime) {
      daemonRuntime = guardCancel(
        await select({
          message: "Gateway daemon runtime",
          options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
          initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
        }),
        params.runtime,
      ) as GatewayDaemonRuntime;
    }
    const devMode =
      process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
      process.argv[1]?.endsWith(".ts");
    const nodePath = await resolvePreferredNodePath({
      env: process.env,
      runtime: daemonRuntime,
    });
    const { programArguments, workingDirectory } =
      await resolveGatewayProgramArguments({
        port: params.port,
        dev: devMode,
        runtime: daemonRuntime,
        nodePath,
      });
    const environment = buildServiceEnvironment({
      env: process.env,
      port: params.port,
      token: params.gatewayToken,
      launchdLabel:
        process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
    });
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
    shouldCheckLinger = true;
  }

  if (shouldCheckLinger) {
    await ensureSystemdUserLingerInteractive({
      runtime: params.runtime,
      prompter: {
        confirm: async (p) =>
          guardCancel(await confirm(p), params.runtime) === true,
        note,
      },
      reason:
        "Linux installs use a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: true,
    });
  }
}

async function removeProviderConfigWizard(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig> {
  let next = { ...cfg };

  const listConfiguredProviders = () =>
    listChatProviders().filter((meta) => {
      const value = (next as Record<string, unknown>)[meta.id];
      return value !== undefined;
    });

  while (true) {
    const configured = listConfiguredProviders();
    if (configured.length === 0) {
      note(
        [
          "No provider config found in clawdbot.json.",
          "Tip: `clawdbot providers status` shows what is configured and enabled.",
        ].join("\n"),
        "Remove provider",
      );
      return next;
    }

    const provider = guardCancel(
      await select({
        message: "Remove which provider config?",
        options: [
          ...configured.map((meta) => ({
            value: meta.id,
            label: meta.label,
            hint: "Deletes tokens + settings from config (credentials stay on disk)",
          })),
          { value: "done", label: "Done" },
        ],
      }),
      runtime,
    ) as string;

    if (provider === "done") return next;

    const label =
      listChatProviders().find((meta) => meta.id === provider)?.label ??
      provider;
    const confirmed = guardCancel(
      await confirm({
        message: `Delete ${label} configuration from ${CONFIG_PATH_CLAWDBOT}?`,
        initialValue: false,
      }),
      runtime,
    );
    if (!confirmed) continue;

    const clone = { ...next } as Record<string, unknown>;
    delete clone[provider];
    next = clone as ClawdbotConfig;

    note(
      [
        `${label} removed from config.`,
        "Note: credentials/sessions on disk are unchanged.",
      ].join("\n"),
      "Provider removed",
    );
  }
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  printWizardHeader(runtime);
  intro(
    opts.command === "update" ? "Clawdbot update wizard" : "Clawdbot configure",
  );
  const prompter = createClackPrompter();

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: ClawdbotConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists) {
    const title = snapshot.valid
      ? "Existing config detected"
      : "Invalid config";
    note(summarizeExistingConfig(baseConfig), title);
    if (!snapshot.valid && snapshot.issues.length > 0) {
      note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.clawd.bot/gateway/configuration",
        ].join("\n"),
        "Config issues",
      );
    }
    if (!snapshot.valid) {
      const reset = guardCancel(
        await confirm({
          message: "Config invalid. Start fresh?",
          initialValue: true,
        }),
        runtime,
      );
      if (reset) baseConfig = {};
    }
  }

  const localUrl = "ws://127.0.0.1:18789";
  const localProbe = await probeGatewayReachable({
    url: localUrl,
    token:
      baseConfig.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    password:
      baseConfig.gateway?.auth?.password ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD,
  });
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await probeGatewayReachable({
        url: remoteUrl,
        token: baseConfig.gateway?.remote?.token,
      })
    : null;

  const mode = guardCancel(
    await select({
      message: "Where will the Gateway run?",
      options: [
        {
          value: "local",
          label: "Local (this machine)",
          hint: localProbe.ok
            ? `Gateway reachable (${localUrl})`
            : `No gateway detected (${localUrl})`,
        },
        {
          value: "remote",
          label: "Remote (info-only)",
          hint: !remoteUrl
            ? "No remote URL configured yet"
            : remoteProbe?.ok
              ? `Gateway reachable (${remoteUrl})`
              : `Configured but unreachable (${remoteUrl})`,
        },
      ],
    }),
    runtime,
  ) as "local" | "remote";

  if (mode === "remote") {
    let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    remoteConfig = applyWizardMetadata(remoteConfig, {
      command: opts.command,
      mode,
    });
    await writeConfigFile(remoteConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
    outro("Remote gateway configured.");
    return;
  }

  const selected = opts.sections
    ? opts.sections
    : (guardCancel(
        await multiselect({
          message: "Select sections to configure",
          options: [
            {
              value: "workspace",
              label: "Workspace",
              hint: "Set default workspace + ensure sessions",
            },
            {
              value: "model",
              label: "Model/auth",
              hint: "Pick model + auth profile sources",
            },
            {
              value: "gateway",
              label: "Gateway config",
              hint: "Port/bind/auth/control UI settings",
            },
            {
              value: "daemon",
              label: "Gateway daemon",
              hint: "Install/manage the background service",
            },
            {
              value: "providers",
              label: "Providers",
              hint: "Link WhatsApp/Telegram/etc and defaults",
            },
            {
              value: "skills",
              label: "Skills",
              hint: "Install/enable workspace skills",
            },
            {
              value: "health",
              label: "Health check",
              hint: "Run gateway + provider checks",
            },
          ],
        }),
        runtime,
      ) as WizardSection[]);

  if (!selected || selected.length === 0) {
    outro("No changes selected.");
    return;
  }

  let nextConfig = { ...baseConfig };
  let workspaceDir =
    nextConfig.agents?.defaults?.workspace ??
    baseConfig.agents?.defaults?.workspace ??
    DEFAULT_WORKSPACE;
  let gatewayPort = resolveGatewayPort(baseConfig);
  let gatewayToken: string | undefined;

  if (selected.includes("workspace")) {
    const workspaceInput = guardCancel(
      await text({
        message: "Workspace directory",
        initialValue: workspaceDir,
      }),
      runtime,
    );
    workspaceDir = resolveUserPath(
      String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE,
    );
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          workspace: workspaceDir,
        },
      },
    };
    await ensureWorkspaceAndSessions(workspaceDir, runtime);
  }

  if (selected.includes("model")) {
    nextConfig = await promptAuthConfig(nextConfig, runtime);
  }

  if (selected.includes("gateway")) {
    const gateway = await promptGatewayConfig(nextConfig, runtime);
    nextConfig = gateway.config;
    gatewayPort = gateway.port;
    gatewayToken = gateway.token;
  }

  if (selected.includes("providers")) {
    const providerMode = guardCancel(
      await select({
        message: "Providers",
        options: [
          {
            value: "configure",
            label: "Configure/link",
            hint: "Add/update providers; disable unselected accounts",
          },
          {
            value: "remove",
            label: "Remove provider config",
            hint: "Delete provider tokens/settings from clawdbot.json",
          },
        ],
        initialValue: "configure",
      }),
      runtime,
    ) as ProvidersWizardMode;

    if (providerMode === "configure") {
      nextConfig = await setupProviders(nextConfig, runtime, prompter, {
        allowDisable: true,
        allowSignalInstall: true,
      });
    } else {
      nextConfig = await removeProviderConfigWizard(nextConfig, runtime);
    }
  }

  if (selected.includes("skills")) {
    const wsDir = resolveUserPath(workspaceDir);
    nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
  }

  nextConfig = applyWizardMetadata(nextConfig, {
    command: opts.command,
    mode,
  });
  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);

  if (selected.includes("daemon")) {
    if (!selected.includes("gateway")) {
      const portInput = guardCancel(
        await text({
          message: "Gateway port for daemon install",
          initialValue: String(gatewayPort),
          validate: (value) =>
            Number.isFinite(Number(value)) ? undefined : "Invalid port",
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    }

    await maybeInstallDaemon({
      runtime,
      port: gatewayPort,
      gatewayToken,
    });
  }

  if (selected.includes("health")) {
    await sleep(1000);
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(`Health check failed: ${String(err)}`);
      note(
        [
          "Docs:",
          "https://docs.clawd.bot/gateway/health",
          "https://docs.clawd.bot/gateway/troubleshooting",
        ].join("\n"),
        "Health check help",
      );
    }
  }

  const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
  if (!controlUiAssets.ok && controlUiAssets.message) {
    runtime.error(controlUiAssets.message);
  }

  const bind = nextConfig.gateway?.bind ?? "loopback";
  const links = resolveControlUiLinks({
    bind,
    port: gatewayPort,
    basePath: nextConfig.gateway?.controlUi?.basePath,
  });
  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token:
      nextConfig.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
    password:
      nextConfig.gateway?.auth?.password ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD,
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

  note(
    [
      `Web UI: ${links.httpUrl}`,
      `Gateway WS: ${links.wsUrl}`,
      gatewayStatusLine,
      "Docs: https://docs.clawd.bot/web/control-ui",
    ].join("\n"),
    "Control UI",
  );

  outro("Configure complete.");
}

export async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}
