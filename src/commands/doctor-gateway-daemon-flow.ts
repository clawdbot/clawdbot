/** Doctor gateway daemon repair flow for service install, bootstrap, restart, and port hints. */
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveGatewayPort } from "../config/config.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
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
import type { GatewayServiceLoadState } from "../daemon/service-types.js";
import {
  describeGatewayServiceRestart,
  readGatewayServiceState,
  resolveGatewayService,
} from "../daemon/service.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../daemon/systemd-unavailable.js";
import { resolveGatewayBindHost, resolveGatewayRequiredListenHosts } from "../gateway/net.js";
import { NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON } from "../infra/gateway-supervision.js";
import { formatPortDiagnostics, isExpectedGatewayListeners } from "../infra/ports-format.js";
import { inspectPortConnections, inspectPortUsage } from "../infra/ports-inspect.js";
import type { PortConnection } from "../infra/ports-types.js";
import {
  formatGatewayRestartHandoffDiagnostic,
  readGatewayRestartHandoffSync,
} from "../infra/restart-handoff.js";
import { isWSL } from "../infra/wsl.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
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
import { healthCommandNonExiting } from "./health.js";

type LaunchAgentBootstrapDoctorOutcome =
  | { status: "skipped" }
  | { status: "not-loaded" }
  | { status: "repaired" }
  | { status: "system-launchdaemon-blocked"; detail: string }
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
    return { status: "not-loaded" };
  }

  const shouldFix = await confirmDoctorServiceRepair(params.prompter, {
    message: `Repair ${params.title} LaunchAgent bootstrap now?`,
    initialValue: true,
  });
  if (!shouldFix) {
    return { status: "not-loaded" };
  }

  params.runtime.log(`Bootstrapping ${params.title} LaunchAgent...`);
  const repair = await repairLaunchAgentBootstrap({ env: params.env });
  if (!repair.ok) {
    if (
      repair.status === "system-launchdaemon-conflict" ||
      repair.status === "system-launchdaemon-unverifiable"
    ) {
      return { status: "system-launchdaemon-blocked", detail: repair.detail };
    }
    if (repair.status === "gui-session-unavailable") {
      return { status: "gui-session-unavailable", detail: repair.detail };
    }
    params.runtime.error(
      `${params.title} LaunchAgent bootstrap failed: ${repair.detail ?? "unknown error"}`,
    );
    return { status: "not-loaded" };
  }

  const verified = await isLaunchAgentLoaded({ env: params.env });
  if (!verified) {
    params.runtime.error(`${params.title} LaunchAgent still not loaded after repair.`);
    return { status: "not-loaded" };
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

async function noteGatewayServiceInspectionFailure(
  loadState: Extract<GatewayServiceLoadState, { status: "unknown" }>,
): Promise<void> {
  const lines = [`Gateway service status could not be determined: ${loadState.detail}`];
  if (process.platform === "linux") {
    const kind = classifySystemdUnavailableDetail(loadState.detail);
    if (kind) {
      lines.push(...renderSystemdUnavailableHints({ wsl: await isWSL(), kind }));
    }
  }
  lines.push(`Run ${formatCliCommand("openclaw gateway status --deep")} and retry doctor.`);
  note(lines.join("\n"), "Gateway");
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
  if (!isDefaultInstallIdentity(process.env)) {
    note(NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON, "Gateway");
    return;
  }
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
  const restartGatewayService = async () => {
    try {
      return await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      note(`Gateway service restart failed: ${detail}`, "Gateway");
      return null;
    }
  };
  const isLocalDarwinGateway =
    process.platform === "darwin" && params.cfg.gateway?.mode !== "remote";
  const serviceState = await readGatewayServiceState(service, { env: process.env });
  if (serviceState.loadState.status === "unknown") {
    await noteGatewayServiceInspectionFailure(serviceState.loadState);
    return;
  }
  let loaded = serviceState.loadState.status === "loaded";
  let serviceRuntime = serviceState.runtime;
  const serviceEnv = serviceState.env;
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
    if (gatewayRepair.status === "not-loaded") {
      return;
    }
    if (gatewayRepair.status === "system-launchdaemon-blocked") {
      note(gatewayRepair.detail, "Gateway");
      return;
    }
    if (gatewayRepair.status === "gui-session-unavailable") {
      serviceRuntime = {
        status: "unknown",
        detail: gatewayRepair.detail || serviceRuntime?.detail,
        missingGuiSession: true,
      };
    }
    if (gatewayRepair.status === "repaired") {
      const repairedState = await readGatewayServiceState(service, { env: process.env });
      if (repairedState.loadState.status === "unknown") {
        await noteGatewayServiceInspectionFailure(repairedState.loadState);
        return;
      }
      loaded = repairedState.loadState.status === "loaded";
      serviceRuntime = repairedState.runtime;
    }
  }

  if (isLocalDarwinGateway && serviceRuntime?.systemLaunchDaemon) {
    noteGatewayRuntime(serviceRuntime, process.env);
    return;
  }

  if (params.cfg.gateway?.mode !== "remote") {
    const port = resolveGatewayPort(params.cfg, process.env);
    const bindHost = await resolveGatewayBindHost(
      params.cfg.gateway?.bind ?? "loopback",
      params.cfg.gateway?.customBindHost,
    );
    const diagnostics = await inspectPortUsage(port, {
      probeHosts: resolveGatewayRequiredListenHosts(bindHost),
    });
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
        serviceRuntime?.cachedLabel ||
        serviceRuntime?.systemLaunchDaemon)
    ) {
      noteGatewayRuntime(serviceRuntime, process.env);
      return;
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
      const restartResult = await restartGatewayService();
      if (!restartResult) {
        return;
      }
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
        await healthCommandNonExiting({ json: false, timeoutMs: 10_000 }, params.runtime);
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
      const restartResult = await restartGatewayService();
      if (!restartResult) {
        return;
      }
      const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
      if (restartStatus.scheduled) {
        note(restartStatus.message, "Gateway");
        return;
      }
      await sleep(1500);
      try {
        await healthCommandNonExiting({ json: false, timeoutMs: 10_000 }, params.runtime);
      } catch (err) {
        // A trapped ExitError means healthCommand already printed its own
        // reachable-gateway diagnostic; re-formatting it would only add noise.
        if (err instanceof ExitError) {
          return;
        }
        const closedDiagnostic = formatGatewayClosedDiagnostic(err);
        if (closedDiagnostic) {
          note(closedDiagnostic, "Gateway");
          note(params.gatewayDetailsMessage, "Gateway connection");
        } else {
          params.runtime.error(formatHealthCheckFailure(err));
        }
      }
    }
  }
}
