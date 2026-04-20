import { formatConfigIssueLine } from "../../config/issue-format.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../../daemon/constants.js";
import { renderGatewayServiceCleanupHints } from "../../daemon/inspect.js";
import { resolveGatewayLogPaths, resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../../daemon/systemd-unavailable.js";
import { resolveControlUiLinks } from "../../gateway/control-ui-links.js";
import { isWSLEnv } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
import { formatCliCommand } from "../command-format.js";
import {
  createCliStatusTextStyles,
  filterDaemonEnv,
  formatRuntimeStatus,
  resolveDaemonContainerContext,
  resolveRuntimeStatusColor,
  renderRuntimeHints,
  safeDaemonEnv,
} from "./shared.js";
import {
  type DaemonStatus,
  renderPortDiagnosticsForCli,
  resolvePortListeningAddresses,
} from "./status.gather.js";

function sanitizeDaemonStatusForJson(status: DaemonStatus): DaemonStatus {
  const command = status.service.command;
  if (!command?.environment) {
    return status;
  }
  const safeEnv = filterDaemonEnv(command.environment);
  const nextCommand = {
    ...command,
    environment: Object.keys(safeEnv).length > 0 ? safeEnv : undefined,
  };
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

export function printDaemonStatus(status: DaemonStatus, opts: { json: boolean }) {
  if (opts.json) {
    const sanitized = sanitizeDaemonStatusForJson(status);
    defaultRuntime.writeJson(sanitized);
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();
  const spacer = () => defaultRuntime.log("");

  const { service, rpc, extraServices } = status;
  const serviceStatus = service.loaded
    ? okText(service.loadedText)
    : warnText(service.notLoadedText);
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
  if (service.command?.workingDirectory) {
    defaultRuntime.log(
      `${label("Working dir:")} ${infoText(shortenHomePath(service.command.workingDirectory))}`,
    );
  }
  const daemonEnvLines = safeDaemonEnv(service.command?.environment);
  if (daemonEnvLines.length > 0) {
    defaultRuntime.log(`${label("Service env:")} ${daemonEnvLines.join(" ")}`);
  }
  spacer();

  if (service.configAudit?.issues.length) {
    defaultRuntime.error(warnText("Service config looks out of date or non-standard."));
    for (const issue of service.configAudit.issues) {
      const detail = issue.detail ? ` (${issue.detail})` : "";
      defaultRuntime.error(`${warnText("Service config issue:")} ${issue.message}${detail}`);
    }
    defaultRuntime.error(
      warnText(
        `Recommendation: run "${formatCliCommand("openclaw doctor")}" (or "${formatCliCommand("openclaw doctor --repair")}").`,
      ),
    );
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
    }
    if (status.config.mismatch) {
      defaultRuntime.error(
        errorText(
          "Root cause: CLI and service are using different config paths (likely a profile/state-dir mismatch).",
        ),
      );
      defaultRuntime.error(
        errorText(
          `Fix: rerun \`${formatCliCommand("openclaw gateway install --force")}\` from the same --profile / OPENCLAW_STATE_DIR you expect.`,
        ),
      );
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
      const links = resolveControlUiLinks({
        port: status.gateway.port,
        bind: status.gateway.bindMode,
        customBindHost: status.gateway.customBindHost,
        basePath: status.config?.daemon?.controlUi?.basePath,
      });
      defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
    }
    if (status.gateway.probeNote) {
      defaultRuntime.log(`${label("Probe note:")} ${infoText(status.gateway.probeNote)}`);
    }
    spacer();
  }

  const runtimeLine = formatRuntimeStatus(service.runtime);
  if (runtimeLine) {
    const runtimeColor = resolveRuntimeStatusColor(service.runtime?.status);
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }

  if (rpc && !rpc.ok && service.loaded && service.runtime?.status === "running") {
    defaultRuntime.log(
      warnText("Warm-up: launch agents can take a few seconds. Try again shortly."),
    );
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

  const systemdUnavailable =
    process.platform === "linux" && isSystemdUnavailableDetail(service.runtime?.detail);
  if (systemdUnavailable) {
    const container = Boolean(
      resolveDaemonContainerContext(service.command?.environment ?? process.env),
    );
    defaultRuntime.error(errorText("systemd user services unavailable."));
    for (const hint of renderSystemdUnavailableHints({
      wsl: isWSLEnv(),
      kind: classifySystemdUnavailableDetail(service.runtime?.detail),
      container,
    })) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }

  if (service.runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of renderRuntimeHints(service.runtime, process.env, status.logFile)) {
      defaultRuntime.error(errorText(hint));
    }
  } else if (service.loaded && service.runtime?.status === "stopped") {
    defaultRuntime.error(
      errorText("Service is loaded but not running (likely exited immediately)."),
    );
    for (const hint of renderRuntimeHints(
      service.runtime,
      service.command?.environment ?? process.env,
      status.logFile,
    )) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }

  if (service.runtime?.cachedLabel) {
    const env = service.command?.environment ?? process.env;
    const labelValue = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
    defaultRuntime.error(
      errorText(
        `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${labelValue}`,
      ),
    );
    defaultRuntime.error(
      errorText(`Then reinstall: ${formatCliCommand("openclaw gateway install")}`),
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
    service.loaded &&
    service.runtime?.status === "running" &&
    status.port &&
    status.port.status !== "busy"
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
      const logs = resolveGatewayLogPaths(serviceEnv);
      defaultRuntime.error(`${errorText("Logs:")} ${shortenHomePath(logs.stdoutPath)}`);
      defaultRuntime.error(`${errorText("Errors:")} ${shortenHomePath(logs.stderrPath)}`);
    }
    defaultRuntime.error(
      `${errorText("Restart log:")} ${shortenHomePath(resolveGatewayRestartLogPath(serviceEnv))}`,
    );
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.error(errorText("Other gateway-like services detected (best effort):"));
    for (const svc of extraServices) {
      defaultRuntime.error(`- ${errorText(svc.label)} (${svc.scope}, ${svc.detail})`);
    }
    for (const hint of renderGatewayServiceCleanupHints()) {
      defaultRuntime.error(`${errorText("Cleanup hint:")} ${hint}`);
    }
    spacer();
  }

  if (extraServices.length > 0) {
    defaultRuntime.error(
      errorText(
        "Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    defaultRuntime.error(
      errorText(
        "If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    spacer();
  }

  defaultRuntime.log(`${label("Troubles:")} run ${formatCliCommand("openclaw status")}`);
  defaultRuntime.log(`${label("Troubleshooting:")} https://docs.openclaw.ai/troubleshooting`);
}
