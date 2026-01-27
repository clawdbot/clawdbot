import { buildNodeInstallPlan } from "../../commands/node-daemon-install-helpers.js";
import {
  DEFAULT_NODE_DAEMON_RUNTIME,
  isNodeDaemonRuntime,
} from "../../commands/node-daemon-runtime.js";
import {
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveGatewayLogPaths } from "../../daemon/launchd.js";
import { resolveNodeService } from "../../daemon/node-service.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import { renderSystemdUnavailableHints } from "../../daemon/systemd-hints.js";
import { resolveIsNixMode } from "../../config/paths.js";
import { isWSL } from "../../infra/wsl.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatCliCommand } from "../command-format.js";
import {
  buildDaemonServiceSnapshot,
  createNullWriter,
  emitDaemonActionJson,
} from "../daemon-cli/response.js";
import { formatRuntimeStatus, parsePort } from "../daemon-cli/shared.js";

type NodeDaemonInstallOptions = {
  host?: string;
  port?: string | number;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
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
  const base = [formatCliCommand("moltbot node install"), formatCliCommand("moltbot node start")];
  switch (process.platform) {
    case "darwin":
      return [
        ...base,
        `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/${resolveNodeLaunchAgentLabel()}.plist`,
      ];
    case "linux":
      return [...base, `systemctl --user start ${resolveNodeSystemdServiceName()}.service`];
    case "win32":
      return [...base, `schtasks /Run /TN "${resolveNodeWindowsTaskName()}"`];
    default:
      return base;
  }
}

function buildNodeRuntimeHints(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === "darwin") {
    const logs = resolveGatewayLogPaths(env);
    return [
      `Launchd stdout (if installed): ${logs.stdoutPath}`,
      `Launchd stderr (if installed): ${logs.stderrPath}`,
    ];
  }
  if (process.platform === "linux") {
    const unit = resolveNodeSystemdServiceName();
    return [`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`];
  }
  if (process.platform === "win32") {
    const task = resolveNodeWindowsTaskName();
    return [`Logs: schtasks /Query /TN "${task}" /V /FO LIST`];
  }
  return [];
}

function resolveNodeDefaults(
  opts: NodeDaemonInstallOptions,
  config: Awaited<ReturnType<typeof loadNodeHostConfig>>,
) {
  const host = opts.host?.trim() || config?.gateway?.host || "127.0.0.1";
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    return { host, port: null };
  }
  const port = portOverride ?? config?.gateway?.port ?? 18789;
  return { host, port };
}

export async function runNodeDaemonInstall(opts: NodeDaemonInstallOptions) {
  const json = Boolean(opts.json);
  const warnings: string[] = [];
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
    hints?: string[];
    warnings?: string[];
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "install", ...payload });
  };
  const fail = (message: string, hints?: string[]) => {
    if (json) {
      emit({
        ok: false,
        error: message,
        hints,
        warnings: warnings.length ? warnings : undefined,
      });
    } else {
      defaultRuntime.error(message);
      if (hints?.length) {
        for (const hint of hints) defaultRuntime.log(`Tip: ${hint}`);
      }
    }
    defaultRuntime.exit(1);
  };

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service install is disabled.");
    return;
  }

  const config = await loadNodeHostConfig();
  const { host, port } = resolveNodeDefaults(opts, config);
  if (!Number.isFinite(port ?? NaN) || (port ?? 0) <= 0) {
    fail("Invalid port");
    return;
  }

  const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_NODE_DAEMON_RUNTIME;
  if (!isNodeDaemonRuntime(runtimeRaw)) {
    fail('Invalid --runtime (use "node" or "bun")');
    return;
  }

  const service = resolveNodeService();
  let loaded = false;
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
      defaultRuntime.log(`Reinstall with: ${formatCliCommand("moltbot node install --force")}`);
    }
    return;
  }

  const tlsFingerprint = opts.tlsFingerprint?.trim() || config?.gateway?.tlsFingerprint;
  const tls = Boolean(opts.tls) || Boolean(tlsFingerprint) || Boolean(config?.gateway?.tls);
  const { programArguments, workingDirectory, environment, description } =
    await buildNodeInstallPlan({
      env: process.env,
      host,
      port: port ?? 18789,
      tls,
      tlsFingerprint: tlsFingerprint || undefined,
      nodeId: opts.nodeId,
      displayName: opts.displayName,
      runtime: runtimeRaw,
      warn: (message) => {
        if (json) warnings.push(message);
        else defaultRuntime.log(message);
      },
    });

  try {
    await service.install({
      env: process.env,
      stdout,
      programArguments,
      workingDirectory,
      environment,
      description,
    });
  } catch (err) {
    fail(`Node install failed: ${String(err)}`);
    return;
  }

  let installed = true;
  try {
    installed = await service.isLoaded({ env: process.env });
  } catch {
    installed = true;
  }
  emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(service, installed),
    warnings: warnings.length ? warnings : undefined,
  });
}

