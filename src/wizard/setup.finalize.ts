// Setup finalize helpers write onboarding output and follow-up state.
import fs from "node:fs/promises";
import path from "node:path";
import { restoreTerminalState } from "../../packages/terminal-core/src/restore.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
import { hasAuthProfileForProvider } from "../agents/tools/model-config.helpers.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveControlUiHandoffTarget,
  waitForControlUiDocument,
} from "../commands/control-ui-handoff.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../commands/gateway-install-token.js";
import { resolveGatewayStartupTiming } from "../commands/gateway-startup-timing.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommandNonExiting } from "../commands/health.js";
import {
  probeGatewayReachable,
  waitForGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveLocalControlUiProbeLinks,
} from "../commands/onboard-helpers.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  describeGatewayServiceRestart,
  formatGatewayServiceStartRepairIssues,
  resolveGatewayService,
  startGatewayService,
} from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { isContainerEnvironment } from "../infra/container-environment.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  formatExternalSupervisorActionRequired,
  isGatewayExternallySupervised,
} from "../infra/gateway-supervision.js";
import { formatWindowsGatewayFirewallGuidance } from "../infra/windows-gateway-firewall-diagnostics.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  cancelProcessExitAfterTuiReturn,
  resolveTuiShutdownHardExitMs,
  runTui,
  scheduleProcessExitAfterTuiReturn,
} from "../tui/tui.js";
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
  hadExistingConfig?: boolean;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

const HATCH_TUI_TIMEOUT_MS = 5 * 60 * 1000;

function buildSessionGatewayAuthOverride(params: {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
  resolvedGatewayPassword: string;
}): GatewayAuthConfig | undefined {
  if (params.settings.authMode === "token" && params.settings.gatewayToken) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: "token",
      token: params.settings.gatewayToken,
    };
  }
  if (params.settings.authMode === "password" && params.resolvedGatewayPassword) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: "password",
      password: params.resolvedGatewayPassword,
    };
  }
  return params.nextConfig.gateway?.auth;
}

async function startSessionGatewayForOnboarding(params: {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
  resolvedGatewayPassword: string;
  prompter: WizardPrompter;
}): Promise<import("../gateway/server.js").GatewayServer | undefined> {
  const progress = params.prompter.progress(t("wizard.finalize.sessionGatewayStarting"));
  try {
    const { startGatewayServer } = await import("../gateway/server.js");
    const server = await startGatewayServer(params.settings.port, {
      bind: params.settings.bind,
      ...(params.settings.bind === "custom" && params.settings.customBindHost
        ? { host: params.settings.customBindHost }
        : {}),
      auth: buildSessionGatewayAuthOverride({
        nextConfig: params.nextConfig,
        settings: params.settings,
        resolvedGatewayPassword: params.resolvedGatewayPassword,
      }),
      tailscale: params.nextConfig.gateway?.tailscale,
    });
    progress.stop(t("wizard.finalize.sessionGatewayStarted"));
    return server;
  } catch (error) {
    progress.stop(t("wizard.finalize.sessionGatewayStartFailed"));
    await params.prompter.note(
      [
        t("wizard.finalize.sessionGatewayStartFailed"),
        formatErrorMessage(error),
        t("wizard.finalize.startGatewayNow", {
          command: formatCliCommand("openclaw gateway run"),
        }),
      ].join("\n"),
      "Gateway",
    );
    return undefined;
  }
}

async function closeSessionGatewayForOnboarding(params: {
  sessionGateway: import("../gateway/server.js").GatewayServer;
  runtime: RuntimeEnv;
  reason: string;
}): Promise<void> {
  await params.sessionGateway.close({ reason: params.reason }).catch((error: unknown) => {
    params.runtime.error(formatErrorMessage(error));
  });
}

function getLocalizedGatewayDaemonRuntimeOptions() {
  return GATEWAY_DAEMON_RUNTIME_OPTIONS.map((option) => ({
    hint: t(
      option.value === "node"
        ? "wizard.finalize.daemonRuntimeNodeHint"
        : "wizard.finalize.daemonRuntimeBunHint",
    ),
    label: t(
      option.value === "node"
        ? "wizard.finalize.daemonRuntimeNode"
        : "wizard.finalize.daemonRuntimeBun",
    ),
    value: option.value,
  }));
}

const loadSearchSetupModule = createLazyRuntimeModule(() => import("../flows/search-setup.js"));

