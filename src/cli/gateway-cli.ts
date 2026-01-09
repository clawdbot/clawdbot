import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { gatewayStatusCommand } from "../commands/gateway-status.js";
import { handleReset } from "../commands/onboard-helpers.js";
import {
  CONFIG_PATH_CLAWDBOT,
  type GatewayAuthMode,
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
  writeConfigFile,
} from "../config/config.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
} from "../daemon/constants.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { callGateway } from "../gateway/call.js";
import { startGatewayServer } from "../gateway/server.js";
import {
  type GatewayWsLogStyle,
  setGatewayWsLogStyle,
} from "../gateway/ws-logging.js";
import { setVerbose } from "../globals.js";
import type { GatewayBonjourBeacon } from "../infra/bonjour-discovery.js";
import { discoverGatewayBeacons } from "../infra/bonjour-discovery.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { WIDE_AREA_DISCOVERY_DOMAIN } from "../infra/widearea-dns.js";
import {
  createSubsystemLogger,
  setConsoleSubsystemFilter,
} from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { resolveUserPath } from "../utils.js";
import { forceFreePortAndWait } from "./ports.js";
import { withProgress } from "./progress.js";

type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
};

type GatewayRunOpts = {
  port?: unknown;
  bind?: unknown;
  token?: unknown;
  auth?: unknown;
  password?: unknown;
  tailscale?: unknown;
  tailscaleResetOnExit?: boolean;
  allowUnconfigured?: boolean;
  force?: boolean;
  verbose?: boolean;
  claudeCliLogs?: boolean;
  wsLog?: unknown;
  compact?: boolean;
  rawStream?: boolean;
  rawStreamPath?: unknown;
  dev?: boolean;
  reset?: boolean;
};

type GatewayRunParams = {
  legacyTokenEnv?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");
const DEV_IDENTITY_NAME = "C3-PO";
const DEV_IDENTITY_THEME = "protocol droid";
const DEV_IDENTITY_EMOJI = "🤖";
const DEV_AGENT_WORKSPACE_SUFFIX = "dev";
const DEV_TEMPLATE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../docs/reference/templates",
);

async function loadDevTemplate(
  name: string,
  fallback: string,
): Promise<string> {
  try {
    const raw = await fs.promises.readFile(
      path.join(DEV_TEMPLATE_DIR, name),
      "utf-8",
    );
    if (!raw.startsWith("---")) return raw;
    const endIndex = raw.indexOf("\n---", 3);
    if (endIndex === -1) return raw;
    return raw.slice(endIndex + "\n---".length).replace(/^\s+/, "");
  } catch {
    return fallback;
  }
}

type GatewayRunSignalAction = "stop" | "restart";

function parsePort(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const value =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "bigint"
        ? raw.toString()
        : null;
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

const toOptionString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return value.toString();
  return undefined;
};

const resolveDevWorkspaceDir = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const baseDir = resolveDefaultAgentWorkspaceDir(env, os.homedir);
  const profile = env.CLAWDBOT_PROFILE?.trim().toLowerCase();
  if (profile === "dev") return baseDir;
  return `${baseDir}-${DEV_AGENT_WORKSPACE_SUFFIX}`;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") throw err;
  }
}

