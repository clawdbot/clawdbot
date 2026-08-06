// Node-host daemon lifecycle commands for install, status, start, stop, and restart.
import { colorize } from "../../../packages/terminal-core/src/theme.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  isGatewayDaemonRuntime,
} from "../../commands/daemon-runtime.js";
import { buildNodeInstallPlan } from "../../commands/node-daemon-install-helpers.js";
import {
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveNodeService } from "../../daemon/node-service.js";
import {
  buildPlatformRuntimeLogHints,
  buildPlatformServiceStartHints,
} from "../../daemon/runtime-hints.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  runServiceRestart,
  runServiceStart,
  runServiceStop,
  runServiceUninstall,
} from "../daemon-cli/lifecycle-core.js";
import { buildDaemonServiceSnapshot, installDaemonServiceAndEmit } from "../daemon-cli/response.js";
import {
  createCliStatusTextStyles,
  createDaemonInstallActionContext,
  failIfNixDaemonInstallMode,
  filterDaemonEnv,
  formatRuntimeStatus,
  resolveRuntimeStatusColor,
} from "../daemon-cli/shared.js";
import { formatInvalidConfigPort, formatInvalidPortOption } from "../error-format.js";
import { resolveNodeGatewayOptions } from "./gateway-options.js";

type NodeDaemonInstallOptions = {
  host?: string;
  port?: string | number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  shareInstalledApps?: boolean;
  runtime?: string;
  force?: boolean;
  json?: boolean;
};

type NodeDaemonLifecycleOptions = {
  json?: boolean;
};

type NodeDaemonStatusOptions = {
  json?: boolean;
};

function renderNodeServiceStartHints(): string[] {
  return buildPlatformServiceStartHints({
    installCommand: formatCliCommand("openclaw node install"),
    startCommand: formatCliCommand("openclaw node start"),
    launchAgentPlistPath: `~/Library/LaunchAgents/${resolveNodeLaunchAgentLabel()}.plist`,
    systemdServiceName: resolveNodeSystemdServiceName(),
    windowsTaskName: resolveNodeWindowsTaskName(),
  });
}

function buildNodeRuntimeHints(env: NodeJS.ProcessEnv = process.env): string[] {
  return buildPlatformRuntimeLogHints({
    env,
    systemdServiceName: resolveNodeSystemdServiceName(),
    windowsTaskName: resolveNodeWindowsTaskName(),
  });
}

export async function runNodeDaemonInstall(opts: NodeDaemonInstallOptions) {
  const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
  if (failIfNixDaemonInstallMode(fail)) {
    return;
  }

  const config = await loadNodeHostConfig();
  const { host, port, contextPath, tls, tlsFingerprint } = resolveNodeGatewayOptions(opts, config);
  if (!Number.isFinite(port ?? Number.NaN) || (port ?? 0) <= 0 || (port ?? 0) > 65_535) {
    fail(
      opts.port !== undefined
        ? formatInvalidPortOption("--port")
        : formatInvalidConfigPort("node.gateway.port"),
    );
    return;
  }
  if (opts.tls === false && opts.tlsFingerprint !== undefined) {
    fail("--no-tls cannot be combined with --tls-fingerprint");
    return;
  }

  const runtimeRaw = opts.runtime ? opts.runtime : DEFAULT_GATEWAY_DAEMON_RUNTIME;
  if (!isGatewayDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node"; Bun lacks the required node:sqlite API)');
    return;
  }

  const service = resolveNodeService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Node service check failed: ${String(err)}`);
    return;
  }
  if (loaded && !opts.force) {
    emit({
      ok: true,
      result: "already-installed",
      message: `Node service already ${service.loadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
      warnings: warnings.length ? warnings : undefined,
    });
    if (!json) {
      defaultRuntime.log(`Node service already ${service.loadedText}.`);
      defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw node install --force")}`);
    }
    return;
  }

  const { programArguments, workingDirectory, environment, environmentValueSources, description } =
    await buildNodeInstallPlan({
      env: process.env,
      host,
      port: port ?? 18789,
      contextPath,
      tls: Boolean(tls),
      tlsFingerprint,
      nodeId: opts.nodeId,
      displayName: opts.displayName,
      installedAppsSharing: opts.shareInstalledApps,
      runtime: runtimeRaw,
      warn: (message) => {
        if (json) {
          warnings.push(message);
        } else {
          defaultRuntime.log(message);
        }
      },
    });
  const warn = (message: string) => {
    if (json) {
      warnings.push(message);
    } else {
      defaultRuntime.log(message);
    }
  };

  await installDaemonServiceAndEmit({
    serviceNoun: "Node",
    service,
    warnings,
    emit,
    fail,
    install: async () => {
      await service.install({
        env: process.env,
        stdout,
        warn,
        programArguments,
        workingDirectory,
        environment,
        environmentValueSources,
        description,
      });
    },
  });
}