export type GatewayServiceSetupOutcome =
  | {
      status: "ready";
      action: "installed" | "started" | "reused" | "restarted" | "restart-scheduled";
    }
  | { status: "skipped"; reason: "explicit" | "systemd-unavailable" | "external" }
  | { status: "failed"; error: string };

function buildGatewayRecoveryProjection(params: {
  gateway: GatewayServiceSetupOutcome;
  reachable: boolean;
  serviceLabel?: string;
}): {
  detail: string;
  summary: string;
} {
  const { gateway } = params;
  const notDetected = t("wizard.finalize.gatewayNotDetected");
  if (params.reachable && gateway.status !== "failed") {
    return { detail: t("wizard.finalize.gatewayReachable"), summary: t("wizard.guided.complete") };
  }
  if (gateway.status === "ready") {
    const service = params.serviceLabel ?? t("wizard.finalize.gatewayService");
    const detail = t("wizard.finalize.managedGatewayUnreachable", {
      service,
      statusCommand: formatCliCommand("openclaw gateway status --deep"),
      recoveryCommand: formatCliCommand("openclaw gateway restart"),
    });
    return { detail, summary: `${notDetected} ${detail.replaceAll("\n", " ")}` };
  }
  if (gateway.status === "failed") {
    const service = params.serviceLabel ?? t("wizard.finalize.gatewayService");
    const detail = t("wizard.finalize.managedGatewaySetupFailed", {
      service,
      error: gateway.error,
      statusCommand: formatCliCommand("openclaw gateway status --deep"),
      recoveryCommand: formatCliCommand("openclaw gateway install --force"),
    });
    return {
      detail,
      summary: `${params.reachable ? "" : `${notDetected} `}${detail.replaceAll("\n", " ")}`,
    };
  }

  const startGuidance =
    gateway.reason === "external"
      ? formatExternalSupervisorActionRequired("start the gateway")
      : t("wizard.finalize.startGatewayNow", {
          command: formatCliCommand("openclaw gateway run"),
        });
  const summary = [notDetected, startGuidance].join(" ");
  if (gateway.reason === "external") {
    return { detail: [notDetected, startGuidance].join("\n"), summary };
  }
  return {
    detail: [
      notDetected,
      t("wizard.finalize.noBackgroundGatewayExpected"),
      startGuidance,
      t("wizard.finalize.rerunInstallDaemon", {
        command: formatCliCommand("openclaw onboard --install-daemon"),
      }),
      t("wizard.finalize.skipHealthNextTime", {
        command: formatCliCommand("openclaw onboard --skip-health"),
      }),
    ].join("\n"),
    summary,
  };
}

/**
 * Ensure the gateway service matches the onboarding decision: prompt/decide
 * whether to install the daemon, then install/restart/reinstall it. Shared by
 * the classic wizard finalize and the bootstrap onboarding flow.
 */
