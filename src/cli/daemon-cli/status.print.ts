// Human and JSON rendering for gathered daemon status diagnostics.
import { colorize } from "../../../packages/terminal-core/src/theme.js";
import { formatConfigIssueLine } from "../../config/issue-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../../daemon/constants.js";
import { formatGatewayHeapLimitReport } from "../../daemon/gateway-heap.js";
import { renderGatewayServiceCleanupHints } from "../../daemon/inspect.js";
import {
  resolveGatewayRestartLogPath,
  resolveGatewaySupervisorLogPaths,
} from "../../daemon/restart-logs.js";
import { buildGatewayRuntimeRecoveryHints } from "../../daemon/runtime-hints.js";
import { isSystemdStartLimitHit } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../../daemon/systemd-unavailable.js";
import { resolveControlUiLinks } from "../../gateway/control-ui-links.js";
import { formatGatewayRestartHandoffDiagnostic } from "../../infra/restart-handoff.js";
import { isWSLEnv } from "../../infra/wsl.js";
import { resolvePluginVersionDriftUpdateCommand } from "../../plugins/plugin-version-drift.js";
import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { formatCliCommand } from "../command-format.js";
import {
  createCliStatusTextStyles,
  filterDaemonEnv,
  formatRuntimeStatus,
  resolveDaemonInstallBlockMessage,
  resolveRuntimeStatusColor,
  safeDaemonEnv,
} from "./shared.js";
import {
  type DaemonStatus,
  renderPortDiagnosticsForCli,
  resolvePortListeningAddresses,
} from "./status.gather.js";

function sanitizeDaemonStatusForJson(status: DaemonStatus): DaemonStatus {
  // JSON output can be copied into issues; redact service env before serialization.
  const command = status.service.command;
  if (!command) {
    return status;
  }
  const safeEnv = filterDaemonEnv(command.environment);
  const nextCommand: GatewayServiceCommandConfig = {
    ...command,
    environment: Object.keys(safeEnv).length > 0 ? safeEnv : undefined,
  };
  delete nextCommand.managedDefinition;
  delete nextCommand.managedOverrides;
  delete nextCommand.definitionPaths;
  return {
    ...status,
    service: {
      ...status.service,
      command: nextCommand,
    },
  };
}

function formatProbeKindLabel(kind?: "connect" | "read") {
  return kind === "read" ? "Read probe:" : "Connectivity probe:";
}

function formatCapabilityLabel(capability?: string) {
  if (!capability) {
    return null;
  }
  return capability.replaceAll("_", "-");
}

function formatCliVersionLine(cli: DaemonStatus["cli"]): string | null {
  if (!cli) {
    return null;
  }
  return cli.entrypoint ? `${cli.version} (${shortenHomePath(cli.entrypoint)})` : cli.version;
}

function formatConnectionLine(
  connection: NonNullable<DaemonStatus["connections"]>["established"][number],
) {
  const pid = connection.pid ? `pid=${connection.pid}` : "pid=?";
  const ppid = connection.ppid ? ` ppid=${connection.ppid}` : "";
  const direction = ` ${connection.direction}`;
  const command = connection.command ? ` ${connection.command}` : "";
  const address = connection.address ? ` ${connection.address}` : "";
  const commandLine = connection.commandLine
    ? ` cmd=${shortenHomePath(connection.commandLine)}`
    : "";
  return `${pid}${ppid}${direction}${command}${address}${commandLine}`;
}

