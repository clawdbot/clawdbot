import fs from "node:fs/promises";
import path from "node:path";

import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "../commands/daemon-runtime.js";
import { healthCommand } from "../commands/health.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  openUrlInBackground,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { MoltbotConfig } from "../config/config.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: MoltbotConfig;
  nextConfig: MoltbotConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

export async function finalizeOnboardingWizard(options: FinalizeOnboardingOptions) {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(options.doneMessage);
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(
      "Systemd user services are unavailable. Skipping lingering checks and service install.",
      "Systemd",
    );
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
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
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: "Install Gateway service (recommended)",
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(
      "Systemd user services are unavailable; skipping service install. Use your container supervisor or `docker compose up -d`.",
      "Gateway service",
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? (DEFAULT_GATEWAY_DAEMON_RUNTIME as GatewayDaemonRuntime)
        : ((await prompter.select({
            message: "Gateway service runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          })) as GatewayDaemonRuntime);
    if (flow === "quickstart") {
      await prompter.note(
        "QuickStart uses Node for the Gateway service (stable + supported).",
        "Gateway service runtime",
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
        await withWizardProgress(
          "Gateway service",
          { doneMessage: "Gateway service restarted." },
          async (progress) => {
            progress.update("Restarting Gateway service…");
            await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          "Gateway service",
          { doneMessage: "Gateway service uninstalled." },
          async (progress) => {
            progress.update("Uninstalling Gateway service…");
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (!loaded || (loaded && (await service.isLoaded({ env: process.env })) === false)) {
      const progress = prompter.progress("Gateway service");
      let installError: string | null = null;
      try {
        progress.update("Preparing Gateway service…");
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port: settings.port,
          token: settings.gatewayToken,
          runtime: daemonRuntime,
          warn: (message, title) => prompter.note(message, title),
          config: nextConfig,
        });

        progress.update("Installing Gateway service…");
        await service.install({
          env: process.env,
          stdout: process.stdout,
          programArguments,
          workingDirectory,
          environment,
        });
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      } finally {
        progress.stop(
          installError ? "Gateway service install failed." : "Gateway service installed.",
        );
      }
      if (installError) {
        await prompter.note(`Gateway service install failed: ${installError}`, "Gateway");
        await prompter.note(gatewayInstallErrorHint(), "Gateway");
      }
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.gatewayToken,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        [
          "Docs:",
          "https://docs.molt.bot/gateway/health",
          "https://docs.molt.bot/gateway/troubleshooting",
        ].join("\n"),
        "Health check help",
      );
    }
  }

  const controlUiEnabled =
    nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
  if (!opts.skipUi && controlUiEnabled) {
    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }
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

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const tokenParam =
    settings.authMode === "token" && settings.gatewayToken
      ? `?token=${encodeURIComponent(settings.gatewayToken)}`
      : "";
  const authedUrl = `${links.httpUrl}${tokenParam}`;
  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
  const bootstrapPath = path.join(
    resolveUserPath(options.workspaceDir),
    DEFAULT_BOOTSTRAP_FILENAME,
  );
  const hasBootstrap = await fs
    .access(bootstrapPath)
    .then(() => true)
    .catch(() => false);

  await prompter.note(
    [
      `Web UI: ${links.httpUrl}`,
      tokenParam ? `Web UI (with token): ${authedUrl}` : undefined,
      `Gateway WS: ${links.wsUrl}`,
      gatewayStatusLine,
      "Docs: https://docs.molt.bot/web/control-ui",
    ]
      .filter(Boolean)
      .join("\n"),
    "Control UI",
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;

  if (!opts.skipUi && gatewayProbe.ok) {
    if (hasBootstrap) {
      await prompter.note(
        [
          "This is the defining action that makes your agent you.",
          "Please take your time.",
          "The more you tell it, the better the experience will be.",
          'We will send: "Wake up, my friend!"',
        ].join("\n"),
        "Start TUI (best option!)",
      );
    }

    await prompter.note(
      [
        "Gateway token: shared auth for the Gateway + Control UI.",
        "Stored in: ~/.clawdbot/moltbot.json (gateway.auth.token) or CLAWDBOT_GATEWAY_TOKEN.",
        "Web UI stores a copy in this browser's localStorage (moltbot.control.settings.v1).",
        `Get the tokenized link anytime: ${formatCliCommand("moltbot dashboard --no-open")}`,
      ].join("\n"),
      "Token",
    );

    hatchChoice = (await prompter.select({
      message: "How do you want to hatch your bot?",
      options: [
        { value: "tui", label: "Hatch in TUI (recommended)" },
        { value: "web", label: "Open the Web UI" },
        { value: "later", label: "Do this later" },
      ],
      initialValue: "tui",
    })) as "tui" | "web" | "later";

    if (hatchChoice === "tui") {
      await runTui({
        url: links.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? nextConfig.gateway?.auth?.password : "",
        // Safety: onboarding TUI should not auto-deliver to lastProvider/lastTo.
        deliver: false,
        message: hasBootstrap ? "Wake up, my friend!" : undefined,
      });
      if (settings.authMode === "token" && settings.gatewayToken) {
        seededInBackground = await openUrlInBackground(authedUrl);
      }
      if (seededInBackground) {
        await prompter.note(
          `Web UI seeded in the background. Open later with: ${formatCliCommand(
            "moltbot dashboard --no-open",
          )}`,
          "Web UI",
        );
      }
    } else if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.gatewayToken,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
      await prompter.note(
        [
          `Dashboard link (with token): ${authedUrl}`,
          controlUiOpened
            ? "Opened in your browser. Keep that tab to control Moltbot."
            : "Copy/paste this URL in a browser on this machine to control Moltbot.",
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        "Dashboard ready",
      );
    } else {
      await prompter.note(
        `When you're ready: ${formatCliCommand("moltbot dashboard --no-open")}`,
        "Later",
      );
    }
  } else if (opts.skipUi) {
    await prompter.note("Skipping Control UI/TUI prompts.", "Control UI");
  }

  await prompter.note(
    ["Back up your agent workspace.", "Docs: https://docs.molt.bot/concepts/agent-workspace"].join(
      "\n",
    ),
    "Workspace backup",
  );

  await prompter.note(
    "Running agents on your computer is risky — harden your setup: https://docs.molt.bot/security",
    "Security",
  );

  const shouldOpenControlUi =
    !opts.skipUi &&
    settings.authMode === "token" &&
    Boolean(settings.gatewayToken) &&
    hatchChoice === null;
  if (shouldOpenControlUi) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: settings.gatewayToken,
      });
    }

    await prompter.note(
      [
        `Dashboard link (with token): ${authedUrl}`,
        controlUiOpened
          ? "Opened in your browser. Keep that tab to control Moltbot."
          : "Copy/paste this URL in a browser on this machine to control Moltbot.",
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      "Dashboard ready",
    );
  }

  const webSearchKey = (nextConfig.tools?.web?.search?.apiKey ?? "").trim();
  const webSearchEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  const hasWebSearchKey = Boolean(webSearchKey || webSearchEnv);
  await prompter.note(
    hasWebSearchKey
      ? [
          "Web search is enabled, so your agent can look things up online when needed.",
          "",
          webSearchKey
            ? "API key: stored in config (tools.web.search.apiKey)."
            : "API key: provided via BRAVE_API_KEY env var (Gateway environment).",
          "Docs: https://docs.molt.bot/tools/web",
        ].join("\n")
      : [
          "If you want your agent to be able to search the web, you’ll need an API key.",
          "",
          "Moltbot uses Brave Search for the `web_search` tool. Without a Brave Search API key, web search won’t work.",
          "",
          "Set it up interactively:",
          `- Run: ${formatCliCommand("moltbot configure --section web")}`,
          "- Enable web_search and paste your Brave Search API key",
          "",
          "Alternative: set BRAVE_API_KEY in the Gateway environment (no config changes).",
          "Docs: https://docs.molt.bot/tools/web",
        ].join("\n"),
    "Web search (optional)",
  );

  await prompter.note(
    'What now: https://molt.bot/showcase ("What People Are Building").',
    "What now",
  );

  await prompter.outro(
    controlUiOpened
      ? "Onboarding complete. Dashboard opened with your token; keep that tab to control Moltbot."
      : seededInBackground
        ? "Onboarding complete. Web UI seeded in the background; open it anytime with the tokenized link above."
        : "Onboarding complete. Use the tokenized dashboard link above to control Moltbot.",
  );
}