export async function ensureGatewayServiceForOnboarding(params: {
  flow: WizardFlow;
  opts: Pick<OnboardOptions, "installDaemon" | "daemonRuntime">;
  nextConfig: OpenClawConfig;
  settings: Pick<GatewayWizardSettings, "port">;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  /** Resume interrupted setup without restarting an already-running Gateway. */
  loadedAction?: "restart" | "resume";
}): Promise<{ gateway: GatewayServiceSetupOutcome; containerWithoutUserSystemd: boolean }> {
  const { flow, opts, nextConfig, settings, prompter, runtime } = params;

  const withWizardProgress = async <T>(
    label: string,
    optionsLocal: { doneMessage?: string | (() => string | undefined) },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(
        typeof optionsLocal.doneMessage === "function"
          ? optionsLocal.doneMessage()
          : optionsLocal.doneMessage,
      );
    }
  };

  if (isGatewayExternallySupervised()) {
    await prompter.note(
      formatExternalSupervisorActionRequired("manage the gateway service"),
      "Gateway",
    );
    return {
      gateway: { status: "skipped", reason: "external" },
      containerWithoutUserSystemd: false,
    };
  }

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  const linuxWithoutUserSystemd = process.platform === "linux" && !systemdAvailable;
  const containerWithoutUserSystemd = linuxWithoutUserSystemd && isContainerEnvironment();
  if (linuxWithoutUserSystemd) {
    await prompter.note(
      t(
        containerWithoutUserSystemd
          ? "wizard.finalize.containerSystemdUnavailable"
          : "wizard.finalize.systemdUnavailable",
      ),
      containerWithoutUserSystemd ? t("wizard.finalize.containerRuntimeTitle") : "Systemd",
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
      reason: t("wizard.finalize.systemdLingerReason"),
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (linuxWithoutUserSystemd) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: t("wizard.finalize.installGateway"),
      initialValue: true,
    });
  }

  if (linuxWithoutUserSystemd && installDaemon) {
    await prompter.note(
      t("wizard.finalize.systemdInstallSkipped"),
      t("wizard.finalize.gatewayService"),
    );
    installDaemon = false;
  }

  if (!installDaemon) {
    return {
      gateway: {
        status: "skipped",
        reason: linuxWithoutUserSystemd ? "systemd-unavailable" : "explicit",
      },
      containerWithoutUserSystemd,
    };
  }

  let gateway: GatewayServiceSetupOutcome = { status: "ready", action: "reused" };
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
    if (params.loadedAction === "resume") {
      try {
        const started = await startGatewayService(
          service,
          { env: process.env, stdout: process.stdout },
          settings.port,
        );
        if (started.outcome === "already-running" || started.outcome === "started") {
          return {
            gateway: {
              status: "ready",
              action: started.outcome === "already-running" ? "reused" : "started",
            },
            containerWithoutUserSystemd,
          };
        }
        if (started.outcome === "repair-required") {
          return {
            gateway: {
              status: "failed",
              error: formatGatewayServiceStartRepairIssues(started.issues),
            },
            containerWithoutUserSystemd,
          };
        }
      } catch (error) {
        return {
          gateway: { status: "failed", error: formatErrorMessage(error) },
          containerWithoutUserSystemd,
        };
      }
    }
    const loaded = await service.isLoaded({ env: process.env });
    let shouldInstall = !loaded;
    if (loaded) {
      const action =
        (params.loadedAction === "restart" ? params.loadedAction : undefined) ??
        (await prompter.select({
          message: t("wizard.finalize.alreadyInstalled"),
          options: [
            { value: "restart", label: t("wizard.finalize.restart") },
            { value: "reinstall", label: t("wizard.finalize.reinstall") },
            { value: "skip", label: t("common.skip") },
          ],
        }));
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
            gateway = {
              status: "ready",
              action: restartStatus.scheduled ? "restart-scheduled" : "restarted",
            };
          },
        );
      } else if (action === "reinstall") {
        // Preserve the old definition so the install owner can replace or restore it.
        shouldInstall = true;
      }
    }

    if (shouldInstall) {
      const progress = prompter.progress(t("wizard.finalize.gatewayService"));
      let installError: string | null = null;
      const installWarnings: Array<{ message: string; title?: string }> = [];
      const flushInstallWarnings = async () => {
        let warning: (typeof installWarnings)[number] | undefined;
        // Remove before awaiting so a rejected note is not replayed when the
        // outer catch drains warnings that remain in the planner's queue.
        while ((warning = installWarnings.shift()) !== undefined) {
          await prompter.note(warning.message, warning.title);
        }
      };
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
          const existingCommand = await service.readCommand(process.env).catch(() => null);
          const { programArguments, workingDirectory, environment, environmentValueSources } =
            await buildGatewayInstallPlan({
              env: process.env,
              port: settings.port,
              runtime: daemonRuntime,
              existingCommand,
              warn: (message, title) => {
                installWarnings.push({ message, title });
              },
              config: nextConfig,
            });
          await flushInstallWarnings();

          progress.update(t("wizard.finalize.gatewayServiceInstalling"));
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
            environmentValueSources,
          });
          gateway = { status: "ready", action: "installed" };
        }
      } catch (err) {
        await flushInstallWarnings();
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
        gateway = { status: "failed", error: installError };
      }
    }
  }

  return { gateway, containerWithoutUserSystemd };
}

