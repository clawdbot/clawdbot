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
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { renderSystemdUnavailableHints } from "../daemon/systemd-hints.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import {
  formatGatewayRestartHandoffDiagnostic,
  readGatewayRestartHandoffSync,
} from "../infra/restart-handoff.js";
import { isWSL } from "../infra/wsl.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
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
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";

async function maybeRepairLaunchAgentBootstrap(params: {
  env: Record<string, string | undefined>;
  title: string;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  serviceRepairExternal: boolean;
}): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  const plistExists = await launchAgentPlistExists(params.env);
  if (!plistExists) {
    return false;
  }

  const loaded = await isLaunchAgentLoaded({ env: params.env });
  if (loaded) {
    return false;
  }

  note("LaunchAgent is installed but not loaded in launchd.", `${params.title} LaunchAgent`);
  if (params.serviceRepairExternal) {
    note(EXTERNAL_SERVICE_REPAIR_NOTE, `${params.title} LaunchAgent`);
    return false;
  }

  const shouldFix = await confirmDoctorServiceRepair(params.prompter, {
    message: `Repair ${params.title} LaunchAgent bootstrap now?`,
    initialValue: true,
  });
  if (!shouldFix) {
    return false;
  }

  params.runtime.log(`Bootstrapping ${params.title} LaunchAgent...`);
  const repair = await repairLaunchAgentBootstrap({ env: params.env });
  if (!repair.ok) {
    params.runtime.error(
      `${params.title} LaunchAgent bootstrap failed: ${repair.detail ?? "unknown error"}`,
    );
    return false;
  }

  const verified = await isLaunchAgentLoaded({ env: params.env });
  if (!verified) {
    params.runtime.error(`${params.title} LaunchAgent still not loaded after repair.`);
    return false;
  }

  note(`${params.title} LaunchAgent repaired.`, `${params.title} LaunchAgent`);
  return true;
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

export async function maybeRepairGatewayDaemon(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: DoctorPrompter;
  options: DoctorOptions;
  gatewayDetailsMessage: string;
  healthOk: boolean;
}) {
  if (params.healthOk) {
    return;
  }

  const serviceRepairPolicy = resolveServiceRepairPolicy();
  const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);
  const service = resolveGatewayService();
  // systemd can throw in containers/WSL; treat as "not loaded" and fall back to hints.
  let loaded = false;
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
  if (loaded) {
    serviceRuntime = await service.readRuntime(serviceEnv).catch(() => undefined);
  }
  if (params.options.deep) {
    const handoff = readGatewayRestartHandoffSync(serviceEnv);
    if (handoff) {
      note(formatGatewayRestartHandoffDiagnostic(handoff), "Gateway");
    }
  }

  if (process.platform === "darwin" && params.cfg.gateway?.mode !== "remote") {
    const gatewayRepaired = await maybeRepairLaunchAgentBootstrap({
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
    if (gatewayRepaired) {
      loaded = await service.isLoaded({ env: process.env });
      if (loaded) {
        serviceRuntime = await service.readRuntime(process.env).catch(() => undefined);
      }
    }
  }

  if (params.cfg.gateway?.mode !== "remote") {
    const port = resolveGatewayPort(params.cfg, process.env);
    const diagnostics = await inspectPortUsage(port);
    if (diagnostics.status === "busy") {
      note(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
    } else if (loaded && serviceRuntime?.status === "running") {
      const lastError = await readLastGatewayErrorLine(process.env);
      if (lastError) {
        note(`Last gateway error: ${lastError}`, "Gateway");
      }
    }
  }

  if (!loaded) {
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

  const summary = formatGatewayRuntimeSummary(serviceRuntime);
  const hints = buildGatewayRuntimeHints(serviceRuntime, {
    platform: process.platform,
    env: process.env,
  });
  if (summary || hints.length > 0) {
    const lines: string[] = [];
    if (summary) {
      lines.push(`Runtime: ${summary}`);
    }
    lines.push(...hints);
    note(lines.join("\n"), "Gateway");
  }

  if (serviceRuntime?.status !== "running") {
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
    if (serviceRepairExternal) {
      note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
      return;
    }
    const restart = await confirmDoctorServiceRepair(
      params.prompter,
      {
        message: "Restart gateway service now?",
        initialValue: true,
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
          note("Gateway not running.", "Gateway");
          note(params.gatewayDetailsMessage, "Gateway connection");
        } else {
          params.runtime.error(formatHealthCheckFailure(err));
        }
      }
    }
  }
}
