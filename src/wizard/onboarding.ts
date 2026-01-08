import path from "node:path";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  applyAuthChoice,
  warnIfModelConfigLooksOff,
} from "../commands/auth-choice.js";
import { buildAuthChoiceOptions } from "../commands/auth-choice-options.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import { healthCommand } from "../commands/health.js";
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
import { ensureSystemdUserLingerInteractive } from "../commands/systemd-linger.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  CONFIG_PATH_CLAWDBOT,
  DEFAULT_GATEWAY_PORT,
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
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.clawd.bot/gateway/configuration",
        ].join("\n"),
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

  const quickstartHint = "Configure details later via clawdbot configure.";
  const advancedHint = "Configure port, network, Tailscale, and auth options.";
  let flow = (await prompter.select({
    message: "Onboarding mode",
    options: [
      { value: "quickstart", label: "QuickStart", hint: quickstartHint },
      { value: "advanced", label: "Advanced", hint: advancedHint },
    ],
    initialValue: "quickstart",
  })) as "quickstart" | "advanced";

  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(
      "QuickStart only supports local gateways. Switching to Advanced mode.",
      "QuickStart",
    );
    flow = "advanced";
  }

  if (flow === "quickstart") {
    await prompter.note(
      [
        "Gateway port: 18789",
        "Gateway bind: Loopback (127.0.0.1)",
        "Gateway auth: Off (loopback only)",
        "Tailscale exposure: Off",
        "Direct to chat providers.",
      ].join("\n"),
      "QuickStart defaults",
    );
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
    (flow === "quickstart"
      ? "local"
      : ((await prompter.select({
          message: "What do you want to set up?",
          options: [
            {
              value: "local",
              label: "Local gateway (this machine)",
              hint: localProbe.ok
                ? `Gateway reachable (${localUrl})`
                : `No gateway detected (${localUrl})`,
            },
            {
              value: "remote",
              label: "Remote gateway (info-only)",
              hint: !remoteUrl
                ? "No remote URL configured yet"
                : remoteProbe?.ok
                  ? `Gateway reachable (${remoteUrl})`
                  : `Configured but unreachable (${remoteUrl})`,
            },
          ],
        })) as OnboardMode));

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
    (flow === "quickstart"
      ? (baseConfig.agent?.workspace ?? DEFAULT_WORKSPACE)
      : await prompter.text({
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

  const authStore = ensureAuthProfileStore();
  const authChoice = (await prompter.select({
    message: "Model/auth choice",
    options: buildAuthChoiceOptions({ store: authStore, includeSkip: true }),
  })) as AuthChoice;

  const authResult = await applyAuthChoice({
    authChoice,
    config: nextConfig,
    prompter,
    runtime,
    setDefaultModel: true,
  });
  nextConfig = authResult.config;

  await warnIfModelConfigLooksOff(nextConfig, prompter);

  const port =
    flow === "quickstart"
      ? DEFAULT_GATEWAY_PORT
      : Number.parseInt(
          String(
            await prompter.text({
              message: "Gateway port",
              initialValue: String(localPort),
              validate: (value) =>
                Number.isFinite(Number(value)) ? undefined : "Invalid port",
            }),
          ),
          10,
        );

  let bind = (
    flow === "quickstart"
      ? "loopback"
      : ((await prompter.select({
          message: "Gateway bind",
          options: [
            { value: "loopback", label: "Loopback (127.0.0.1)" },
            { value: "lan", label: "LAN" },
            { value: "tailnet", label: "Tailnet" },
            { value: "auto", label: "Auto" },
          ],
        })) as "loopback" | "lan" | "tailnet" | "auto")
  ) as "loopback" | "lan" | "tailnet" | "auto";

  let authMode = (
    flow === "quickstart"
      ? "off"
      : ((await prompter.select({
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
        })) as GatewayAuthChoice)
  ) as GatewayAuthChoice;

  const tailscaleMode = (
    flow === "quickstart"
      ? "off"
      : ((await prompter.select({
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
        })) as "off" | "serve" | "funnel")
  ) as "off" | "serve" | "funnel";

  let tailscaleResetOnExit = false;
  if (tailscaleMode !== "off" && flow !== "quickstart") {
    await prompter.note(
      [
        "Docs:",
        "https://docs.clawd.bot/gateway/tailscale",
        "https://docs.clawd.bot/web",
      ].join("\n"),
      "Tailscale",
    );
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
    forceAllowFromProviders:
      flow === "quickstart" ? ["telegram", "whatsapp"] : [],
    skipDmPolicyPrompt: flow === "quickstart",
    skipConfirm: flow === "quickstart",
    quickstartDefaults: flow === "quickstart",
  });

  await writeConfigFile(nextConfig);
  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agent?.skipBootstrap),
  });

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

  const installDaemon =
    flow === "quickstart"
      ? true
      : await prompter.confirm({
          message: "Install Gateway daemon (recommended)",
          initialValue: true,
        });

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? (DEFAULT_GATEWAY_DAEMON_RUNTIME as GatewayDaemonRuntime)
        : ((await prompter.select({
            message: "Gateway daemon runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          })) as GatewayDaemonRuntime);
    if (flow === "quickstart") {
      await prompter.note(
        "QuickStart uses Node for the Gateway daemon (stable + supported).",
        "Gateway daemon runtime",
      );
    }
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
        await resolveGatewayProgramArguments({
          port,
          dev: devMode,
          runtime: daemonRuntime,
        });
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
    await prompter.note(
      [
        "Docs:",
        "https://docs.clawd.bot/gateway/health",
        "https://docs.clawd.bot/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
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
        "Docs: https://docs.clawd.bot/web/control-ui",
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

  await prompter.note(
    [
      "Back up your agent workspace.",
      "Docs: https://docs.clawd.bot/concepts/agent-workspace",
    ].join("\n"),
    "Workspace backup",
  );

  await prompter.outro("Onboarding complete.");
}
