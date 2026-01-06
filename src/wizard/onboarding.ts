import path from "node:path";

import {
  loginAnthropic,
  loginOpenAICodex,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import {
  isRemoteEnvironment,
  loginAntigravityVpsAware,
} from "../commands/antigravity-oauth.js";
import { healthCommand } from "../commands/health.js";
import {
  applyAuthProfileConfig,
  applyMinimaxConfig,
  setAnthropicApiKey,
  writeOAuthCredentials,
} from "../commands/onboard-auth.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  detectBrowserOpenSupport,
  ensureWorkspaceAndSessions,
  formatControlUiSshHint,
  handleReset,
  openUrl,
  printWizardHeader,
  probeGatewayReachable,
  randomToken,
  resolveControlUiLinks,
  summarizeExistingConfig,
} from "../commands/onboard-helpers.js";
import { setupProviders } from "../commands/onboard-providers.js";
import { promptRemoteGatewayConfig } from "../commands/onboard-remote.js";
import { setupSkills } from "../commands/onboard-skills.js";
import type {
  AuthChoice,
  GatewayAuthChoice,
  OnboardMode,
  OnboardOptions,
  ResetScope,
} from "../commands/onboard-types.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "../commands/openai-codex-model-default.js";
import { ensureSystemdUserLingerInteractive } from "../commands/systemd-linger.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import { GATEWAY_LAUNCH_AGENT_LABEL } from "../daemon/constants.js";
import { resolveGatewayProgramArguments } from "../daemon/program-args.js";
import { resolveGatewayService } from "../daemon/service.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath, sleep } from "../utils.js";
import type { WizardPrompter } from "./prompts.js";

async function warnIfModelConfigLooksOff(
  config: ClawdbotConfig,
  prompter: WizardPrompter,
) {
  const ref = resolveConfiguredModelRef({
    cfg: config,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const warnings: string[] = [];
  const catalog = await loadModelCatalog({ config, useCache: false });
  if (catalog.length > 0) {
    const known = catalog.some(
      (entry) => entry.provider === ref.provider && entry.id === ref.model,
    );
    if (!known) {
      warnings.push(
        `Model not found: ${ref.provider}/${ref.model}. Update agent.model or run /models list.`,
      );
    }
  }

  const store = ensureAuthProfileStore();
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
        `Detected OpenAI Codex OAuth. Consider setting agent.model to ${OPENAI_CODEX_DEFAULT_MODEL}.`,
      );
    }
  }

  if (warnings.length > 0) {
    await prompter.note(warnings.join("\n"), "Model check");
  }
}

