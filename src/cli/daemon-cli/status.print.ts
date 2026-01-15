import { resolveControlUiLinks } from "../../commands/onboard-helpers.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
} from "../../daemon/constants.js";
import { renderGatewayServiceCleanupHints } from "../../daemon/inspect.js";
import { resolveGatewayLogPaths } from "../../daemon/launchd.js";
import { getResolvedLoggerSettings } from "../../logging.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatRuntimeStatus, renderRuntimeHints, safeDaemonEnv } from "./shared.js";
import {
  type DaemonStatus,
  renderPortDiagnosticsForCli,
  resolvePortListeningAddresses,
} from "./status.gather.js";

export function printDaemonStatus(status: DaemonStatus, opts: { json: boolean }) {
  if (opts.json) {
    defaultRuntime.log(JSON.stringify(status, null, 2));
    return;
  }

  const rich = isRich();
  const label = (value: string) => colorize(rich, theme.muted, value);
  const accent = (value: string) => colorize(rich, theme.accent, value);
  const infoText = (value: string) => colorize(rich, theme.info, value);
  const okText = (value: string) => colorize(rich, theme.success, value);
  const warnText = (value: string) => colorize(rich, theme.warn, value);
  const errorText = (value: string) => colorize(rich, theme.error, value);
  const spacer = () => defaultRuntime.log("");

  const { service, rpc, legacyServices, extraServices } = status;
  const serviceStatus = service.loaded
    ? okText(service.loadedText)
    : warnText(service.notLoadedText);
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
  try {
    const logFile = getResolvedLoggerSettings().file;
    defaultRuntime.log(`${label("File logs:")} ${infoText(logFile)}`);
  } catch {
    // ignore missing config/log resolution
  }
  if (service.command?.programArguments?.length) {
    defaultRuntime.log(
      `${label("Command:")} ${infoText(service.command.programArguments.join(" "))}`,
    );
  }
  if (service.command?.sourcePath) {
    defaultRuntime.log(`${label("Service file:")} ${infoText(service.command.sourcePath)}`);
  }
  if (service.command?.workingDirectory) {
    defaultRuntime.log(`${label("Working dir:")} ${infoText(service.command.workingDirectory)}`);
  }
  const daemonEnvLines = safeDaemonEnv(service.command?.environment);
  if (daemonEnvLines.length > 0) {
    defaultRuntime.log(`${label("Daemon env:")} ${daemonEnvLines.join(" ")}`);
  }
  spacer();

  if (service.configAudit?.issues.length) {
    defaultRuntime.error(warnText("Service config looks out of date or non-standard."));
    for (const issue of service.configAudit.issues) {
      const detail = issue.detail ? ` (${issue.detail})` : "";
      defaultRuntime.error(`${warnText("Service config issue:")} ${issue.message}${detail}`);
    }
    defaultRuntime.error(
      warnText('Recommendation: run "clawdbot doctor" (or "clawdbot doctor --repair").'),
    );
  }

  if (status.config) {
    const cliCfg = `${status.config.cli.path}${status.config.cli.exists ? "" : " (missing)"}${status.config.cli.valid ? "" : " (invalid)"}`;
    defaultRuntime.log(`${label("Config (cli):")} ${infoText(cliCfg)}`);
    if (!status.config.cli.valid && status.config.cli.issues?.length) {
      for (const issue of status.config.cli.issues.slice(0, 5)) {
        defaultRuntime.error(
          `${errorText("Config issue:")} ${issue.path || "<root>"}: ${issue.message}`,
        );
      }
    }
    if (status.config.daemon) {
      const daemonCfg = `${status.config.daemon.path}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
      defaultRuntime.log(`${label("Config (daemon):")} ${infoText(daemonCfg)}`);
      if (!status.config.daemon.valid && status.config.daemon.issues?.length) {
        for (const issue of status.config.daemon.issues.slice(0, 5)) {
          defaultRuntime.error(
            `${errorText("Daemon config issue:")} ${issue.path || "<root>"}: ${issue.message}`,
          );
        }
      }
    }
    if (status.config.mismatch) {
      defaultRuntime.error(
        errorText(
          "Root cause: CLI and daemon are using different config paths (likely a profile/state-dir mismatch).",
        ),
      );
      defaultRuntime.error(
        errorText(
          "Fix: rerun `clawdbot daemon install --force` from the same --profile / CLAWDBOT_STATE_DIR you expect.",
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
    const runtimeStatus = service.runtime?.status ?? "unknown";
    const runtimeColor =
      runtimeStatus === "running"
        ? theme.success
        : runtimeStatus === "stopped"
          ? theme.error
          : runtimeStatus === "unknown"
            ? theme.muted
            : theme.warn;
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }

  if (rpc && !rpc.ok && service.loaded && service.runtime?.status === "running") {
    defaultRuntime.log(
      warnText("Warm-up: launch agents can take a few seconds. Try again shortly."),
    );
  }
  if (rpc) {
    if (rpc.ok) {
      defaultRuntime.log(`${label("RPC probe:")} ${okText("ok")}`);
    } else {
      defaultRuntime.error(`${label("RPC probe:")} ${errorText("failed")}`);
      if (rpc.url) defaultRuntime.error(`${label("RPC target:")} ${rpc.url}`);
      const lines = String(rpc.error ?? "unknown")
        .split(/\r?\n/)
        .filter(Boolean);
      for (const line of lines.slice(0, 12)) {
        defaultRuntime.error(`  ${errorText(line)}`);
      }
    }
    spacer();
  }

  if (service.runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of renderRuntimeHints(service.runtime)) {
      defaultRuntime.error(errorText(hint));
    }
  } else if (service.loaded && service.runtime?.status === "stopped") {
    defaultRuntime.error(
      errorText("Service is loaded but not running (likely exited immediately)."),
    );
    for (const hint of renderRuntimeHints(
      service.runtime,
      (service.command?.environment ?? process.env) as NodeJS.ProcessEnv,
    )) {
      defaultRuntime.error(errorText(hint));
    }
    spacer();
  }

  if (service.runtime?.cachedLabel) {
    const env = (service.command?.environment ?? process.env) as NodeJS.ProcessEnv;
    const labelValue = resolveGatewayLaunchAgentLabel(env.CLAWDBOT_PROFILE);
    defaultRuntime.error(
      errorText(
        `LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${labelValue}`,
      ),
    );
    defaultRuntime.error(errorText("Then reinstall: clawdbot daemon install"));
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
    if (status.lastError) {
      defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
    }
    if (process.platform === "linux") {
      const env = (service.command?.environment ?? process.env) as NodeJS.ProcessEnv;
      const unit = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
      defaultRuntime.error(
        errorText(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`),
      );
    } else if (process.platform === "darwin") {
      const logs = resolveGatewayLogPaths(
        (service.command?.environment ?? process.env) as NodeJS.ProcessEnv,
      );
      defaultRuntime.error(`${errorText("Logs:")} ${logs.stdoutPath}`);
      defaultRuntime.error(`${errorText("Errors:")} ${logs.stderrPath}`);
    }
    spacer();
  }

  if (legacyServices.length > 0) {
    defaultRuntime.error(errorText("Legacy gateway services detected:"));
    for (const svc of legacyServices) {
      defaultRuntime.error(`- ${errorText(svc.label)} (${svc.detail})`);
    }
    defaultRuntime.error(errorText("Cleanup: clawdbot doctor"));
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

  if (legacyServices.length > 0 || extraServices.length > 0) {
    defaultRuntime.error(
      errorText(
        "Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    defaultRuntime.error(
      errorText(
        "If you need multiple gateways (e.g., a recovery bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host).",
      ),
    );
    spacer();
  }

  defaultRuntime.log(`${label("Troubles:")} run clawdbot status`);
  defaultRuntime.log(`${label("Troubleshooting:")} https://docs.clawd.bot/troubleshooting`);
}