export async function runNodeDaemonUninstall(opts: NodeDaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "uninstall", ...payload });
  };
  const fail = (message: string) => {
    if (json) emit({ ok: false, error: message });
    else defaultRuntime.error(message);
    defaultRuntime.exit(1);
  };

  if (resolveIsNixMode(process.env)) {
    fail("Nix mode detected; service uninstall is disabled.");
    return;
  }

  const service = resolveNodeService();
  try {
    await service.uninstall({ env: process.env, stdout });
  } catch (err) {
    fail(`Node uninstall failed: ${String(err)}`);
    return;
  }

  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  emit({
    ok: true,
    result: "uninstalled",
    service: buildDaemonServiceSnapshot(service, loaded),
  });
}

export async function runNodeDaemonStart(opts: NodeDaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    hints?: string[];
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "start", ...payload });
  };
  const fail = (message: string, hints?: string[]) => {
    if (json) emit({ ok: false, error: message, hints });
    else defaultRuntime.error(message);
    defaultRuntime.exit(1);
  };

  const service = resolveNodeService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Node service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) {
    let hints = renderNodeServiceStartHints();
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        hints = [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
      }
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `Node service ${service.notLoadedText}.`,
      hints,
      service: buildDaemonServiceSnapshot(service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`Node service ${service.notLoadedText}.`);
      for (const hint of hints) {
        defaultRuntime.log(`Start with: ${hint}`);
      }
    }
    return;
  }
  try {
    await service.restart({ env: process.env, stdout });
  } catch (err) {
    const hints = renderNodeServiceStartHints();
    fail(`Node start failed: ${String(err)}`, hints);
    return;
  }

  let started = true;
  try {
    started = await service.isLoaded({ env: process.env });
  } catch {
    started = true;
  }
  emit({
    ok: true,
    result: "started",
    service: buildDaemonServiceSnapshot(service, started),
  });
}