export async function runNodeDaemonUninstall(opts: NodeDaemonLifecycleOptions = {}) {
  return await runServiceUninstall({
    serviceNoun: "Node",
    service: resolveNodeService(),
    opts,
    stopBeforeUninstall: false,
    assertNotLoadedAfterUninstall: false,
  });
}

export async function runNodeDaemonStart(opts: NodeDaemonLifecycleOptions = {}) {
  return await runServiceStart({
    serviceNoun: "Node",
    service: resolveNodeService(),
    renderStartHints: renderNodeServiceStartHints,
    opts,
  });
}

export async function runNodeDaemonRestart(opts: NodeDaemonLifecycleOptions = {}) {
  await runServiceRestart({
    serviceNoun: "Node",
    service: resolveNodeService(),
    renderStartHints: renderNodeServiceStartHints,
    opts,
  });
}

export async function runNodeDaemonStop(opts: NodeDaemonLifecycleOptions = {}) {
  return await runServiceStop({
    serviceNoun: "Node",
    service: resolveNodeService(),
    opts,
  });
}

export async function runNodeDaemonStatus(opts: NodeDaemonStatusOptions = {}) {
  const json = Boolean(opts.json);
  const service = resolveNodeService();
  let loaded: boolean;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (error) {
    const message = `Node service check failed: ${String(error)}`;
    if (json) {
      defaultRuntime.writeJson({ error: message });
    } else {
      defaultRuntime.error(message);
    }
    defaultRuntime.exit(1);
    return;
  }
  const [command, runtime] = await Promise.all([
    service.readCommand(process.env).catch(() => null),
    service
      .readRuntime(process.env)
      .catch((err: unknown): GatewayServiceRuntime => ({ status: "unknown", detail: String(err) })),
  ]);

  const payload = {
    service: {
      ...buildDaemonServiceSnapshot(service, loaded),
      command,
      runtime,
    },
  };

  if (json) {
    const safeEnvironment = filterDaemonEnv(command?.environment);
    defaultRuntime.writeJson({
      service: {
        ...payload.service,
        command: command
          ? {
              ...command,
              environment: Object.keys(safeEnvironment).length > 0 ? safeEnvironment : undefined,
            }
          : command,
      },
    });
    return;
  }

  const { rich, label, accent, infoText, okText, warnText, errorText } =
    createCliStatusTextStyles();

  const serviceStatus = loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
  defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);

  if (command?.programArguments?.length) {
    defaultRuntime.log(`${label("Command:")} ${infoText(command.programArguments.join(" "))}`);
  }
  if (command?.sourcePath) {
    defaultRuntime.log(`${label("Service file:")} ${infoText(command.sourcePath)}`);
  }
  if (command?.workingDirectory) {
    defaultRuntime.log(`${label("Working dir:")} ${infoText(command.workingDirectory)}`);
  }

  const runtimeLine = formatRuntimeStatus(runtime);
  if (runtimeLine) {
    const runtimeColor = resolveRuntimeStatusColor(runtime?.status);
    defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
  }

  if (!loaded) {
    defaultRuntime.log("");
    for (const hint of renderNodeServiceStartHints()) {
      defaultRuntime.log(`${warnText("Start with:")} ${infoText(hint)}`);
    }
    return;
  }

  const baseEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(command?.environment ?? undefined),
  };
  const hintEnv = {
    ...baseEnv,
    OPENCLAW_LOG_PREFIX: baseEnv.OPENCLAW_LOG_PREFIX ?? "node",
  } as NodeJS.ProcessEnv;

  if (runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of buildNodeRuntimeHints(hintEnv)) {
      defaultRuntime.log(errorText(hint));
    }
    return;
  }

  if (runtime?.status === "stopped") {
    defaultRuntime.error(errorText("Service is loaded but not running."));
    for (const hint of buildNodeRuntimeHints(hintEnv)) {
      defaultRuntime.log(errorText(hint));
    }
  }
}