async function ensureDevWorkspace(dir: string) {
  const resolvedDir = resolveUserPath(dir);
  await fs.promises.mkdir(resolvedDir, { recursive: true });

  const [agents, soul, tools, identity, user] = await Promise.all([
    loadDevTemplate(
      "AGENTS.dev.md",
      `# AGENTS.md - Clawdbot Dev Workspace\n\nDefault dev workspace for clawdbot gateway --dev.\n`,
    ),
    loadDevTemplate(
      "SOUL.dev.md",
      `# SOUL.md - Dev Persona\n\nProtocol droid for debugging and operations.\n`,
    ),
    loadDevTemplate(
      "TOOLS.dev.md",
      `# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n`,
    ),
    loadDevTemplate(
      "IDENTITY.dev.md",
      `# IDENTITY.md - Agent Identity\n\n- Name: ${DEV_IDENTITY_NAME}\n- Creature: protocol droid\n- Vibe: ${DEV_IDENTITY_THEME}\n- Emoji: ${DEV_IDENTITY_EMOJI}\n`,
    ),
    loadDevTemplate(
      "USER.dev.md",
      `# USER.md - User Profile\n\n- Name:\n- Preferred address:\n- Notes:\n`,
    ),
  ]);

  await writeFileIfMissing(path.join(resolvedDir, "AGENTS.md"), agents);
  await writeFileIfMissing(path.join(resolvedDir, "SOUL.md"), soul);
  await writeFileIfMissing(path.join(resolvedDir, "TOOLS.md"), tools);
  await writeFileIfMissing(path.join(resolvedDir, "IDENTITY.md"), identity);
  await writeFileIfMissing(path.join(resolvedDir, "USER.md"), user);
}

async function ensureDevGatewayConfig(opts: { reset?: boolean }) {
  const workspace = resolveDevWorkspaceDir();
  if (opts.reset) {
    await handleReset("full", workspace, defaultRuntime);
  }

  const configExists = fs.existsSync(CONFIG_PATH_CLAWDBOT);
  if (!opts.reset && configExists) return;

  await writeConfigFile({
    gateway: {
      mode: "local",
      bind: "loopback",
    },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
      },
      list: [
        {
          id: "dev",
          default: true,
          workspace,
          identity: {
            name: DEV_IDENTITY_NAME,
            theme: DEV_IDENTITY_THEME,
            emoji: DEV_IDENTITY_EMOJI,
          },
        },
      ],
    },
  });
  await ensureDevWorkspace(workspace);
  defaultRuntime.log(`Dev config ready: ${CONFIG_PATH_CLAWDBOT}`);
  defaultRuntime.log(`Dev workspace ready: ${resolveUserPath(workspace)}`);
}

type GatewayDiscoverOpts = {
  timeout?: string;
  json?: boolean;
};

function parseDiscoverTimeoutMs(raw: unknown, fallbackMs: number): number {
  if (raw === undefined || raw === null) return fallbackMs;
  const value =
    typeof raw === "string"
      ? raw.trim()
      : typeof raw === "number" || typeof raw === "bigint"
        ? String(raw)
        : null;
  if (value === null) {
    throw new Error("invalid --timeout");
  }
  if (!value) return fallbackMs;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid --timeout: ${value}`);
  }
  return parsed;
}

function pickBeaconHost(beacon: GatewayBonjourBeacon): string | null {
  const host = beacon.tailnetDns || beacon.lanHost || beacon.host;
  return host?.trim() ? host.trim() : null;
}

function pickGatewayPort(beacon: GatewayBonjourBeacon): number {
  const port = beacon.gatewayPort ?? 18789;
  return port > 0 ? port : 18789;
}

function dedupeBeacons(
  beacons: GatewayBonjourBeacon[],
): GatewayBonjourBeacon[] {
  const out: GatewayBonjourBeacon[] = [];
  const seen = new Set<string>();
  for (const b of beacons) {
    const host = pickBeaconHost(b) ?? "";
    const key = [
      b.domain ?? "",
      b.instanceName ?? "",
      b.displayName ?? "",
      host,
      String(b.port ?? ""),
      String(b.bridgePort ?? ""),
      String(b.gatewayPort ?? ""),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

function renderBeaconLines(
  beacon: GatewayBonjourBeacon,
  rich: boolean,
): string[] {
  const nameRaw = (
    beacon.displayName ||
    beacon.instanceName ||
    "Gateway"
  ).trim();
  const domainRaw = (beacon.domain || "local.").trim();

  const title = colorize(rich, theme.accentBright, nameRaw);
  const domain = colorize(rich, theme.muted, domainRaw);

  const host = pickBeaconHost(beacon);
  const gatewayPort = pickGatewayPort(beacon);
  const wsUrl = host ? `ws://${host}:${gatewayPort}` : null;

  const lines = [`- ${title} ${domain}`];

  if (beacon.tailnetDns) {
    lines.push(
      `  ${colorize(rich, theme.info, "tailnet")}: ${beacon.tailnetDns}`,
    );
  }
  if (beacon.lanHost) {
    lines.push(`  ${colorize(rich, theme.info, "lan")}: ${beacon.lanHost}`);
  }
  if (beacon.host) {
    lines.push(`  ${colorize(rich, theme.info, "host")}: ${beacon.host}`);
  }

  if (wsUrl) {
    lines.push(
      `  ${colorize(rich, theme.muted, "ws")}: ${colorize(rich, theme.command, wsUrl)}`,
    );
  }
  if (typeof beacon.sshPort === "number" && beacon.sshPort > 0 && host) {
    const ssh = `ssh -N -L 18789:127.0.0.1:18789 <user>@${host} -p ${beacon.sshPort}`;
    lines.push(
      `  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, ssh)}`,
    );
  }
  return lines;
}

function describeUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "bigint") return err.toString();
  if (typeof err === "boolean") return err ? "true" : "false";
  if (err && typeof err === "object") {
    if ("message" in err && typeof err.message === "string") {
      return err.message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return "Unknown error";
    }
  }
  return "Unknown error";
}

function extractGatewayMiskeys(parsed: unknown): {
  hasGatewayToken: boolean;
  hasRemoteToken: boolean;
} {
  if (!parsed || typeof parsed !== "object") {
    return { hasGatewayToken: false, hasRemoteToken: false };
  }
  const gateway = (parsed as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return { hasGatewayToken: false, hasRemoteToken: false };
  }
  const hasGatewayToken = "token" in (gateway as Record<string, unknown>);
  const remote = (gateway as Record<string, unknown>).remote;
  const hasRemoteToken =
    remote && typeof remote === "object"
      ? "token" in (remote as Record<string, unknown>)
      : false;
  return { hasGatewayToken, hasRemoteToken };
}

function renderGatewayServiceStopHints(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "Tip: clawdbot daemon stop",
        `Or: launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}`,
      ];
    case "linux":
      return [
        "Tip: clawdbot daemon stop",
        `Or: systemctl --user stop ${GATEWAY_SYSTEMD_SERVICE_NAME}.service`,
      ];
    case "win32":
      return [
        "Tip: clawdbot daemon stop",
        `Or: schtasks /End /TN "${GATEWAY_WINDOWS_TASK_NAME}"`,
      ];
    default:
      return ["Tip: clawdbot daemon stop"];
  }
}

async function maybeExplainGatewayServiceStop() {
  const service = resolveGatewayService();
  let loaded: boolean | null = null;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = null;
  }
  if (loaded === false) return;
  defaultRuntime.error(
    loaded
      ? `Gateway service appears ${service.loadedText}. Stop it first.`
      : "Gateway service status unknown; if supervised, stop it first.",
  );
  for (const hint of renderGatewayServiceStopHints()) {
    defaultRuntime.error(hint);
  }
}

async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
}) {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };

  const request = (action: GatewayRunSignalAction, signal: string) => {
    if (shuttingDown) {
      gatewayLog.info(`received ${signal} during shutdown; ignoring`);
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    gatewayLog.info(
      `received ${signal}; ${isRestart ? "restarting" : "shutting down"}`,
    );

    const forceExitTimer = setTimeout(() => {
      gatewayLog.error("shutdown timed out; exiting without full cleanup");
      cleanupSignals();
      params.runtime.exit(0);
    }, 5000);

    void (async () => {
      try {
        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        gatewayLog.error(`shutdown error: ${String(err)}`);
      } finally {
        clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          shuttingDown = false;
          restartResolver?.();
        } else {
          cleanupSignals();
          params.runtime.exit(0);
        }
      }
    })();
  };

  const onSigterm = () => {
    gatewayLog.info("signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    gatewayLog.info("signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    gatewayLog.info("signal SIGUSR1 received");
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    // Keep process alive; SIGUSR1 triggers an in-process restart (no supervisor required).
    // SIGTERM/SIGINT still exit after a graceful shutdown.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      server = await params.start();
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    cleanupSignals();
  }
}