export async function finalizeSetupWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
  let gatewayProbe: { ok: boolean; detail?: string } = { ok: true };
  // Reachability and health are separate facts: a reachable gateway can still
  // fail its health check, and the outro must not report plain success then.
  let gatewayHealthCheckFailed = false;
  let resolvedGatewayPassword = "";
  let sessionGateway: import("../gateway/server.js").GatewayServer | undefined;

  const { gateway, containerWithoutUserSystemd } = await ensureGatewayServiceForOnboarding({
    flow,
    opts,
    nextConfig,
    settings,
    prompter,
    runtime,
  });

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

  if (containerWithoutUserSystemd && !opts.skipUi) {
    sessionGateway = await startSessionGatewayForOnboarding({
      nextConfig,
      settings,
      resolvedGatewayPassword,
      prompter,
    });
  }

  try {
    if (!opts.skipHealth) {
      const probeLinks = resolveLocalControlUiProbeLinks({
        bind: nextConfig.gateway?.bind ?? "loopback",
        port: settings.port,
        customBindHost: nextConfig.gateway?.customBindHost,
        basePath: undefined,
        tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
      });
      const probeOptions = {
        url: probeLinks.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? resolvedGatewayPassword : undefined,
      };
      // A failed replacement may leave the old Gateway alive. Observe it once;
      // only successful install/restart needs the startup grace period.
      gatewayProbe =
        gateway.status === "failed"
          ? await probeGatewayReachable(probeOptions)
          : await waitForGatewayReachable({
              ...probeOptions,
              ...(gateway.status === "ready" && gateway.action !== "reused"
                ? resolveGatewayStartupTiming()
                : { deadlineMs: 15_000 }),
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
          await healthCommandNonExiting(
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
          gatewayHealthCheckFailed = true;
          // A trapped ExitError means healthCommand already printed its own
          // reachable-gateway diagnostic; re-formatting it would only add noise.
          if (!(err instanceof ExitError)) {
            runtime.error(formatHealthCheckFailure(err));
          }
          await prompter.note(
            [
              t("common.docs"),
              "https://docs.openclaw.ai/gateway/health",
              "https://docs.openclaw.ai/gateway/troubleshooting",
            ].join("\n"),
            t("wizard.finalize.healthCheckHelp"),
          );
        }
      } else if (gateway.status !== "skipped") {
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
        await prompter.note(
          buildGatewayRecoveryProjection({
            gateway,
            reachable: false,
            serviceLabel: resolveGatewayService().label,
          }).detail,
          "Gateway",
        );
      } else {
        await prompter.note(
          buildGatewayRecoveryProjection({ gateway, reachable: false }).detail,
          "Gateway",
        );
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
    const displayLinks = await resolveAdvertisedControlUiLinks({
      bind: settings.bind,
      port: settings.port,
      customBindHost: settings.customBindHost,
      basePath: controlUiBasePath,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    const probeLinks = resolveLocalControlUiProbeLinks({
      bind: settings.bind,
      port: settings.port,
      customBindHost: settings.customBindHost,
      basePath: controlUiBasePath,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    if (opts.skipHealth || (!gatewayProbe.ok && gateway.status !== "failed")) {
      gatewayProbe = await probeGatewayReachable({
        url: probeLinks.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? resolvedGatewayPassword : "",
      });
    }
    const controlUiEnabled =
      nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
    // --skip-ui retains its clean informational URL; interactive links require served HTML.
    let dashboardReady = controlUiEnabled && opts.skipUi === true;
    if (!opts.skipUi && controlUiEnabled && gatewayProbe.ok) {
      let progress: ReturnType<WizardPrompter["progress"]> | undefined;
      try {
        const target = await resolveControlUiHandoffTarget({
          config: {
            ...nextConfig,
            gateway: {
              ...nextConfig.gateway,
              port: settings.port,
              bind: settings.bind,
              ...(settings.customBindHost ? { customBindHost: settings.customBindHost } : {}),
              ...(controlUiBasePath
                ? { controlUi: { ...nextConfig.gateway?.controlUi, basePath: controlUiBasePath } }
                : {}),
            },
          },
          env: { ...process.env, OPENCLAW_GATEWAY_PORT: String(settings.port) },
        });
        const document = await waitForControlUiDocument({
          url: target.documentUrl,
          tlsConfig: target.tlsConfig,
          onPending: () => {
            progress = prompter.progress(t("wizard.guided.controlUiPreparing"));
          },
        });
        dashboardReady = document.ready;
        if (!document.ready) {
          runtime.error(document.reason);
        }
      } catch (error) {
        dashboardReady = false;
        runtime.error(formatErrorMessage(error));
      } finally {
        progress?.stop();
      }
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? t("wizard.finalize.gatewayReachable")
      : t("wizard.finalize.gatewayNotDetectedStatus", {
          detail: gatewayProbe.detail ? ` (${gatewayProbe.detail})` : "",
        });
    const windowsFirewallLines = formatWindowsGatewayFirewallGuidance({
      bind: settings.bind,
    });
    const bootstrapPath = path.join(
      resolveUserPath(options.workspaceDir),
      DEFAULT_BOOTSTRAP_FILENAME,
    );
    const hasBootstrap = await fs
      .access(bootstrapPath)
      .then(() => true)
      .catch(() => false);
    const agentDir = resolveDefaultAgentDir(nextConfig);
    // Seed only when the selected route is proven ready. Unknown or incompatible
    // route facts must not turn the onboarding greeting into a guaranteed failure.
    const [
      { resolveDefaultModelAuthStatus, resolveDefaultModelCatalogFacts },
      { loadPreparedModelCatalogSnapshot },
    ] = await Promise.all([
      import("../commands/auth-choice.js"),
      import("../agents/prepared-model-catalog.js"),
    ]);
    const modelCatalog = await loadPreparedModelCatalogSnapshot({
      config: nextConfig,
      readOnly: true,
    });
    const modelCatalogFacts = resolveDefaultModelCatalogFacts(nextConfig, modelCatalog.entries, {
      routeVariants: modelCatalog.routeVariants,
    });
    const modelAuthStatus = resolveDefaultModelAuthStatus(nextConfig, {
      agentDir,
      ...(modelCatalogFacts.observedRoutes
        ? { observedRoutes: modelCatalogFacts.observedRoutes }
        : {}),
    });
    const shouldSeedBootstrapHatch =
      hasBootstrap && options.hadExistingConfig !== true && modelAuthStatus.status === "ready";

    await prompter.note(
      [
        dashboardReady ? t("wizard.finalize.webUiUrl", { url: displayLinks.httpUrl }) : undefined,
        t("wizard.finalize.gatewayWsUrl", { url: displayLinks.wsUrl }),
        gatewayStatusLine,
        ...windowsFirewallLines,
        t("wizard.finalize.controlUiDocs"),
      ]
        .filter(Boolean)
        .join("\n"),
      "Control UI",
    );

    let launchedTui = false;
    const shouldLaunchTui = !opts.skipUi;

    if (shouldLaunchTui) {
      if (hasBootstrap) {
        await prompter.note(
          [
            t("wizard.finalize.workspaceReady"),
            ...(shouldSeedBootstrapHatch ? [t("wizard.finalize.firstTerminalChat")] : []),
            t("wizard.finalize.editBootstrap"),
          ].join("\n"),
          t("wizard.finalize.hatchYourAgent"),
        );
      }
      if (modelAuthStatus.status === "missing") {
        await prompter.note(
          [
            t("wizard.finalize.noModelAuth", { provider: modelAuthStatus.provider }),
            t("wizard.finalize.noModelAuthNext", {
              command: formatCliCommand("openclaw configure --section model"),
            }),
          ].join("\n"),
          t("wizard.finalize.noModelAuthTitle"),
        );
      }

      if (gatewayProbe.ok) {
        const tokenNotes = [
          t("wizard.finalize.gatewayTokenShared"),
          t("wizard.finalize.gatewayTokenStored"),
          t("wizard.finalize.gatewayTokenView", {
            command: formatCliCommand("openclaw gateway auth-token --show"),
          }),
          t("wizard.finalize.gatewayTokenGenerate", {
            command: formatCliCommand("openclaw doctor --generate-gateway-token"),
          }),
          t("wizard.finalize.dashboardOpenAnytime", {
            command: formatCliCommand("openclaw dashboard --no-open"),
          }),
        ].filter(Boolean);
        await prompter.note(tokenNotes.join("\n"), "Token");
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

    const codexNativeSummary = describeCodexNativeWebSearch(nextConfig);
    const webSearchProvider = nextConfig.tools?.web?.search?.provider;
    const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
    const configuredSearchProviders = listConfiguredWebSearchProviders({ config: nextConfig });
    if (webSearchProvider) {
      const { resolveExistingKey, hasExistingKey, hasKeyInEnv } = await loadSearchSetupModule();
      const entry = configuredSearchProviders.find((e) => e.id === webSearchProvider);
      const label = entry?.label ?? webSearchProvider;
      const storedKey = entry ? resolveExistingKey(nextConfig, webSearchProvider) : undefined;
      const keyConfigured = entry ? hasExistingKey(nextConfig, webSearchProvider) : false;
      const envAvailable = entry ? hasKeyInEnv(entry) : false;
      const hasKey = keyConfigured || envAvailable;
      const authProviderId = entry?.authProviderId?.trim();
      const authProviderLabel = authProviderId === "xai" ? "xAI" : authProviderId;
      const providerAuthProfileAvailable = authProviderId
        ? hasAuthProfileForProvider({
            provider: authProviderId,
            agentDir,
          })
        : false;
      const oauthAuthProfileAvailable =
        authProviderId && providerAuthProfileAvailable
          ? hasAuthProfileForProvider({
              provider: authProviderId,
              agentDir,
              type: "oauth",
            })
          : false;
      const hasCredential = hasKey || providerAuthProfileAvailable;
      const keySource = storedKey
        ? t("wizard.finalize.webSearchKeyStored")
        : keyConfigured
          ? t("wizard.finalize.webSearchKeyRef")
          : envAvailable
            ? t("wizard.finalize.webSearchKeyEnv", { env: entry?.envVars.join(" / ") ?? "" })
            : oauthAuthProfileAvailable && authProviderLabel
              ? t("wizard.finalize.webSearchOAuthProfile", { provider: authProviderLabel })
              : providerAuthProfileAvailable && authProviderLabel
                ? t("wizard.finalize.webSearchAuthProfile", { provider: authProviderLabel })
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
      } else if (webSearchEnabled !== false && entry.requiresCredential === false) {
        // Keyless providers (e.g. Parallel Search (Free), DuckDuckGo, Ollama) need
        // no API key — report ready rather than the credential-required warning.
        await prompter.note(
          [
            t("wizard.finalize.webSearchKeyFree"),
            "",
            t("wizard.finalize.webSearchProvider", { provider: label }),
            t("wizard.finalize.webDocs"),
          ].join("\n"),
          t("wizard.finalize.webSearchTitle"),
        );
      } else if (webSearchEnabled !== false && hasCredential) {
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
      } else if (entry.requiresCredential !== false && !hasCredential) {
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
      const { hasExistingKey, hasKeyInEnv } = await loadSearchSetupModule();
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
      !gatewayProbe.ok || gateway.status === "failed"
        ? buildGatewayRecoveryProjection({
            gateway,
            reachable: gatewayProbe.ok,
            serviceLabel: gateway.status === "skipped" ? undefined : resolveGatewayService().label,
          }).summary
        : gatewayHealthCheckFailed
          ? t("wizard.finalize.outroHealthCheckFailed", {
              command: formatCliCommand("openclaw health"),
            })
          : dashboardReady
            ? t("wizard.finalize.outroDashboardLink")
            : controlUiEnabled
              ? [
                  t("wizard.guided.complete"),
                  t("wizard.finalize.dashboardWhenReady", {
                    command: formatCliCommand("openclaw dashboard"),
                  }),
                ].join(" ")
              : t("wizard.guided.complete"),
    );

    if (shouldLaunchTui) {
      restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: false });
      try {
        await runTui({
          ...(gatewayProbe.ok
            ? {
                config: nextConfig,
                boundGateway: {
                  url: displayLinks.wsUrl,
                  ...(settings.authMode === "token" && settings.gatewayToken
                    ? { token: settings.gatewayToken }
                    : {}),
                  ...(settings.authMode === "password" && resolvedGatewayPassword
                    ? { password: resolvedGatewayPassword }
                    : {}),
                },
              }
            : { local: true }),
          deliver: false,
          message: shouldSeedBootstrapHatch
            ? t("wizard.finalize.bootstrapHatchMessage")
            : undefined,
          initialMessageTimeoutMs: HATCH_TUI_TIMEOUT_MS,
        });
      } finally {
        restoreTerminalState("post-setup tui", { resumeStdinIfPaused: false });
        if (sessionGateway) {
          // The temporary Gateway can own the same provider and child-process teardown as
          // local TUI mode. Reuse that longer budget while keeping shutdown bounded.
          const cleanupExitTimer = scheduleProcessExitAfterTuiReturn({
            delayMs: resolveTuiShutdownHardExitMs({ localMode: true }),
          });
          try {
            await closeSessionGatewayForOnboarding({
              sessionGateway,
              runtime,
              reason: "onboarding tui exited",
            });
            sessionGateway = undefined;
          } finally {
            cancelProcessExitAfterTuiReturn(cleanupExitTimer);
          }
        }
      }
      // Setup owns the temporary Gateway, so its cleanup must finish before
      // the in-process TUI fallback is allowed to terminate the process.
      scheduleProcessExitAfterTuiReturn();
      launchedTui = true;
    }

    return { launchedTui };
  } finally {
    if (sessionGateway) {
      await closeSessionGatewayForOnboarding({
        sessionGateway,
        runtime,
        reason: "onboarding finalize exited",
      });
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