export function printDaemonStatus(status: DaemonStatus, opts: { json: boolean; deep?: boolean }) {
  if (opts.json) {
    const sanitized = sanitizeDaemonStatusForJson(status);
    defaultRuntime.writeJson(sanitized);
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();
  const spacer = () => defaultRuntime.log("");
  // Advice belongs to this shell, not the stored service environment or probe target.
  const installBlock = resolveDaemonInstallBlockMessage("gateway");
  const installCommand = formatCliCommand("openclaw gateway install");
  const reinstallCommand = formatCliCommand("openclaw gateway install --force");

  const { service, rpc, extraServices } = status;
  const serviceTargetsProbe = service.targetRole !== "diagnostic-only";
  const serviceLoaded = service.loadState.status === "loaded";
  const serviceStatus = serviceLoaded
    ? okText(service.loadedText)
    : warnText(service.loadState.status === "not-loaded" ? service.notLoadedText : "unknown");
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
  if (status.logFile) {
    defaultRuntime.log(`${label("File logs:")} ${infoText(shortenHomePath(status.logFile))}`);
  }
  if (service.command?.programArguments?.length) {
    defaultRuntime.log(
      `${label("Command:")} ${infoText(service.command.programArguments.join(" "))}`,
    );
  }
  if (service.command?.sourcePath) {
    defaultRuntime.log(
      `${label("Service file:")} ${infoText(shortenHomePath(service.command.sourcePath))}`,
    );
  }
  if (service.command?.reloadPending) {
    defaultRuntime.log(warnText("Systemd reload: pending (run systemctl --user daemon-reload)"));
  }
  if (service.command?.workingDirectory) {
    defaultRuntime.log(
      `${label("Working dir:")} ${infoText(shortenHomePath(service.command.workingDirectory))}`,
    );
  }
  const daemonEnvLines = safeDaemonEnv(service.command?.environment);
  if (daemonEnvLines.length > 0) {
    defaultRuntime.log(`${label("Service env:")} ${daemonEnvLines.join(" ")}`);
  }
  if (service.gatewayHeap) {
    defaultRuntime.log(
      `${label("Gateway heap:")} ${infoText(formatGatewayHeapLimitReport(service.gatewayHeap))}`,
    );
  }
  const hostDesktop = status.hostDesktop ?? {
    enabled: false,
    state: "disabled" as const,
    port: 5900,
  };
  const hostDesktopValue =
    hostDesktop.state === "disabled"
      ? "disabled"
      : hostDesktop.state === "managed"
        ? hostDesktop.managedState === "running"
          ? `managed · running · display :${hostDesktop.display} · 127.0.0.1:${hostDesktop.port} · security VncAuth`
          : hostDesktop.managedState === "failed"
            ? `managed · failed: ${hostDesktop.error}`
            : hostDesktop.managedState === "unknown"
              ? "managed · runtime state unavailable"
              : `managed · ${hostDesktop.managedState === "not-started" ? "not started" : "starting"}`
        : `${hostDesktop.state} · 127.0.0.1:${hostDesktop.port}${hostDesktop.security ? ` · security ${hostDesktop.security}` : ""}`;
  defaultRuntime.log(`${label("Host desktop:")} ${infoText(hostDesktopValue)}`);
  spacer();

  if (service.configAudit?.issues.length) {
    defaultRuntime.error(warnText("Service config looks out of date or non-standard."));
    for (const issue of service.configAudit.issues) {
      const detail = issue.detail ? ` (${issue.detail})` : "";
      defaultRuntime.error(`${warnText("Service config issue:")} ${issue.message}${detail}`);
    }
    const recommendation =
      installBlock ??
      `Recommendation: run "${formatCliCommand("openclaw doctor")}" interactively for guided checks, or reinstall with "${reinstallCommand}".`;
    defaultRuntime.error(warnText(recommendation));
  }

  if (status.config) {
    const cliCfg = `${shortenHomePath(status.config.cli.path)}${status.config.cli.exists ? "" : " (missing)"}${status.config.cli.valid ? "" : " (invalid)"}`;
    defaultRuntime.log(`${label("Config (cli):")} ${infoText(cliCfg)}`);
    if (!status.config.cli.valid && status.config.cli.issues?.length) {
      for (const issue of status.config.cli.issues.slice(0, 5)) {
        defaultRuntime.error(
          `${errorText("Config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`,
        );
      }
    }
    if (status.config.cli.warnings?.length) {
      defaultRuntime.error(warnText("Config warnings:"));
      for (const warning of status.config.cli.warnings.slice(0, 5)) {
        defaultRuntime.error(
          warnText(formatConfigIssueLine(warning, "-", { normalizeRoot: true })),
        );
      }
    }
    if (status.config.daemon) {
      const daemonCfg = `${shortenHomePath(status.config.daemon.path)}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
      defaultRuntime.log(`${label("Config (service):")} ${infoText(daemonCfg)}`);
      if (!status.config.daemon.valid && status.config.daemon.issues?.length) {
        for (const issue of status.config.daemon.issues.slice(0, 5)) {
          defaultRuntime.error(
            `${errorText("Service config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`,
          );
        }
      }
      if (status.config.daemon !== status.config.cli && status.config.daemon.warnings?.length) {
        const warningsLabel =
          status.config.daemon.path === status.config.cli.path
            ? "Config warnings:"
            : "Service config warnings:";
        defaultRuntime.error(warnText(warningsLabel));
        for (const warning of status.config.daemon.warnings.slice(0, 5)) {
          defaultRuntime.error(
            warnText(formatConfigIssueLine(warning, "-", { normalizeRoot: true })),
          );
        }
      }
    }
    if (status.config.mismatch) {
      defaultRuntime.error(
        errorText(
          "Root cause: CLI and service are using different config paths (likely a profile/state-dir mismatch).",
        ),
      );
      const recovery =
        installBlock ??
        `Fix: rerun \`${reinstallCommand}\` from the same --profile / OPENCLAW_STATE_DIR you expect.`;
      defaultRuntime.error(errorText(recovery));
    }
    spacer();
  }

  if (status.gateway) {
    const bindHost = status.gateway.bindHost ?? "n/a";
    defaultRuntime.log(
      `${label("Gateway:")} bind=${infoText(status.gateway.bindMode)} (${infoText(bindHost)}), port=${infoText(String(status.gateway.port))} (${infoText(status.gateway.portSource)})`,
    );
    defaultRuntime.log(`${label("Probe target:")} ${infoText(status.gateway.probeUrl)}`);
    const controlUiEnabled = status.config?.daemon?.controlUi?.enabled ?? true;
    if (!controlUiEnabled) {
      defaultRuntime.log(`${label("Dashboard:")} ${warnText("disabled")}`);
    } else {
      const links =
        status.gateway.controlUiLinks ??
        resolveControlUiLinks({
          port: status.gateway.port,
          bind: status.gateway.bindMode,
          customBindHost: status.gateway.customBindHost,
          basePath: status.config?.daemon?.controlUi?.basePath,
          tlsEnabled: status.gateway.tlsEnabled === true,
        });
      defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
    }
    if (status.gateway.probeNote) {
      defaultRuntime.log(`${label("Probe note:")} ${infoText(status.gateway.probeNote)}`);
    }
    if (status.gateway.windowsFirewall?.severity === "warning") {
      defaultRuntime.error(warnText(`Windows firewall: ${status.gateway.windowsFirewall.message}`));
      for (const detail of status.gateway.windowsFirewall.details) {
        defaultRuntime.error(warnText(`  ${detail}`));
      }
    }
    spacer();
  }

  const gatewayVersion = rpc?.server?.version?.trim() || status.gateway?.version?.trim();
  const cliVersionLine = formatCliVersionLine(status.cli);
  if (gatewayVersion) {
    if (cliVersionLine) {
      defaultRuntime.log(`${label("CLI version:")} ${infoText(cliVersionLine)}`);
    }
    defaultRuntime.log(`${label("Gateway version:")} ${infoText(gatewayVersion)}`);
    if (status.cli?.version && status.cli.version !== gatewayVersion) {
      defaultRuntime.error(
        warnText(
          `Warning: this OpenClaw command is version ${status.cli.version}, but the running Gateway is version ${gatewayVersion}.`,
        ),
      );
      defaultRuntime.error(
        warnText(
          "Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`; if this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install.",
        ),
      );
    }
    spacer();
  }

  const runtimeLine = formatRuntimeStatus(service.runtime);
  if (runtimeLine) {
    const runtimeColor = resolveRuntimeStatusColor(service.runtime?.status);
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }
  if (service.restartHandoff) {
    defaultRuntime.log(infoText(formatGatewayRestartHandoffDiagnostic(service.restartHandoff)));
  }

  if (
    rpc &&
    !rpc.ok &&
    serviceTargetsProbe &&
    serviceLoaded &&
    service.runtime?.status === "running"
  ) {
    // The RPC probe failed while the service is loaded and running. Only the case where
    // the gateway process is up and owns the listening port (health.healthy === true with
    // no stale gateway PIDs, deep status only) is an unambiguous "not warm-up" signal, so it
    // gets recovery guidance. `healthy` can also be set from bare reachability after
    // ownership failed (see restart-health.ts), which can coexist with a non-empty
    // staleGatewayPids; treat that combination as ambiguous rather than owns-port so it
    // doesn't contradict the dedicated stale-PID diagnostic below. Every other
    // health.healthy === false sub-case — a just-started gateway that has not bound the port
    // yet, a foreign process holding the port, or a stale gateway PID — is either a normal
    // warm-up window or is already covered by the dedicated stale-PID / port-not-listening /
    // port-conflict diagnostics below, so it keeps the warm-up hint (as does unknown health
    // from shallow status). A wedged gateway that owns the port is reported as healthy ===
    // true with no stale gateway PIDs, so it is steered by the first branch.
    if (status.health?.healthy === true && status.health.staleGatewayPids.length === 0) {
      defaultRuntime.log(
        warnText(
          "Gateway process is running and owns the gateway port, so this is not a warm-up delay. Check the probe credentials/config, or restart the gateway and inspect its logs if it stays unresponsive.",
        ),
      );
    } else {
      defaultRuntime.log(
        warnText("Warm-up: launch agents can take a few seconds. Try again shortly."),
      );
    }
  }
  if (rpc) {
    const probeLabel = formatProbeKindLabel(rpc.kind);
    if (rpc.ok) {
      defaultRuntime.log(`${label(probeLabel)} ${okText("ok")}`);
    } else {
      defaultRuntime.error(`${label(probeLabel)} ${errorText("failed")}`);
      if (rpc.authWarning) {
        defaultRuntime.error(`${label("Probe auth:")} ${warnText(rpc.authWarning)}`);
      }
      if (rpc.url) {
        defaultRuntime.error(`${label("Probe target:")} ${rpc.url}`);
      }
      const lines = (rpc.error ?? "unknown").split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(0, 12)) {
        defaultRuntime.error(`  ${errorText(line)}`);
      }
      if (status.port?.status === "busy" && status.lastError) {
        defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
      }
    }
    const capability = formatCapabilityLabel(rpc.capability);
    if (capability) {
      defaultRuntime.log(`${label("Capability:")} ${infoText(capability)}`);
    }
    spacer();
  }

  if (
    status.health &&
    status.health.staleGatewayPids.length > 0 &&
    service.runtime?.status === "running" &&
    typeof service.runtime.pid === "number"
  ) {
    defaultRuntime.error(
      errorText(
        `Gateway runtime PID does not own the listening port. Other gateway process(es) are listening: ${status.health.staleGatewayPids.join(", ")}`,
      ),
    );
    defaultRuntime.error(
      errorText(
        `Fix: run ${formatCliCommand("openclaw gateway restart")} and re-check with ${formatCliCommand("openclaw gateway status --deep")}.`,
      ),
    );
    spacer();
  }

  if (status.connections?.established.length) {
    defaultRuntime.log(
      `${label("Established clients:")} ${infoText(String(status.connections.established.length))}`,
    );
    for (const connection of status.connections.established.slice(0, 8)) {
      defaultRuntime.log(`  ${infoText(formatConnectionLine(connection))}`);
    }
    if (status.connections.established.length > 8) {
      defaultRuntime.log(
        `  ${infoText(`... ${status.connections.established.length - 8} more connection(s)`)}`,
      );
    }
    defaultRuntime.log(
      warnText(
        "If logs show protocol mismatch after rollback, stop stale OpenClaw client processes listed here and re-run gateway status.",
      ),
    );
    spacer();
  }

  const serviceInspectionDetail =
    service.loadState.status === "unknown" ? service.loadState.detail : undefined;
  if (serviceInspectionDetail) {
    defaultRuntime.error(errorText(`Service inspection failed: ${serviceInspectionDetail}`));
    defaultRuntime.error(errorText(`Retry: ${formatCliCommand("openclaw gateway status --deep")}`));
    spacer();
  }
  const systemdUnavailableDetail =
    serviceInspectionDetail ??
    service.runtime?.inspectionFailure?.detail ??
    service.runtime?.detail;
  const systemdUnavailable =
    process.platform === "linux" &&
    (serviceInspectionDetail !== undefined || rpc?.ok !== true) &&
    isSystemdUnavailableDetail(systemdUnavailableDetail);
  if (systemdUnavailable) {
    const serviceEnv = service.command?.environment ?? process.env;
    defaultRuntime.error(errorText("systemd user services unavailable."));
    for (const hint of renderSystemdUnavailableHints({
      wsl: isWSLEnv(serviceEnv),
      kind: classifySystemdUnavailableDetail(systemdUnavailableDetail),
      env: serviceEnv,
    })) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }

  if (service.runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    const recovery = installBlock ?? `Run: ${installCommand}`;
    defaultRuntime.error(errorText(recovery));
  } else if (
    service.runtime?.missingGuiSession ||
    (serviceLoaded && service.runtime?.status === "stopped")
  ) {
    const missingGuiSession = service.runtime.missingGuiSession;
    const startLimitHit = process.platform === "linux" && isSystemdStartLimitHit(service.runtime);
    defaultRuntime.error(
      errorText(
        missingGuiSession
          ? "LaunchAgent plist exists, but macOS has no usable GUI session for this user."
          : startLimitHit
            ? // systemd gave up restarting after repeated crashes; sending the operator
              // to restart (which now clears the failed latch) beats "exited immediately".
              `systemd stopped restarting the gateway after repeated crashes; run ${formatCliCommand(
                "openclaw gateway restart",
              )} or inspect logs.`
            : "Service is loaded but not running (likely exited immediately).",
      ),
    );
    const env = service.command?.environment ?? process.env;
    for (const hint of buildGatewayRuntimeRecoveryHints({
      kind: missingGuiSession ? "gui-session" : "stopped",
      restartCommand: formatCliCommand("openclaw gateway restart", env),
      env,
      logFile: status.logFile,
    })) {
      defaultRuntime.error(errorText(hint));
    }
    if (!missingGuiSession) {
      spacer();
    }
  }

  if (service.runtime?.cachedLabel) {
    const env = service.command?.environment ?? process.env;
    const labelValue = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    const recovery =
      installBlock ??
      `Clear with: launchctl bootout gui/$UID/${labelValue}\nThen reinstall: ${installCommand}`;
    defaultRuntime.error(errorText(`LaunchAgent label cached but plist missing. ${recovery}`));
    spacer();
  }

  if (service.staleUpdateLaunchdJobs?.length) {
    defaultRuntime.error(errorText("Stale OpenClaw updater launchd job(s) detected."));
    for (const job of service.staleUpdateLaunchdJobs) {
      const exitStatus =
        job.lastExitStatus !== undefined ? `, last exit ${job.lastExitStatus}` : "";
      const pid = job.pid !== undefined ? `, pid ${job.pid}` : "";
      defaultRuntime.error(errorText(`- ${job.label}${pid}${exitStatus}`));
    }
    defaultRuntime.error(
      errorText(
        `Fix after confirming no update is running: launchctl remove <label>, then run ${formatCliCommand("openclaw gateway restart")}.`,
      ),
    );
    spacer();
  }

  for (const line of renderPortDiagnosticsForCli(status, rpc?.ok)) {
    defaultRuntime.error(errorText(line));
  }

  if (status.port) {
    const addrs = resolvePortListeningAddresses(status);
    if (addrs.length > 0) {
      defaultRuntime.log(`${label("Listening:")} ${infoText(addrs.join(", "))}`);
    }
  }

  if (status.portCli && status.portCli.port !== status.port?.port) {
    defaultRuntime.log(
      `${label("Note:")} CLI config resolves gateway port=${status.portCli.port} (${status.portCli.status}).`,
    );
  }

  if (
    serviceTargetsProbe &&
    serviceLoaded &&
    service.runtime?.status === "running" &&
    status.port &&
    status.port.status === "free"
  ) {
    defaultRuntime.error(
      errorText(`Gateway port ${status.port.port} is not listening (service appears running).`),
    );
    const serviceEnv = { ...process.env, ...service.command?.environment };
    if (status.lastError) {
      defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
    }
    if (process.platform === "linux") {
      const unit = resolveGatewaySystemdServiceName(serviceEnv.OPENCLAW_PROFILE);
      defaultRuntime.error(
        errorText(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`),
      );
    } else if (process.platform === "darwin") {
      const logs = resolveGatewaySupervisorLogPaths(serviceEnv, { platform: "darwin" });
      defaultRuntime.error(`${errorText("Logs:")} ${shortenHomePath(logs.stdoutPath)}`);
      defaultRuntime.error(`${errorText("Errors:")} suppressed`);
    }
    defaultRuntime.error(
      `${errorText("Restart log:")} ${shortenHomePath(resolveGatewayRestartLogPath(serviceEnv))}`,
    );
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.log(warnText("Other gateway-like services detected (best effort):"));
    for (const svc of extraServices) {
      defaultRuntime.log(`- ${warnText(svc.label)} (${svc.scope}, ${svc.detail})`);
    }
    for (const hint of renderGatewayServiceCleanupHints(extraServices)) {
      defaultRuntime.log(`${infoText("Cleanup hint:")} ${hint}`);
    }
    spacer();
  }

  const drift = status.pluginVersionDrift;
  if (drift && drift.drifts.length > 0) {
    defaultRuntime.log(
      warnText(
        `Plugin version drift: ${drift.drifts.length} active official plugin${
          drift.drifts.length === 1 ? "" : "s"
        } not on gateway ${drift.gatewayVersion}`,
      ),
    );
    if (opts.deep) {
      for (const entry of drift.drifts) {
        const sourceLabel = entry.source === "clawhub" ? "clawhub" : "npm";
        const resolvedTarget =
          entry.targetResolution?.status === "resolved"
            ? `; npm target ${entry.targetResolution.packageName}@${entry.targetResolution.version}`
            : "";
        defaultRuntime.log(
          `- ${warnText(entry.pluginId)}: ${entry.installedVersion} (${sourceLabel}) → expected ${drift.gatewayVersion}${resolvedTarget}`,
        );
      }
      const repairs = drift.drifts.map((entry) => ({
        entry,
        command: resolvePluginVersionDriftUpdateCommand(entry),
      }));
      const updateCommands = repairs
        .map(({ command }) => command)
        .filter((command): command is string => Boolean(command))
        .map((command) => formatCliCommand(command));
      const unresolvedRepairs = repairs.filter(({ command }) => !command);
      if (unresolvedRepairs.length > 0) {
        defaultRuntime.error(errorText("Plugin repair target resolution failed:"));
        for (const { entry } of unresolvedRepairs) {
          const targetResolution = entry.targetResolution;
          const detail =
            targetResolution?.status === "unresolved"
              ? targetResolution.error
              : "npm registry target was not resolved";
          defaultRuntime.error(`- ${entry.pluginId}: ${detail}`);
        }
        defaultRuntime.error(
          errorText(
            "No install command was generated for unresolved plugin targets. Retry gateway status --deep after checking registry availability.",
          ),
        );
      }
      if (updateCommands.length === 1 && unresolvedRepairs.length === 0) {
        defaultRuntime.log(
          `${label("Fix:")} ${updateCommands[0]} && ${formatCliCommand("openclaw gateway restart")}.`,
        );
      } else if (updateCommands.length > 0) {
        defaultRuntime.log(`${label("Fix:")} update each drifted plugin:`);
        for (const command of updateCommands) {
          defaultRuntime.log(`- ${command}`);
        }
        if (unresolvedRepairs.length === 0) {
          defaultRuntime.log(`Then run ${formatCliCommand("openclaw gateway restart")}.`);
        }
      }
    } else {
      defaultRuntime.log(
        infoText(
          `Run ${formatCliCommand("openclaw gateway status --deep")} for affected plugin ids and fix commands.`,
        ),
      );
    }
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.log(
      infoText(
        "Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    defaultRuntime.log(
      infoText(
        "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    spacer();
  }

  defaultRuntime.log(`${label("Troubles:")} run ${formatCliCommand("openclaw status")}`);
  defaultRuntime.log(`${label("Troubleshooting:")} https://docs.openclaw.ai/troubleshooting`);
}
