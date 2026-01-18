import type { ClawdbotConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/config.js";
import { resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { isWSL } from "../infra/wsl.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { sleep } from "../utils.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
  type GatewayDaemonRuntime,
} from "./daemon-runtime.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import { buildGatewayRuntimeHints, formatGatewayRuntimeSummary } from "./doctor-format.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
import { healthCommand } from "./health.js";
import { formatHealthCheckFailure } from "./health-format.js";

export async function maybeRepairGatewayDaemon(params: {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  options: DoctorOptions;
  gatewayDetailsMessage: string;
  healthOk: boolean;
}) {
  if (params.healthOk) return;

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: process.env });
  let serviceRuntime: Awaited<ReturnType<typeof service.readRuntime>> | undefined;
  if (loaded) {
    serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
  }

  if (params.cfg.gateway?.mode !== "remote") {
    const port = resolveGatewayPort(params.cfg, process.env);
    const diagnostics = await inspectPortUsage(port);
    if (diagnostics.status === "busy") {
      note(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
    } else if (loaded && serviceRuntime?.status === "running") {
      const lastError = await readLastGatewayErrorLine(process.env);
      if (lastError) note(`Last gateway error: ${lastError}`, "Gateway");
    }
  }

  if (!loaded) {
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        const wsl = await isWSL();
        note(renderSystemdUnavailableHints({ wsl }).join("\n"), "Gateway");
        return;
      }
    }
    note("Gateway daemon not installed.", "Gateway");
    if (params.cfg.gateway?.mode !== "remote") {
      const install = await params.prompter.confirmSkipInNonInteractive({
        message: "Install gateway daemon now?",
        initialValue: true,
      });
      if (install) {
        const daemonRuntime = await params.prompter.select<GatewayDaemonRuntime>(
          {
            message: "Gateway daemon runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME,
          },
          DEFAULT_GATEWAY_DAEMON_RUNTIME,
        );
        const port = resolveGatewayPort(params.cfg, process.env);
        const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
          env: process.env,
          port,
          token: params.cfg.gateway?.auth?.token ?? process.env.CLAWDBOT_GATEWAY_TOKEN,
          runtime: daemonRuntime,
          warn: (message, title) => note(message, title),
        });
        try {
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        } catch (err) {
          note(`Gateway daemon install failed: ${String(err)}`, "Gateway");
          note(gatewayInstallErrorHint(), "Gateway");
        }
      }
    }
    return;
  }

  const summary = formatGatewayRuntimeSummary(serviceRuntime);
  const hints = buildGatewayRuntimeHints(serviceRuntime, {
    platform: process.platform,
    env: process.env,
  });
  if (summary || hints.length > 0) {
    const lines: string[] = [];
    if (summary) lines.push(`Runtime: ${summary}`);
    lines.push(...hints);
    note(lines.join("\n"), "Gateway");
  }

  if (serviceRuntime?.status !== "running") {
    const start = await params.prompter.confirmSkipInNonInteractive({
      message: "Start gateway daemon now?",
      initialValue: true,
    });
    if (start) {
      await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      await sleep(1500);
    }
  }

  if (process.platform === "darwin") {
    const label = resolveGatewayLaunchAgentLabel(process.env.CLAWDBOT_PROFILE);
    note(
      `LaunchAgent loaded; stopping requires "clawdbot daemon stop" or launchctl bootout gui/$UID/${label}.`,
      "Gateway",
    );
  }

  if (serviceRuntime?.status === "running") {
    const restart = await params.prompter.confirmSkipInNonInteractive({
      message: "Restart gateway daemon now?",
      initialValue: true,
    });
    if (restart) {
      await service.restart({
        env: process.env,
        stdout: process.stdout,
      });
      await sleep(1500);
      try {
        await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
      } catch (err) {
        const message = String(err);
        if (message.includes("gateway closed")) {
          note("Gateway not running.", "Gateway");
          note(params.gatewayDetailsMessage, "Gateway connection");
        } else {
          params.runtime.error(formatHealthCheckFailure(err));
        }
      }
    }
  }
}
