import fs from "node:fs/promises";
import path from "node:path";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../commands/gateway-install-token.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { launchTuiCli } from "../tui/tui-launch.js";
import { resolveUserPath } from "../utils.js";
import { listConfiguredWebSearchProviders } from "../web-search/runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { setupWizardShellCompletion } from "./setup.completion.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings, WizardFlow } from "./setup.types.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

type OnboardSearchModule = typeof import("../commands/onboard-search.js");

let onboardSearchModulePromise: Promise<OnboardSearchModule> | undefined;
const HATCH_TUI_TIMEOUT_MS = 5 * 60 * 1000;

function getLocalizedGatewayDaemonRuntimeOptions() {
  return GATEWAY_DAEMON_RUNTIME_OPTIONS.map((option) => ({
    hint:
      option.value === "node"
        ? t("wizard.finalize.daemonRuntimeNodeHint")
        : (option.hint ?? undefined),
    label: option.value === "node" ? t("wizard.finalize.daemonRuntimeNode") : option.label,
    value: option.value,
  }));
}

function loadOnboardSearchModule(): Promise<OnboardSearchModule> {
  onboardSearchModulePromise ??= import("../commands/onboard-search.js");
  return onboardSearchModulePromise;
}

export async function finalizeSetupWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
  let gatewayProbe: { ok: boolean; detail?: string } = { ok: true };
  let resolvedGatewayPassword = "";

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string | (() => string | undefined) },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(
        typeof options.doneMessage === "function" ? options.doneMessage() : options.doneMessage,
      );
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(t("wizard.finalize.systemdUnavailable"), "Systemd");
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason: t("wizard.finalize.systemdLingerReason"),
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
      message: t("wizard.finalize.installGateway"),
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(
      t("wizard.finalize.systemdInstallSkipped"),
      t("wizard.finalize.gatewayService"),
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: t("wizard.finalize.daemonRuntime"),
            options: getLocalizedGatewayDaemonRuntimeOptions(),
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(
        t("wizard.finalize.quickstartNodeRuntime"),
        t("wizard.finalize.daemonRuntime"),
      );
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    let restartWasScheduled = false;
    if (loaded) {
      const action = await prompter.select({
        message: t("wizard.finalize.alreadyInstalled"),
        options: [
          { value: "restart", label: t("wizard.finalize.restart") },
          { value: "reinstall", label: t("wizard.finalize.reinstall") },
          { value: "skip", label: t("common.skip") },
        ],
      });
      if (action === "restart") {
        let restartDoneMessage = t("wizard.finalize.gatewayServiceRestarted");
        await withWizardProgress(
          t("wizard.finalize.gatewayService"),
          { doneMessage: () => restartDoneMessage },
          async (progress) => {
            progress.update(t("wizard.finalize.gatewayServiceRestarting"));
            const restartResult = await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
            const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
            restartDoneMessage = restartStatus.scheduled
              ? t("wizard.finalize.gatewayServiceRestartScheduled")
              : t("wizard.finalize.gatewayServiceRestarted");
            restartWasScheduled = restartStatus.scheduled;
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          t("wizard.finalize.gatewayService"),
          { doneMessage: t("wizard.finalize.gatewayServiceUninstalled") },
          async (progress) => {
            progress.update(t("wizard.finalize.gatewayServiceUninstalling"));
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (
      !loaded ||
      (!restartWasScheduled && loaded && !(await service.isLoaded({ env: process.env })))
    ) {
      const progress = prompter.progress(t("wizard.finalize.gatewayService"));
      let installError: string | null = null;
      try {
        progress.update(t("wizard.finalize.gatewayServicePreparing"));
        const tokenResolution = await resolveGatewayInstallToken({
          config: nextConfig,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          await prompter.note(warning, "Gateway service");
        }
        if (tokenResolution.unavailableReason) {
          installError = [
            t("wizard.finalize.gatewayInstallBlocked"),
            tokenResolution.unavailableReason,
            t("wizard.finalize.gatewayInstallFixAuth"),
          ].join(" ");
        } else {
          const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan(
            {
              env: process.env,
              port: settings.port,
              runtime: daemonRuntime,
              warn: (message, title) => prompter.note(message, title),
              config: nextConfig,
            },
          );

          progress.update(t("wizard.finalize.gatewayServiceInstalling"));
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        }
      } catch (err) {
        installError = formatErrorMessage(err);
      } finally {
        progress.stop(
          installError
            ? t("wizard.finalize.gatewayServiceInstallFailed")
            : t("wizard.finalize.gatewayServiceInstalled"),
        );
      }
      if (installError) {
        await prompter.note(
          t("wizard.finalize.gatewayServiceInstallFailedWithError", { error: installError }),
          "Gateway",
        );
        await prompter.note(gatewayInstallErrorHint(), "Gateway");
      }
    }
  }

  if (settings.authMode === "password") {
    try {
      resolvedGatewayPassword =
        (await resolveSetupSecretInputString({
          config: nextConfig,
          value: nextConfig.gateway?.auth?.password,
          path: "gateway.auth.password",
          env: process.env,
        })) ?? "";
    } catch (error) {
      await prompter.note(
        [
          t("wizard.finalize.secretRefAuthFailed", { field: "gateway.auth.password" }),
          formatErrorMessage(error),
        ].join("\n"),
        t("wizard.gateway.auth"),
      );
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    gatewayProbe = await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.authMode === "token" ? settings.gatewayToken : undefined,
      password: settings.authMode === "password" ? resolvedGatewayPassword : undefined,
      deadlineMs: 15_000,
    });
    if (gatewayProbe.ok) {
      try {
        const healthConfig: OpenClawConfig =
          settings.authMode === "token" && settings.gatewayToken
            ? {
                ...nextConfig,
                gateway: {
                  ...nextConfig.gateway,
                  auth: {
                    ...nextConfig.gateway?.auth,
                    mode: "token",
                    token: settings.gatewayToken,
                  },
                },
              }
            : nextConfig;
        await healthCommand(
          {
            json: false,
            timeoutMs: 10_000,
            config: healthConfig,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
            password: settings.authMode === "password" ? resolvedGatewayPassword : undefined,
          },
          runtime,
        );
      } catch (err) {
        runtime.error(formatHealthCheckFailure(err));
        await prompter.note(
          [
            t("common.docs"),
            "https://docs.openclaw.ai/gateway/health",
            "https://docs.openclaw.ai/gateway/troubleshooting",
          ].join("\n"),
          t("wizard.finalize.healthCheckHelp"),
        );
      }
    } else if (installDaemon) {
      runtime.error(
        formatHealthCheckFailure(
          new Error(
            gatewayProbe.detail ?? `gateway did not become reachable at ${probeLinks.wsUrl}`,
          ),
        ),
      );
      await prompter.note(
        [
          t("common.docs"),
          "https://docs.openclaw.ai/gateway/health",
          "https://docs.openclaw.ai/gateway/troubleshooting",
        ].join("\n"),
        t("wizard.finalize.healthCheckHelp"),
      );
    } else {
      await prompter.note(
        [
          t("wizard.finalize.gatewayNotDetected"),
          t("wizard.finalize.noBackgroundGatewayExpected"),
          t("wizard.finalize.startGatewayNow", {
            command: formatCliCommand("openclaw gateway run"),
          }),
          t("wizard.finalize.rerunInstallDaemon", {
            command: formatCliCommand("openclaw onboard --install-daemon"),
          }),
          t("wizard.finalize.skipHealthNextTime", {
            command: formatCliCommand("openclaw onboard --skip-health"),
          }),
        ].join("\n"),
        "Gateway",
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
      t("wizard.finalize.addNodes"),
      `- ${t("wizard.finalize.nodeMac")}`,
      `- ${t("wizard.finalize.nodeIos")}`,
      `- ${t("wizard.finalize.nodeAndroid")}`,
    ].join("\n"),
    t("wizard.finalize.optionalApps"),
  );

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
    tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  if (opts.skipHealth || !gatewayProbe.ok) {
    gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token: settings.authMode === "token" ? settings.gatewayToken : undefined,
      password: settings.authMode === "password" ? resolvedGatewayPassword : "",
    });
  }
  const gatewayStatusLine = gatewayProbe.ok
    ? t("wizard.finalize.gatewayReachable")
    : t("wizard.finalize.gatewayNotDetectedStatus", {
        detail: gatewayProbe.detail ? ` (${gatewayProbe.detail})` : "",
      });
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
      t("wizard.finalize.webUiUrl", { url: links.httpUrl }),
      settings.authMode === "token" && settings.gatewayToken
        ? t("wizard.finalize.webUiWithTokenUrl", { url: authedUrl })
        : undefined,
      t("wizard.finalize.gatewayWsUrl", { url: links.wsUrl }),
      gatewayStatusLine,
      t("wizard.finalize.controlUiDocs"),
    ]
      .filter(Boolean)
      .join("\n"),
    "Control UI",
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;
  let launchedTui = false;

  if (!opts.skipUi) {
    if (hasBootstrap) {
      await prompter.note(
        [
          t("wizard.finalize.workspaceReady"),
          t("wizard.finalize.firstTerminalChat"),
          t("wizard.finalize.editBootstrap"),
        ].join("\n"),
        t("wizard.finalize.hatchYourAgent"),
      );
    }

    if (gatewayProbe.ok) {
      await prompter.note(
        [
          t("wizard.finalize.gatewayTokenShared"),
          t("wizard.finalize.gatewayTokenStored"),
          t("wizard.finalize.gatewayTokenView", {
            command: formatCliCommand("openclaw config get gateway.auth.token"),
          }),
          t("wizard.finalize.gatewayTokenGenerate", {
            command: formatCliCommand("openclaw doctor --generate-gateway-token"),
          }),
          t("wizard.finalize.dashboardTokenMemory"),
          t("wizard.finalize.dashboardOpenAnytime", {
            command: formatCliCommand("openclaw dashboard --no-open"),
          }),
          t("wizard.finalize.dashboardTokenPrompt"),
        ].join("\n"),
        "Token",
      );
    }

    const hatchOptions: { value: "tui" | "web" | "later"; label: string }[] = [
      { value: "tui", label: t("wizard.finalize.terminalHatch") },
      ...(gatewayProbe.ok
        ? [{ value: "web" as const, label: t("wizard.finalize.browserHatch") }]
        : []),
      { value: "later", label: t("wizard.finalize.hatchLater") },
    ];

    hatchChoice = await prompter.select({
      message: t("wizard.finalize.hatchPrompt"),
      options: hatchOptions,
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
      try {
        await launchTuiCli({
          local: true,
          deliver: false,
          message: hasBootstrap ? t("wizard.finalize.bootstrapHatchMessage") : undefined,
          timeoutMs: HATCH_TUI_TIMEOUT_MS,
        });
      } finally {
        restoreTerminalState("post-setup tui", { resumeStdinIfPaused: true });
      }
      launchedTui = true;
    } else if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        });
      }
      await prompter.note(
        [
          t("wizard.finalize.dashboardLinkWithToken", { url: authedUrl }),
          controlUiOpened
            ? t("wizard.finalize.dashboardOpened")
            : t("wizard.finalize.dashboardCopyPaste"),
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        t("wizard.finalize.dashboardReady"),
      );
    } else {
      await prompter.note(
        t("wizard.finalize.dashboardWhenReady", {
          command: formatCliCommand("openclaw dashboard --no-open"),
        }),
        t("wizard.finalize.laterTitle"),
      );
    }
  } else if (opts.skipUi) {
    await prompter.note(t("wizard.finalize.skipControlUi"), t("wizard.finalize.controlUiTitle"));
  }

  await prompter.note(
    [t("wizard.finalize.backupWorkspace"), t("wizard.finalize.workspaceDocs")].join("\n"),
    t("wizard.finalize.workspaceBackupTitle"),
  );

  await prompter.note(t("wizard.finalize.securityReminder"), t("wizard.security.title"));

  await setupWizardShellCompletion({ flow, prompter });

  const shouldOpenControlUi =
    !opts.skipUi &&
    gatewayProbe.ok &&
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
        t("wizard.finalize.dashboardLinkWithToken", { url: authedUrl }),
        controlUiOpened
          ? t("wizard.finalize.dashboardOpened")
          : t("wizard.finalize.dashboardCopyPaste"),
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      t("wizard.finalize.dashboardReady"),
    );
  }

  const codexNativeSummary = describeCodexNativeWebSearch(nextConfig);
  const webSearchProvider = nextConfig.tools?.web?.search?.provider;
  const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
  const configuredSearchProviders = listConfiguredWebSearchProviders({ config: nextConfig });
  if (webSearchProvider) {
    const { resolveExistingKey, hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
    const entry = configuredSearchProviders.find((e) => e.id === webSearchProvider);
    const label = entry?.label ?? webSearchProvider;
    const storedKey = entry ? resolveExistingKey(nextConfig, webSearchProvider) : undefined;
    const keyConfigured = entry ? hasExistingKey(nextConfig, webSearchProvider) : false;
    const envAvailable = entry ? hasKeyInEnv(entry) : false;
    const hasKey = keyConfigured || envAvailable;
    const keySource = storedKey
      ? t("wizard.finalize.webSearchKeyStored")
      : keyConfigured
        ? t("wizard.finalize.webSearchKeyRef")
        : envAvailable
          ? t("wizard.finalize.webSearchKeyEnv", { env: entry?.envVars.join(" / ") ?? "" })
          : undefined;
    if (!entry) {
      await prompter.note(
        [
          t("wizard.finalize.webSearchProviderUnavailable", { provider: label }),
          t("wizard.finalize.webSearchUnavailableAction"),
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    } else if (webSearchEnabled !== false && hasKey) {
      await prompter.note(
        [
          t("wizard.finalize.webSearchEnabled"),
          "",
          t("wizard.finalize.webSearchProvider", { provider: label }),
          ...(keySource ? [keySource] : []),
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    } else if (!hasKey) {
      await prompter.note(
        [
          t("wizard.finalize.webSearchNoKey", { provider: label }),
          t("wizard.finalize.webSearchNeedsKey"),
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          t("wizard.finalize.webSearchGetKey", {
            url: entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web",
          }),
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    } else {
      await prompter.note(
        [
          t("wizard.finalize.webSearchDisabled", { provider: label }),
          t("wizard.finalize.webSearchReenable", {
            command: formatCliCommand("openclaw configure --section web"),
          }),
          "",
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    }
  } else {
    // Legacy configs may have a working key (e.g. apiKey or BRAVE_API_KEY) without
    // an explicit provider. Runtime auto-detects these, so avoid saying "skipped".
    const { hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
    const legacyDetected = configuredSearchProviders.find(
      (e) => hasExistingKey(nextConfig, e.id) || hasKeyInEnv(e),
    );
    if (legacyDetected) {
      await prompter.note(
        [
          t("wizard.finalize.webSearchAutoDetected", { provider: legacyDetected.label }),
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    } else if (codexNativeSummary) {
      await prompter.note(
        [
          t("wizard.finalize.managedWebSearchSkipped"),
          codexNativeSummary,
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    } else {
      await prompter.note(
        [
          t("wizard.finalize.webSearchSkipped"),
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          t("wizard.finalize.webDocs"),
        ].join("\n"),
        t("wizard.finalize.webSearchTitle"),
      );
    }
  }

  if (codexNativeSummary) {
    await prompter.note(
      [
        codexNativeSummary,
        t("wizard.finalize.codexNativeSearchOnly"),
        t("wizard.finalize.webDocs"),
      ].join("\n"),
      t("wizard.finalize.codexNativeSearchTitle"),
    );
  }

  await prompter.note(t("wizard.finalize.whatNow"), t("wizard.finalize.whatNowTitle"));

  await prompter.outro(
    controlUiOpened
      ? t("wizard.finalize.outroDashboardOpened")
      : seededInBackground
        ? t("wizard.finalize.outroSeeded")
        : t("wizard.finalize.outroDashboardLink"),
  );

  return { launchedTui };
}
