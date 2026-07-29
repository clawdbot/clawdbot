/** Doctor gateway daemon repair flow for service install, bootstrap, restart, and port hints. */
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveGatewayPort } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveNodeLaunchAgentLabel,
} from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { findSystemGatewayServices, type ExtraGatewayService } from "../daemon/inspect.js";
import {
  isLaunchAgentLoaded,
  launchAgentPlistExists,
  repairLaunchAgentBootstrap,
} from "../daemon/launchd.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import {
  formatPortDiagnostics,
  inspectPortConnections,
  inspectPortUsage,
  isExpectedGatewayListeners,
  type PortConnection,
} from "../infra/ports.js";
import {
  formatGatewayRestartHandoffDiagnostic,
  readGatewayRestartHandoffSync,
} from "../infra/restart-handoff.js";
import { isWSL } from "../infra/wsl.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleep } from "../utils.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { buildGatewayRuntimeHints, formatGatewayRuntimeSummary } from "./doctor-format.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import {
  confirmDoctorServiceRepair,
  EXTERNAL_SERVICE_REPAIR_NOTE,
  isServiceRepairExternallyManaged,
  resolveServiceRepairPolicy,
  SERVICE_REPAIR_POLICY_ENV,
} from "./doctor-service-repair-policy.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { formatGatewayClosedDiagnostic, formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";

type LaunchAgentBootstrapDoctorOutcome =
  | { status: "skipped" }
  | { status: "repaired" }
  | { status: "gui-session-unavailable"; detail: string };

function noteGatewayRuntime(
  serviceRuntime: GatewayServiceRuntime | undefined,
  env: Record<string, string | undefined>,
): void {
  const summary = formatGatewayRuntimeSummary(serviceRuntime);
  const hints = buildGatewayRuntimeHints(serviceRuntime, {
    platform: process.platform,
    env,
  });
  if (!summary && hints.length === 0) {
    return;
  }

  const lines: string[] = [];
  if (summary) {
    lines.push(`Runtime: ${summary}`);
  }
  lines.push(...hints);
  note(lines.join("\n"), "Gateway");
}

async function maybeRepairLaunchAgentBootstrap(params: {
  env: Record<string, string | undefined>;
  title: string;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  serviceRepairExternal: boolean;
}): Promise<LaunchAgentBootstrapDoctorOutcome> {
  if (process.platform !== "darwin") {
    return { status: "skipped" };
  }

  const plistExists = await launchAgentPlistExists(params.env);
  if (!plistExists) {
    return { status: "skipped" };
  }

  const loaded = await isLaunchAgentLoaded({ env: params.env });
  if (loaded) {
    return { status: "skipped" };
  }

  note("LaunchAgent is installed but not loaded in launchd.", `${params.title} LaunchAgent`);
  if (params.serviceRepairExternal) {
    note(EXTERNAL_SERVICE_REPAIR_NOTE, `${params.title} LaunchAgent`);
    return { status: "skipped" };
  }

  const shouldFix = await confirmDoctorServiceRepair(params.prompter, {
    message: `Repair ${params.title} LaunchAgent bootstrap now?`,
    initialValue: true,
  });
  if (!shouldFix) {
    return { status: "skipped" };
  }

  params.runtime.log(`Bootstrapping ${params.title} LaunchAgent...`);
  const repair = await repairLaunchAgentBootstrap({ env: params.env });
  if (!repair.ok) {
    if (repair.status === "gui-session-unavailable") {
      return { status: "gui-session-unavailable", detail: repair.detail };
    }
    params.runtime.error(
      `${params.title} LaunchAgent bootstrap failed: ${repair.detail ?? "unknown error"}`,
    );
    return { status: "skipped" };
  }

  const verified = await isLaunchAgentLoaded({ env: params.env });
  if (!verified) {
    params.runtime.error(`${params.title} LaunchAgent still not loaded after repair.`);
    return { status: "skipped" };
  }

  note(`${params.title} LaunchAgent repaired.`, `${params.title} LaunchAgent`);
  return { status: "repaired" };
}

function renderBlockingSystemGatewayServices(services: ExtraGatewayService[]): string {
  return [
    "System-level OpenClaw gateway service detected while the user gateway service is not installed.",
    ...services.map((svc) => `- ${svc.label} (${svc.detail})`),
    "OpenClaw will not install a second user-level gateway service automatically.",
    "Run `openclaw gateway status --deep` or `openclaw doctor --deep` to inspect duplicate services.",
    `Set ${SERVICE_REPAIR_POLICY_ENV}=external if a system supervisor owns the gateway lifecycle.`,
  ].join("\n");
}