export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  printWizardHeader(runtime);
  await prompter.intro("Clawdbot onboarding");

  const snapshot = await readConfigFileSnapshot();
  let baseConfig: ClawdbotConfig = snapshot.valid ? snapshot.config : {};

  if (snapshot.exists) {
    const title = snapshot.valid
      ? "Existing config detected"
      : "Invalid config";
    await prompter.note(summarizeExistingConfig(baseConfig), title);
    if (!snapshot.valid && snapshot.issues.length > 0) {
      await prompter.note(
        snapshot.issues
          .map((iss) => `- ${iss.path}: ${iss.message}`)
          .join("\n"),
        "Config issues",
      );
    }

    const action = (await prompter.select({
      message: "Config handling",
      options: [
        { value: "keep", label: "Use existing values" },
        { value: "modify", label: "Update values" },
        { value: "reset", label: "Reset" },
      ],
    })) as "keep" | "modify" | "reset";

    if (action === "reset") {
      const workspaceDefault = baseConfig.agent?.workspace ?? DEFAULT_WORKSPACE;
      const resetScope = (await prompter.select({
        message: "Reset scope",
        options: [
          { value: "config", label: "Config only" },
          {
            value: "config+creds+sessions",
            label: "Config + creds + sessions",
          },
          {
            value: "full",
            label: "Full reset (config + creds + sessions + workspace)",
          },
        ],
      })) as ResetScope;
      await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {};
    } else if (action === "keep" && !snapshot.valid) {
      baseConfig = {};
    }
  }

  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;
  const localProbe = await probeGatewayReachable({
    url: localUrl,
    token: process.env.CLAWDBOT_GATEWAY_TOKEN,
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

  const mode =
    opts.mode ??
    ((await prompter.select({
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
    })) as OnboardMode);

  if (mode === "remote") {
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
    await prompter.outro("Remote gateway configured.");
    return;
  }

  const workspaceInput =
    opts.workspace ??
    (await prompter.text({
      message: "Workspace directory",
      initialValue: baseConfig.agent?.workspace ?? DEFAULT_WORKSPACE,
    }));

  const workspaceDir = resolveUserPath(
    workspaceInput.trim() || DEFAULT_WORKSPACE,
  );

  let nextConfig: ClawdbotConfig = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      workspace: workspaceDir,
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };

  const authChoice = (await prompter.select({
    message: "Model/auth choice",
    options: [
      { value: "oauth", label: "Anthropic OAuth (Claude Pro/Max)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      {
        value: "antigravity",
        label: "Google Antigravity (Claude Opus 4.5, Gemini 3, etc.)",
      },
      { value: "apiKey", label: "Anthropic API key" },
      { value: "minimax", label: "Minimax M2.1 (LM Studio)" },
      { value: "skip", label: "Skip for now" },
    ],
  })) as AuthChoice;

  if (authChoice === "oauth") {
    await prompter.note(
      "Browser will open. Paste the code shown after login (code#state).",
      "Anthropic OAuth",
    );
    const spin = prompter.progress("Waiting for authorization…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAnthropic(
        async (url) => {
          await openUrl(url);
          runtime.log(`Open: ${url}`);
        },
        async () => {
          const code = await prompter.text({
            message: "Paste authorization code (code#state)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          });
          return String(code);
        },
      );
      spin.stop("OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("anthropic", oauthCreds);
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: "anthropic:default",
          provider: "anthropic",
          mode: "oauth",
        });
      }
    } catch (err) {
      spin.stop("OAuth failed");
      runtime.error(String(err));
    }
  } else if (authChoice === "openai-codex") {
    const isRemote = isRemoteEnvironment();
    await prompter.note(
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
    const spin = prompter.progress("Starting OAuth flow…");
    let manualCodePromise: Promise<string> | undefined;
    try {
      const creds = await loginOpenAICodex({
        onAuth: async ({ url }) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
            manualCodePromise = prompter
              .text({
                message: "Paste the redirect URL (or authorization code)",
                validate: (value) => (value?.trim() ? undefined : "Required"),
              })
              .then((value) => String(value));
          } else {
            spin.update("Complete sign-in in browser…");
            await openUrl(url);
            runtime.log(`Open: ${url}`);
          }
        },
        onPrompt: async (prompt) => {
          if (manualCodePromise) {
            return manualCodePromise;
          }
          const code = await prompter.text({
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
        );
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: "openai-codex:default",
          provider: "openai-codex",
          mode: "oauth",
        });
        const applied = applyOpenAICodexModelDefault(nextConfig);
        nextConfig = applied.next;
        if (applied.changed) {
          await prompter.note(
            `Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`,
            "Model configured",
          );
        }
      }
    } catch (err) {
      spin.stop("OpenAI OAuth failed");
      runtime.error(String(err));
    }
  } else if (authChoice === "antigravity") {
    const isRemote = isRemoteEnvironment();
    await prompter.note(
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
    const spin = prompter.progress("Starting OAuth flow…");
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
        nextConfig = applyAuthProfileConfig(nextConfig, {
          profileId: `google-antigravity:${oauthCreds.email ?? "default"}`,
          provider: "google-antigravity",
          mode: "oauth",
        });
        nextConfig = {
          ...nextConfig,
          agent: {
            ...nextConfig.agent,
            model: {
              ...(nextConfig.agent?.model &&
              "fallbacks" in (nextConfig.agent.model as Record<string, unknown>)
                ? {
                    fallbacks: (
                      nextConfig.agent.model as { fallbacks?: string[] }
                    ).fallbacks,
                  }
                : undefined),
              primary: "google-antigravity/claude-opus-4-5-thinking",
            },
            models: {
              ...nextConfig.agent?.models,
              "google-antigravity/claude-opus-4-5-thinking":
                nextConfig.agent?.models?.[
                  "google-antigravity/claude-opus-4-5-thinking"
                ] ?? {},
            },
          },
        };
        await prompter.note(
          "Default model set to google-antigravity/claude-opus-4-5-thinking",
          "Model configured",
        );
      }
    } catch (err) {
      spin.stop("Antigravity OAuth failed");
      runtime.error(String(err));
    }
  } else if (authChoice === "apiKey") {
    const key = await prompter.text({
      message: "Enter Anthropic API key",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    await setAnthropicApiKey(String(key).trim());
    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: "anthropic:default",
      provider: "anthropic",
      mode: "api_key",
    });
  } else if (authChoice === "minimax") {
    nextConfig = applyMinimaxConfig(nextConfig);
  }

  await warnIfModelConfigLooksOff(nextConfig, prompter);

  const portRaw = await prompter.text({
    message: "Gateway port",
    initialValue: String(localPort),
    validate: (value) =>
      Number.isFinite(Number(value)) ? undefined : "Invalid port",
  });
  const port = Number.parseInt(String(portRaw), 10);

  let bind = (await prompter.select({
    message: "Gateway bind",
    options: [
      { value: "loopback", label: "Loopback (127.0.0.1)" },
      { value: "lan", label: "LAN" },
      { value: "tailnet", label: "Tailnet" },
      { value: "auto", label: "Auto" },
    ],
  })) as "loopback" | "lan" | "tailnet" | "auto";

  let authMode = (await prompter.select({
    message: "Gateway auth",
    options: [
      {
        value: "off",
        label: "Off (loopback only)",
        hint: "Recommended for single-machine setups",
      },
      {
        value: "token",
        label: "Token",
        hint: "Use for multi-machine access or non-loopback binds",
      },
      { value: "password", label: "Password" },
    ],
  })) as GatewayAuthChoice;

  const tailscaleMode = (await prompter.select({
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
  })) as "off" | "serve" | "funnel";

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off") {
    tailscaleResetOnExit = Boolean(
      await prompter.confirm({
        message: "Reset Tailscale serve/funnel on exit?",
        initialValue: false,
      }),
    );
  }

  if (tailscaleMode !== "off" && bind !== "loopback") {
    await prompter.note(
      "Tailscale requires bind=loopback. Adjusting bind to loopback.",
      "Note",
    );
    bind = "loopback";
  }

  if (authMode === "off" && bind !== "loopback") {
    await prompter.note(
      "Non-loopback bind requires auth. Switching to token auth.",
      "Note",
    );
    authMode = "token";
  }

  if (tailscaleMode === "funnel" && authMode !== "password") {
    await prompter.note("Tailscale funnel requires password auth.", "Note");
    authMode = "password";
  }

  let gatewayToken: string | undefined;
  if (authMode === "token") {
    const tokenInput = await prompter.text({
      message: "Gateway token (blank to generate)",
      placeholder: "Needed for multi-machine or non-loopback access",
      initialValue: randomToken(),
    });
    gatewayToken = String(tokenInput).trim() || randomToken();
  }

  if (authMode === "password") {
    const password = await prompter.text({
      message: "Gateway password",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "password",
          password: String(password).trim(),
        },
      },
    };
  } else if (authMode === "token") {
    nextConfig = {
      ...nextConfig,
      gateway: {
        ...nextConfig.gateway,
        auth: {
          ...nextConfig.gateway?.auth,
          mode: "token",
          token: gatewayToken,
        },
      },
    };
  }

  nextConfig = {
    ...nextConfig,
    gateway: {
      ...nextConfig.gateway,
      port,
      bind,
      tailscale: {
        ...nextConfig.gateway?.tailscale,
        mode: tailscaleMode,
        resetOnExit: tailscaleResetOnExit,
      },
    },
  };

  nextConfig = await setupProviders(nextConfig, runtime, prompter, {
    allowSignalInstall: true,
  });

  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  await ensureWorkspaceAndSessions(workspaceDir, runtime);

  nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);

  await ensureSystemdUserLingerInteractive({
    runtime,
    prompter: {
      confirm: prompter.confirm,
      note: prompter.note,
    },
    reason:
      "Linux installs use a systemd user service by default. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
    requireConfirm: false,
  });

  const installDaemon = await prompter.confirm({
    message: "Install Gateway daemon (recommended)",
    initialValue: true,
  });

  if (installDaemon) {
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    if (loaded) {
      const action = (await prompter.select({
        message: "Gateway service already installed",
        options: [
          { value: "restart", label: "Restart" },
          { value: "reinstall", label: "Reinstall" },
          { value: "skip", label: "Skip" },
        ],
      })) as "restart" | "reinstall" | "skip";
      if (action === "restart") {
        await service.restart({ stdout: process.stdout });
      } else if (action === "reinstall") {
        await service.uninstall({ env: process.env, stdout: process.stdout });
      }
    }

    if (
      !loaded ||
      (loaded && (await service.isLoaded({ env: process.env })) === false)
    ) {
      const devMode =
        process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
        process.argv[1]?.endsWith(".ts");
      const { programArguments, workingDirectory } =
        await resolveGatewayProgramArguments({ port, dev: devMode });
      const environment: Record<string, string | undefined> = {
        PATH: process.env.PATH,
        CLAWDBOT_GATEWAY_TOKEN: gatewayToken,
        CLAWDBOT_LAUNCHD_LABEL:
          process.platform === "darwin"
            ? GATEWAY_LAUNCH_AGENT_LABEL
            : undefined,
      };
      await service.install({
        env: process.env,
        stdout: process.stdout,
        programArguments,
        workingDirectory,
        environment,
      });
    }
  }

  await sleep(1500);
  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  } catch (err) {
    runtime.error(`Health check failed: ${String(err)}`);
  }

  const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
  if (!controlUiAssets.ok && controlUiAssets.message) {
    runtime.error(controlUiAssets.message);
  }

  await prompter.note(
    [
      "Add nodes for extra features:",
      "- macOS app (system + notifications)",
      "- iOS app (camera/canvas)",
      "- Android app (camera/canvas)",
    ].join("\n"),
    "Optional apps",
  );

  await prompter.note(
    (() => {
      const links = resolveControlUiLinks({
        bind,
        port,
        basePath: baseConfig.gateway?.controlUi?.basePath,
      });
      const tokenParam =
        authMode === "token" && gatewayToken
          ? `?token=${encodeURIComponent(gatewayToken)}`
          : "";
      const authedUrl = `${links.httpUrl}${tokenParam}`;
      return [
        `Web UI: ${links.httpUrl}`,
        tokenParam ? `Web UI (with token): ${authedUrl}` : undefined,
        `Gateway WS: ${links.wsUrl}`,
      ]
        .filter(Boolean)
        .join("\n");
    })(),
    "Control UI",
  );

  const browserSupport = await detectBrowserOpenSupport();
  if (!browserSupport.ok) {
    await prompter.note(
      formatControlUiSshHint({
        port,
        basePath: baseConfig.gateway?.controlUi?.basePath,
        token: authMode === "token" ? gatewayToken : undefined,
      }),
      "Open Control UI",
    );
  } else {
    const wantsOpen = await prompter.confirm({
      message: "Open Control UI now?",
      initialValue: true,
    });
    if (wantsOpen) {
      const links = resolveControlUiLinks({
        bind,
        port,
        basePath: baseConfig.gateway?.controlUi?.basePath,
      });
      const tokenParam =
        authMode === "token" && gatewayToken
          ? `?token=${encodeURIComponent(gatewayToken)}`
          : "";
      const opened = await openUrl(`${links.httpUrl}${tokenParam}`);
      if (!opened) {
        await prompter.note(
          formatControlUiSshHint({
            port,
            basePath: baseConfig.gateway?.controlUi?.basePath,
            token: authMode === "token" ? gatewayToken : undefined,
          }),
          "Open Control UI",
        );
      }
    }
  }

  await prompter.outro("Onboarding complete.");
}