const gatewayCallOpts = (cmd: Command) =>
  cmd
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to gateway.remote.url when configured)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option("--json", "Output JSON", false);

const callGatewayCli = async (
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
) =>
  withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: "cli",
        mode: "cli",
      }),
  );

async function runGatewayCommand(
  opts: GatewayRunOpts,
  params: GatewayRunParams = {},
) {
  const isDevProfile =
    process.env.CLAWDBOT_PROFILE?.trim().toLowerCase() === "dev";
  const devMode = Boolean(opts.dev) || isDevProfile;
  if (opts.reset && !devMode) {
    defaultRuntime.error("Use --reset with --dev.");
    defaultRuntime.exit(1);
    return;
  }
  if (params.legacyTokenEnv) {
    const legacyToken = process.env.CLAWDIS_GATEWAY_TOKEN;
    if (legacyToken && !process.env.CLAWDBOT_GATEWAY_TOKEN) {
      process.env.CLAWDBOT_GATEWAY_TOKEN = legacyToken;
    }
  }

  setVerbose(Boolean(opts.verbose));
  if (opts.claudeCliLogs) {
    setConsoleSubsystemFilter(["agent/claude-cli"]);
    process.env.CLAWDBOT_CLAUDE_CLI_LOG_OUTPUT = "1";
  }
  const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as
    | string
    | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  if (
    wsLogRaw !== undefined &&
    wsLogRaw !== "auto" &&
    wsLogRaw !== "compact" &&
    wsLogRaw !== "full"
  ) {
    defaultRuntime.error('Invalid --ws-log (use "auto", "full", "compact")');
    defaultRuntime.exit(1);
  }
  setGatewayWsLogStyle(wsLogStyle);

  if (opts.rawStream) {
    process.env.CLAWDBOT_RAW_STREAM = "1";
  }
  const rawStreamPath = toOptionString(opts.rawStreamPath);
  if (rawStreamPath) {
    process.env.CLAWDBOT_RAW_STREAM_PATH = rawStreamPath;
  }

  if (devMode) {
    await ensureDevGatewayConfig({ reset: Boolean(opts.reset) });
  }

  const cfg = loadConfig();
  const portOverride = parsePort(opts.port);
  if (opts.port !== undefined && portOverride === null) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  const port = portOverride ?? resolveGatewayPort(cfg);
  if (!Number.isFinite(port) || port <= 0) {
    defaultRuntime.error("Invalid port");
    defaultRuntime.exit(1);
  }
  if (opts.force) {
    try {
      const { killed, waitedMs, escalatedToSigkill } =
        await forceFreePortAndWait(port, {
          timeoutMs: 2000,
          intervalMs: 100,
          sigtermTimeoutMs: 700,
        });
      if (killed.length === 0) {
        gatewayLog.info(`force: no listeners on port ${port}`);
      } else {
        for (const proc of killed) {
          gatewayLog.info(
            `force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`,
          );
        }
        if (escalatedToSigkill) {
          gatewayLog.info(
            `force: escalated to SIGKILL while freeing port ${port}`,
          );
        }
        if (waitedMs > 0) {
          gatewayLog.info(
            `force: waited ${waitedMs}ms for port ${port} to free`,
          );
        }
      }
    } catch (err) {
      defaultRuntime.error(`Force: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }
  if (opts.token) {
    const token = toOptionString(opts.token);
    if (token) process.env.CLAWDBOT_GATEWAY_TOKEN = token;
  }
  const authModeRaw = toOptionString(opts.auth);
  const authMode: GatewayAuthMode | null =
    authModeRaw === "token" || authModeRaw === "password" ? authModeRaw : null;
  if (authModeRaw && !authMode) {
    defaultRuntime.error('Invalid --auth (use "token" or "password")');
    defaultRuntime.exit(1);
    return;
  }
  const tailscaleRaw = toOptionString(opts.tailscale);
  const tailscaleMode =
    tailscaleRaw === "off" ||
    tailscaleRaw === "serve" ||
    tailscaleRaw === "funnel"
      ? tailscaleRaw
      : null;
  if (tailscaleRaw && !tailscaleMode) {
    defaultRuntime.error(
      'Invalid --tailscale (use "off", "serve", or "funnel")',
    );
    defaultRuntime.exit(1);
    return;
  }
  const passwordRaw = toOptionString(opts.password);
  const tokenRaw = toOptionString(opts.token);
  const configExists = fs.existsSync(CONFIG_PATH_CLAWDBOT);
  const mode = cfg.gateway?.mode;
  if (!opts.allowUnconfigured && mode !== "local") {
    if (!configExists) {
      defaultRuntime.error(
        "Missing config. Run `clawdbot setup` or set gateway.mode=local (or pass --allow-unconfigured).",
      );
    } else {
      defaultRuntime.error(
        `Gateway start blocked: set gateway.mode=local (current: ${mode ?? "unset"}) or pass --allow-unconfigured.`,
      );
    }
    defaultRuntime.exit(1);
    return;
  }
  const bindRaw = toOptionString(opts.bind) ?? cfg.gateway?.bind ?? "loopback";
  const bind =
    bindRaw === "loopback" ||
    bindRaw === "tailnet" ||
    bindRaw === "lan" ||
    bindRaw === "auto"
      ? bindRaw
      : null;
  if (!bind) {
    defaultRuntime.error(
      'Invalid --bind (use "loopback", "tailnet", "lan", or "auto")',
    );
    defaultRuntime.exit(1);
    return;
  }

  const snapshot = await readConfigFileSnapshot().catch(() => null);
  const miskeys = extractGatewayMiskeys(snapshot?.parsed);
  const authConfig = {
    ...cfg.gateway?.auth,
    ...(authMode ? { mode: authMode } : {}),
    ...(passwordRaw ? { password: passwordRaw } : {}),
    ...(tokenRaw ? { token: tokenRaw } : {}),
  };
  const resolvedAuth = resolveGatewayAuth({
    authConfig,
    env: process.env,
    tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off",
  });
  const resolvedAuthMode = resolvedAuth.mode;
  const tokenValue = resolvedAuth.token;
  const passwordValue = resolvedAuth.password;
  const authHints: string[] = [];
  if (miskeys.hasGatewayToken) {
    authHints.push(
      'Found "gateway.token" in config. Use "gateway.auth.token" instead.',
    );
  }
  if (miskeys.hasRemoteToken) {
    authHints.push(
      '"gateway.remote.token" is for remote CLI calls; it does not enable local gateway auth.',
    );
  }
  if (resolvedAuthMode === "token" && !tokenValue) {
    defaultRuntime.error(
      [
        "Gateway auth is set to token, but no token is configured.",
        "Set gateway.auth.token (or CLAWDBOT_GATEWAY_TOKEN), or pass --token.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (resolvedAuthMode === "password" && !passwordValue) {
    defaultRuntime.error(
      [
        "Gateway auth is set to password, but no password is configured.",
        "Set gateway.auth.password (or CLAWDBOT_GATEWAY_PASSWORD), or pass --password.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }
  if (bind !== "loopback" && resolvedAuthMode === "none") {
    defaultRuntime.error(
      [
        `Refusing to bind gateway to ${bind} without auth.`,
        "Set gateway.auth.token (or CLAWDBOT_GATEWAY_TOKEN) or pass --token.",
        ...authHints,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }

  try {
    await runGatewayLoop({
      runtime: defaultRuntime,
      start: async () =>
        await startGatewayServer(port, {
          bind,
          auth:
            authMode || passwordRaw || tokenRaw || authModeRaw
              ? {
                  mode: authMode ?? undefined,
                  token: tokenRaw,
                  password: passwordRaw,
                }
              : undefined,
          tailscale:
            tailscaleMode || opts.tailscaleResetOnExit
              ? {
                  mode: tailscaleMode ?? undefined,
                  resetOnExit: Boolean(opts.tailscaleResetOnExit),
                }
              : undefined,
        }),
    });
  } catch (err) {
    if (
      err instanceof GatewayLockError ||
      (err &&
        typeof err === "object" &&
        (err as { name?: string }).name === "GatewayLockError")
    ) {
      const errMessage = describeUnknownError(err);
      defaultRuntime.error(
        `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: clawdbot daemon stop`,
      );
      try {
        const diagnostics = await inspectPortUsage(port);
        if (diagnostics.status === "busy") {
          for (const line of formatPortDiagnostics(diagnostics)) {
            defaultRuntime.error(line);
          }
        }
      } catch {
        // ignore diagnostics failures
      }
      await maybeExplainGatewayServiceStop();
      defaultRuntime.exit(1);
      return;
    }
    defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
    defaultRuntime.exit(1);
  }
}

function addGatewayRunCommand(
  cmd: Command,
  params: GatewayRunParams = {},
): Command {
  return cmd
    .option("--port <port>", "Port for the gateway WebSocket")
    .option(
      "--bind <mode>",
      'Bind mode ("loopback"|"tailnet"|"lan"|"auto"). Defaults to config gateway.bind (or loopback).',
    )
    .option(
      "--token <token>",
      "Shared token required in connect.params.auth.token (default: CLAWDBOT_GATEWAY_TOKEN env if set)",
    )
    .option("--auth <mode>", 'Gateway auth mode ("token"|"password")')
    .option("--password <password>", "Password for auth mode=password")
    .option(
      "--tailscale <mode>",
      'Tailscale exposure mode ("off"|"serve"|"funnel")',
    )
    .option(
      "--tailscale-reset-on-exit",
      "Reset Tailscale serve/funnel configuration on shutdown",
      false,
    )
    .option(
      "--allow-unconfigured",
      "Allow gateway start without gateway.mode=local in config",
      false,
    )
    .option(
      "--dev",
      "Create a dev config + workspace if missing (no BOOTSTRAP.md)",
      false,
    )
    .option(
      "--reset",
      "Reset dev config + credentials + sessions + workspace (requires --dev)",
      false,
    )
    .option(
      "--force",
      "Kill any existing listener on the target port before starting",
      false,
    )
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--claude-cli-logs",
      "Only show claude-cli logs in the console (includes stdout/stderr)",
      false,
    )
    .option(
      "--ws-log <style>",
      'WebSocket log style ("auto"|"full"|"compact")',
      "auto",
    )
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .option("--raw-stream", "Log raw model stream events to jsonl", false)
    .option("--raw-stream-path <path>", "Raw stream jsonl path")
    .action(async (opts) => {
      await runGatewayCommand(opts, params);
    });
}

export function registerGatewayCli(program: Command) {
  const gateway = addGatewayRunCommand(
    program.command("gateway").description("Run the WebSocket Gateway"),
  );

  // Back-compat: legacy launchd plists used gateway-daemon; keep hidden alias.
  addGatewayRunCommand(
    program
      .command("gateway-daemon", { hidden: true })
      .description("Run the WebSocket Gateway as a long-lived daemon"),
    { legacyTokenEnv: true },
  );

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument(
        "<method>",
        "Method name (health/status/system-presence/cron.*)",
      )
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts) => {
        try {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, opts, params);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Gateway call")}: ${colorize(
              rich,
              theme.muted,
              String(method),
            )}`,
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(`Gateway call failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts) => {
        try {
          const result = await callGatewayCli("health", opts);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const rich = isRich();
          const obj =
            result && typeof result === "object"
              ? (result as Record<string, unknown>)
              : {};
          const durationMs =
            typeof obj.durationMs === "number" ? obj.durationMs : null;
          defaultRuntime.log(colorize(rich, theme.heading, "Gateway Health"));
          defaultRuntime.log(
            `${colorize(rich, theme.success, "OK")}${
              durationMs != null ? ` (${durationMs}ms)` : ""
            }`,
          );
          if (obj.web && typeof obj.web === "object") {
            const web = obj.web as Record<string, unknown>;
            const linked = web.linked === true;
            defaultRuntime.log(
              `Web: ${linked ? "linked" : "not linked"}${
                typeof web.authAgeMs === "number" && linked
                  ? ` (${Math.round(web.authAgeMs / 60_000)}m)`
                  : ""
              }`,
            );
          }
          if (obj.telegram && typeof obj.telegram === "object") {
            const tg = obj.telegram as Record<string, unknown>;
            defaultRuntime.log(
              `Telegram: ${tg.configured === true ? "configured" : "not configured"}`,
            );
          }
          if (obj.discord && typeof obj.discord === "object") {
            const dc = obj.discord as Record<string, unknown>;
            defaultRuntime.log(
              `Discord: ${dc.configured === true ? "configured" : "not configured"}`,
            );
          }
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gateway
    .command("status")
    .description(
      "Show gateway reachability + discovery + health + status summary (local + remote)",
    )
    .option(
      "--url <url>",
      "Explicit Gateway WebSocket URL (still probes localhost)",
    )
    .option(
      "--ssh <target>",
      "SSH target for remote gateway tunnel (user@host or user@host:port)",
    )
    .option("--ssh-identity <path>", "SSH identity file path")
    .option(
      "--ssh-auto",
      "Try to derive an SSH target from Bonjour discovery",
      false,
    )
    .option("--token <token>", "Gateway token (applies to all probes)")
    .option("--password <password>", "Gateway password (applies to all probes)")
    .option("--timeout <ms>", "Overall probe budget in ms", "3000")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      try {
        await gatewayStatusCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  gateway
    .command("discover")
    .description(
      `Discover gateways via Bonjour (multicast local. + unicast ${WIDE_AREA_DISCOVERY_DOMAIN})`,
    )
    .option("--timeout <ms>", "Per-command timeout in ms", "2000")
    .option("--json", "Output JSON", false)
    .action(async (opts: GatewayDiscoverOpts) => {
      try {
        const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2000);
        const beacons = await withProgress(
          {
            label: "Scanning for gateways…",
            indeterminate: true,
            enabled: opts.json !== true,
            delayMs: 0,
          },
          async () => await discoverGatewayBeacons({ timeoutMs }),
        );

        const deduped = dedupeBeacons(beacons).sort((a, b) =>
          String(a.displayName || a.instanceName).localeCompare(
            String(b.displayName || b.instanceName),
          ),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return {
              ...b,
              wsUrl: host ? `ws://${host}:${port}` : null,
            };
          });
          defaultRuntime.log(
            JSON.stringify(
              {
                timeoutMs,
                domains: ["local.", WIDE_AREA_DISCOVERY_DOMAIN],
                count: enriched.length,
                beacons: enriched,
              },
              null,
              2,
            ),
          );
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Gateway Discovery"));
        defaultRuntime.log(
          colorize(
            rich,
            theme.muted,
            `Found ${deduped.length} gateway(s) · domains: local., ${WIDE_AREA_DISCOVERY_DOMAIN}`,
          ),
        );
        if (deduped.length === 0) return;

        for (const beacon of deduped) {
          for (const line of renderBeaconLines(beacon, rich)) {
            defaultRuntime.log(line);
          }
        }
      } catch (err) {
        defaultRuntime.error(`gateway discover failed: ${String(err)}`);
        defaultRuntime.exit(1);
      }
    });
}