function renderEstablishedGatewayConnections(connections: PortConnection[]): string {
  return [
    "Established Gateway TCP clients detected:",
    ...connections.slice(0, 8).map((connection) => {
      const pid = connection.pid ? `pid=${connection.pid}` : "pid=?";
      const direction = connection.direction;
      const command = connection.command ? ` ${connection.command}` : "";
      const address = connection.address ? ` ${connection.address}` : "";
      const commandLine = connection.commandLine ? ` cmd=${connection.commandLine}` : "";
      return `- ${pid} ${direction}${command}${address}${commandLine}`;
    }),
    ...(connections.length > 8 ? [`- ... ${connections.length - 8} more connection(s)`] : []),
    "If logs show protocol mismatch after rollback, stop stale OpenClaw client processes listed here and rerun doctor.",
  ].join("\n");
}

async function maybeReportEstablishedGatewayClients(params: {
  cfg: OpenClawConfig;
  deep: boolean;
  port?: number;
}): Promise<void> {
  if (!params.deep || params.cfg.gateway?.mode === "remote") {
    return;
  }
  const port = params.port ?? resolveGatewayPort(params.cfg, process.env);
  const connections = await inspectPortConnections(port).catch(() => null);
  const establishedClients = connections?.connections.filter(
    (connection) => connection.direction !== "server",
  );
  if (establishedClients && establishedClients.length > 0) {
    note(renderEstablishedGatewayConnections(establishedClients), "Gateway clients");
  }
}

/**
 * Repairs or diagnoses the local gateway service after the health check fails.
 *
 * Remote gateway mode is only diagnosed; local mode may bootstrap launchd, install missing
 * services, report port conflicts, or restart unhealthy supervision when policy allows.
 */