export async function runNodeDaemonRestart(opts: NodeDaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    hints?: string[];
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "restart", ...payload });
  };
  const fail = (message: string, hints?: string[]) => {
    if (json) emit({ ok: false, error: message, hints });
    else defaultRuntime.error(message);
    defaultRuntime.exit(1);
  };

  const service = resolveNodeService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Node service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) {
    let hints = renderNodeServiceStartHints();
    if (process.platform === "linux") {
      const systemdAvailable = await isSystemdUserServiceAvailable().catch(() => false);
      if (!systemdAvailable) {
        hints = [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
      }
    }
    emit({
      ok: true,
      result: "not-loaded",
      message: `Node service ${service.notLoadedText}.`,
      hints,
      service: buildDaemonServiceSnapshot(service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`Node service ${service.notLoadedText}.`);
      for (const hint of hints) {
        defaultRuntime.log(`Start with: ${hint}`);
      }
    }
    return;
  }
  try {
    await service.restart({ env: process.env, stdout });
  } catch (err) {
    const hints = renderNodeServiceStartHints();
    fail(`Node restart failed: ${String(err)}`, hints);
    return;
  }

  let restarted = true;
  try {
    restarted = await service.isLoaded({ env: process.env });
  } catch {
    restarted = true;
  }
  emit({
    ok: true,
    result: "restarted",
    service: buildDaemonServiceSnapshot(service, restarted),
  });
}

export async function runNodeDaemonStop(opts: NodeDaemonLifecycleOptions = {}) {
  const json = Boolean(opts.json);
  const stdout = json ? createNullWriter() : process.stdout;
  const emit = (payload: {
    ok: boolean;
    result?: string;
    message?: string;
    error?: string;
    service?: {
      label: string;
      loaded: boolean;
      loadedText: string;
      notLoadedText: string;
    };
  }) => {
    if (!json) return;
    emitDaemonActionJson({ action: "stop", ...payload });
  };
  const fail = (message: string) => {
    if (json) emit({ ok: false, error: message });
    else defaultRuntime.error(message);
    defaultRuntime.exit(1);
  };

  const service = resolveNodeService();
  let loaded = false;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch (err) {
    fail(`Node service check failed: ${String(err)}`);
    return;
  }
  if (!loaded) {
    emit({
      ok: true,
      result: "not-loaded",
      message: `Node service ${service.notLoadedText}.`,
      service: buildDaemonServiceSnapshot(service, loaded),
    });
    if (!json) {
      defaultRuntime.log(`Node service ${service.notLoadedText}.`);
    }
    return;
  }
  try {
    await service.stop({ env: process.env, stdout });
  } catch (err) {
    fail(`Node stop failed: ${String(err)}`);
    return;
  }

  let stopped = false;
  try {
    stopped = await service.isLoaded({ env: process.env });
  } catch {
    stopped = false;
  }
  emit({
    ok: true,
    result: "stopped",
    service: buildDaemonServiceSnapshot(service, stopped),
  });
}

export async function runNodeDaemonStatus(opts: NodeDaemonStatusOptions = {}) {
  const json = Boolean(opts.json);
  const service = resolveNodeService();
  const [loaded, command, runtime] = await Promise.all([
    service.isLoaded({ env: process.env }).catch(() => false),
    service.readCommand(process.env).catch(() => null),
    service
      .readRuntime(process.env)
      .catch((err): GatewayServiceRuntime => ({ status: "unknown", detail: String(err) })),
  ]);

  const payload = {
    service: {
      ...buildDaemonServiceSnapshot(service, loaded),
      command,
      runtime,
    },
  };

  if (json) {
    defaultRuntime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const rich = isRich();
  const label = (value: string) => colorize(rich, theme.muted, value);
  const accent = (value: string) => colorize(rich, theme.accent, value);
  const infoText = (value: string) => colorize(rich, theme.info, value);
  const okText = (value: string) => colorize(rich, theme.success, value);
  const warnText = (value: string) => colorize(rich, theme.warn, value);
  const errorText = (value: string) => colorize(rich, theme.error, value);

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
    const runtimeStatus = runtime?.status ?? "unknown";
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
    CLAWDBOT_LOG_PREFIX: baseEnv.CLAWDBOT_LOG_PREFIX ?? "node",
  } as NodeJS.ProcessEnv;

  if (runtime?.missingUnit) {
    defaultRuntime.error(errorText("Service unit not found."));
    for (const hint of buildNodeRuntimeHints(hintEnv)) {
      defaultRuntime.error(errorText(hint));
    }
    return;
  }

  if (runtime?.status === "stopped") {
    defaultRuntime.error(errorText("Service is loaded but not running."));
    for (const hint of buildNodeRuntimeHints(hintEnv)) {
      defaultRuntime.error(errorText(hint));
    }
  }
}
