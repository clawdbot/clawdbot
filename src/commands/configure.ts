import path from "node:path";

import {
  confirm,
  intro,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import {
  loginAnthropic,
  loginOpenAICodex,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
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
import { createClackPrompter } from "../wizard/clack-prompter.js";
import {
  isRemoteEnvironment,
  loginAntigravityVpsAware,
} from "./antigravity-oauth.js";
import { healthCommand } from "./health.js";
import {
  applyAuthProfileConfig,
  applyMinimaxConfig,
  setAnthropicApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  detectBrowserOpenSupport,
  ensureWorkspaceAndSessions,
  formatControlUiSshHint,
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

type ConfigureWizardParams = {
  command: "configure" | "update";
  sections?: WizardSection[];
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
    }),
    runtime,
  ) as "oauth" | "openai-codex" | "antigravity" | "apiKey" | "minimax" | "skip";

  let next = cfg;

  if (authChoice === "oauth") {
    note(
      "Browser will open. Paste the code shown after login (code#state).",
      "Anthropic OAuth",
    );
    const spin = spinner();
    spin.start("Waiting for authorization…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAnthropic(
        async (url) => {
          await openUrl(url);
          runtime.log(`Open: ${url}`);
        },
        async () => {
          const code = guardCancel(
            await text({
              message: "Paste authorization code (code#state)",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
            runtime,
          );
          return String(code);
        },
      );
      spin.stop("OAuth complete");
      if (oauthCreds) {
        await writeOAuthCredentials("anthropic", oauthCreds);
        next = applyAuthProfileConfig(next, {
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
    const spin = spinner();
    spin.start("Starting OAuth flow…");
    let manualCodePromise: Promise<string> | undefined;
    try {
      const creds = await loginOpenAICodex({
        onAuth: async ({ url }) => {
          if (isRemote) {
            spin.message("OAuth URL ready (see below)…");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
            manualCodePromise = text({
              message: "Paste the redirect URL (or authorization code)",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }).then((value) => String(guardCancel(value, runtime)));
          } else {
            spin.message("Complete sign-in in browser…");
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
        onProgress: (msg) => spin.message(msg),
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
    const spin = spinner();
    spin.start("Starting OAuth flow…");
    let oauthCreds: OAuthCredentials | null = null;
    try {
      oauthCreds = await loginAntigravityVpsAware(
        async (url) => {
          if (isRemote) {
            spin.stop("OAuth URL ready");
            runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
          } else {
            spin.message("Complete sign-in in browser…");
            await openUrl(url);
            runtime.log(`Open: ${url}`);
          }
        },
        (msg) => spin.message(msg),
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
        next = {
          ...next,
          agent: {
            ...next.agent,
            model: {
              ...(next.agent?.model &&
              "fallbacks" in (next.agent.model as Record<string, unknown>)
                ? {
                    fallbacks: (next.agent.model as { fallbacks?: string[] })
                      .fallbacks,
                  }
                : undefined),
              primary: "google-antigravity/claude-opus-4-5-thinking",
            },
            models: {
              ...next.agent?.models,
              "google-antigravity/claude-opus-4-5-thinking":
                next.agent?.models?.[
                  "google-antigravity/claude-opus-4-5-thinking"
                ] ?? {},
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
  } else if (authChoice === "minimax") {
    next = applyMinimaxConfig(next);
  }

  const modelInput = guardCancel(
    await text({
      message: "Default model (blank to keep)",
      initialValue:
        typeof next.agent?.model === "string"
          ? next.agent?.model
          : (next.agent?.model?.primary ?? ""),
    }),
    runtime,
  );
  const model = String(modelInput ?? "").trim();
  if (model) {
    next = {
      ...next,
      agent: {
        ...next.agent,
        model: {
          ...(next.agent?.model &&
          "fallbacks" in (next.agent.model as Record<string, unknown>)
            ? {
                fallbacks: (next.agent.model as { fallbacks?: string[] })
                  .fallbacks,
              }
            : undefined),
          primary: model,
        },
        models: {
          ...next.agent?.models,
          [model]: next.agent?.models?.[model] ?? {},
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
}) {
  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  let shouldCheckLinger = false;
  let shouldInstall = true;
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
    const devMode =
      process.argv[1]?.includes(`${path.sep}src${path.sep}`) &&
      process.argv[1]?.endsWith(".ts");
    const { programArguments, workingDirectory } =
      await resolveGatewayProgramArguments({ port: params.port, dev: devMode });
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      CLAWDBOT_GATEWAY_TOKEN: params.gatewayToken,
      CLAWDBOT_LAUNCHD_LABEL:
        process.platform === "darwin" ? GATEWAY_LAUNCH_AGENT_LABEL : undefined,
    };
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
        snapshot.issues
          .map((iss) => `- ${iss.path}: ${iss.message}`)
          .join("\n"),
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
            { value: "workspace", label: "Workspace" },
            { value: "model", label: "Model/auth" },
            { value: "gateway", label: "Gateway config" },
            { value: "daemon", label: "Gateway daemon" },
            { value: "providers", label: "Providers" },
            { value: "skills", label: "Skills" },
            { value: "health", label: "Health check" },
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
    nextConfig.agent?.workspace ??
    baseConfig.agent?.workspace ??
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
      agent: {
        ...nextConfig.agent,
        workspace: workspaceDir,
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
    nextConfig = await setupProviders(nextConfig, runtime, prompter, {
      allowDisable: true,
      allowSignalInstall: true,
    });
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
    }
  }

  const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
  if (!controlUiAssets.ok && controlUiAssets.message) {
    runtime.error(controlUiAssets.message);
  }

  note(
    (() => {
      const bind = nextConfig.gateway?.bind ?? "loopback";
      const links = resolveControlUiLinks({
        bind,
        port: gatewayPort,
        basePath: nextConfig.gateway?.controlUi?.basePath,
      });
      return [`Web UI: ${links.httpUrl}`, `Gateway WS: ${links.wsUrl}`].join(
        "\n",
      );
    })(),
    "Control UI",
  );

  const browserSupport = await detectBrowserOpenSupport();
  if (!browserSupport.ok) {
    note(
      formatControlUiSshHint({
        port: gatewayPort,
        basePath: nextConfig.gateway?.controlUi?.basePath,
        token: gatewayToken,
      }),
      "Open Control UI",
    );
  } else {
    const wantsOpen = guardCancel(
      await confirm({
        message: "Open Control UI now?",
        initialValue: false,
      }),
      runtime,
    );
    if (wantsOpen) {
      const bind = nextConfig.gateway?.bind ?? "loopback";
      const links = resolveControlUiLinks({
        bind,
        port: gatewayPort,
        basePath: nextConfig.gateway?.controlUi?.basePath,
      });
      const opened = await openUrl(links.httpUrl);
      if (!opened) {
        note(
          formatControlUiSshHint({
            port: gatewayPort,
            basePath: nextConfig.gateway?.controlUi?.basePath,
            token: gatewayToken,
          }),
          "Open Control UI",
        );
      }
    }
  }

  outro("Configure complete.");
}

export async function configureCommand(runtime: RuntimeEnv = defaultRuntime) {
  await runConfigureWizard({ command: "configure" }, runtime);
}