export async function maybeRepairGatewayDaemon(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  options: DoctorOptions;
  gatewayDetailsMessage: string;
  healthOk: boolean;
  healthSkipped?: boolean;
}) {
  if (params.healthOk) {
    await maybeReportEstablishedGatewayClients({
      cfg: params.cfg,
      deep: params.options.deep ?? false,
    });
    return;
  }
  if (params.healthSkipped && params.cfg.gateway?.mode === "remote") {
    return;
  }

  const serviceRepairPolicy = resolveServiceRepairPolicy();
  const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);
  const service = resolveGatewayService();
  const isLocalDarwinGateway =
    process.platform === "darwin" && params.cfg.gateway?.mode !== "remote";
  // systemd can throw in containers/WSL; treat as "not loaded" and fall back to hints.
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  let serviceRuntime: Awaited<ReturnType<typeof service.readRuntime>> | undefined;
  const command = params.options.deep
    ? await Promise.resolve(service.readCommand(process.env)).catch(() => null)
    : null;
  const serviceEnv = command?.environment
    ? ({
        ...process.env,
        ...command.environment,
      } satisfies NodeJS.ProcessEnv)
    : process.env;
  const shouldReadRuntime = loaded || isLocalDarwinGateway;
  if (shouldReadRuntime) {
    serviceRuntime = await service.readRuntime(serviceEnv).catch(() => undefined);
  }
  if (params.options.deep) {
    const handoff = readGatewayRestartHandoffSync(serviceEnv);
    if (handoff) {
      note(formatGatewayRestartHandoffDiagnostic(handoff), "Gateway");
    }
  }

  if (isLocalDarwinGateway) {
    const gatewayRepair = serviceRuntime?.missingGuiSession
      ? ({ status: "gui-session-unavailable", detail: serviceRuntime.detail ?? "" } as const)
      : await maybeRepairLaunchAgentBootstrap({
          env: process.env,
          title: "Gateway",
          runtime: params.runtime,
          prompter: params.prompter,
          serviceRepairExternal,
        });
    await maybeRepairLaunchAgentBootstrap({
      env: {
        ...process.env,
        OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
      },
      title: "Node",
      runtime: params.runtime,
      prompter: params.prompter,
      serviceRepairExternal,
    });
    if (gatewayRepair.status === "gui-session-unavailable") {
      serviceRuntime = {
        status: "unknown",
        detail: gatewayRepair.detail || serviceRuntime?.detail,
        missingSupervision: true,
        missingGuiSession: true,
      };
    }
    if (gatewayRepair.status === "repaired") {
      loaded = await service.isLoaded({ env: process.env });
      if (loaded) {
        serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
      }
    }
  }

  if (params.cfg.gateway?.mode !== "remote") {
    const port = resolveGatewayPort(params.cfg, process.env);
    const diagnostics = await inspectPortUsage(port);
    await maybeReportEstablishedGatewayClients({
      cfg: params.cfg,
      deep: params.options.deep ?? false,
      port,
    });
    if (
      diagnostics.status === "busy" &&
      !isExpectedGatewayListeners(diagnostics.listeners, diagnostics.port)
    ) {
      note(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
    } else if (loaded && serviceRuntime?.status === "running") {
      const lastError = await readLastGatewayErrorLine(process.env);
      if (lastError) {
        note(`Last gateway error: ${lastError}`, "Gateway");
      }
    }
  }

  if (!loaded) {
    if (
      isLocalDarwinGateway &&
      (serviceRuntime?.missingGuiSession ||
        serviceRuntime?.missingSupervision ||
        serviceRuntime?.cachedLabel)
    ) {
      noteGatewayRuntime(serviceRuntime, process.env);
      return;
    }
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        const wsl = await isWSL();
        note(
          renderSystemdUnavailableHints({ wsl, kind: "generic_unavailable" }).join("\n"),
          "Gateway",
        );
        return;
      }
    }
    note("Gateway service not installed.", "Gateway");
    if (params.cfg.gateway?.mode !== "remote") {
      if (process.platform === "linux") {
        const systemGatewayServices = await findSystemGatewayServices();
        if (systemGatewayServices.length > 0) {
          note(renderBlockingSystemGatewayServices(systemGatewayServices), "Gateway");
          return;
        }
      }
      if (serviceRepairExternal) {
        note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
        return;
      }
      const install = await confirmDoctorServiceRepair(
        params.prompter,
        {
          message: "Install gateway service now?",
          initialValue: true,
          requiresInteractiveConfirmation: true,
        },
        serviceRepairPolicy,
      );
      if (!install) {
        note(
          `Run ${formatCliCommand("openclaw gateway install")} when you want to install the gateway service.`,
          "Gateway",
        );
      }
      if (install) {
        const daemonRuntime = await params.prompter.select<GatewayDaemonRuntime>(
          {
            message: "Gateway service runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          },
          DEFAULT_GATEWAY_DAEMON_RUNTIME,
        );
        const tokenResolution = await resolveGatewayInstallToken({
          config: params.cfg,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          note(warning, "Gateway");
        }
        if (tokenResolution.unavailableReason) {
          note(
            [
              "Gateway service install aborted.",
              tokenResolution.unavailableReason,
              "Fix gateway auth config/token input and rerun doctor.",
            ].join("\n"),
            "Gateway",
          );
          return;
        }
        const port = resolveGatewayPort(params.cfg, process.env);
        const { programArguments, workingDirectory, environment, environmentValueSources } =
          await buildGatewayInstallPlan({
            env: process.env,
            port,
            runtime: daemonRuntime,
            warn: (message, title) => note(message, title),
            config: params.cfg,
          });
        try {
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
            environmentValueSources,
          });
        } catch (err) {
          note(`Gateway service install failed: ${String(err)}`, "Gateway");
          note(gatewayInstallErrorHint(), "Gateway");
        }
      }
    }
    return;
  }

  noteGatewayRuntime(serviceRuntime, process.env);

  if (serviceRuntime?.status !== "running") {
    if (params.healthSkipped && serviceRuntime?.status !== "stopped") {
      return;
    }
    if (serviceRepairExternal) {
      note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
      return;
    }
    const start = await confirmDoctorServiceRepair(
      params.prompter,
      {
        message: "Start gateway service now?",
        initialValue: true,
      },
      serviceRepairPolicy,
    );
    if (start) {
      const restartResult = await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
      if (!restartStatus.scheduled) {
        await sleep(1500);
      } else {
        note(restartStatus.message, "Gateway");
      }
    }
  }

  if (process.platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
    note(
      `LaunchAgent loaded; stopping requires "${formatCliCommand("openclaw gateway stop")}" or launchctl bootout gui/$UID/${label}.`,
      "Gateway",
    );
  }

  if (serviceRuntime?.status === "running") {
    if (params.healthSkipped) {
      return;
    }
    if (serviceRepairExternal) {
      note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
      return;
    }

    // Check if the gateway was recently restarted (e.g., via SIGUSR1 after an update).
    // If a restart handoff exists and the gateway reports healthy, skip the restart prompt
    // to avoid racing with the system supervisor and causing a restart loop.
    const recentRestart = readGatewayRestartHandoffSync(serviceEnv);
    if (recentRestart) {
      try {
        await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
        note("Gateway is healthy after recent restart; skipping restart prompt.", "Gateway");
        return;
      } catch {
        // Health probe failed — fall through to the restart prompt below.
      }
    }
    if (params.options.nonInteractive === true) {
      // --fix auto-approves runtime repairs; do not let a headless doctor kill its live gateway.
      return;
    }

    const restart = await confirmDoctorServiceRepair(
      params.prompter,
      {
        message: "Restart gateway service now?",
        initialValue: false,
      },
      serviceRepairPolicy,
    );
    if (restart) {
      const restartResult = await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
      if (restartStatus.scheduled) {
        note(restartStatus.message, "Gateway");
        return;
      }
      await sleep(1500);
      try {
        await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
      } catch (err) {
        const message = String(err);
        if (message.includes("gateway closed")) {
          const closedDiagnostic = formatGatewayClosedDiagnostic(err);
          if (closedDiagnostic) {
            note(closedDiagnostic, "Gateway");
            note(params.gatewayDetailsMessage, "Gateway connection");
          } else {
            note("Gateway not running.", "Gateway");
            note(params.gatewayDetailsMessage, "Gateway connection");
          }
        } else {
          params.runtime.error(formatHealthCheckFailure(err));
        }
      }
    }
  }
}
