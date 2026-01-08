import fs from "node:fs";

import type { Command } from "commander";
import {
  CONFIG_PATH_CLAWDBOT,
  loadConfig,
  resolveGatewayPort,
} from "../config/config.js";
import {
  GATEWAY_LAUNCH_AGENT_LABEL,
  GATEWAY_SYSTEMD_SERVICE_NAME,
  GATEWAY_WINDOWS_TASK_NAME,
} from "../daemon/constants.js";
import { resolveGatewayService } from "../daemon/service.js";
import { callGateway, randomIdempotencyKey } from "../gateway/call.js";
import { startGatewayServer } from "../gateway/server.js";
import {
  type GatewayWsLogStyle,
  setGatewayWsLogStyle,
} from "../gateway/ws-logging.js";
import { setVerbose } from "../globals.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import {
  runDaemonInstall,
  runDaemonRestart,
  runDaemonStart,
  runDaemonStatus,
  runDaemonStop,
  runDaemonUninstall,
} from "./daemon-cli.js";
import { createDefaultDeps } from "./deps.js";
import { forceFreePortAndWait } from "./ports.js";

type GatewayRpcOpts = {
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
};

const gatewayLog = createSubsystemLogger("gateway");

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

function renderGatewayServiceStopHints(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "Tip: clawdbot gateway stop",
        `Or: launchctl bootout gui/$UID/${GATEWAY_LAUNCH_AGENT_LABEL}`,
      ];
    case "linux":
      return [
        "Tip: clawdbot gateway stop",
        `Or: systemctl --user stop ${GATEWAY_SYSTEMD_SERVICE_NAME}.service`,
      ];
    case "win32":
      return [
        "Tip: clawdbot gateway stop",
        `Or: schtasks /End /TN "${GATEWAY_WINDOWS_TASK_NAME}"`,
      ];
    default:
      return ["Tip: clawdbot gateway stop"];
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

  const onSigterm = () => request("stop", "SIGTERM");
  const onSigint = () => request("stop", "SIGINT");
  const onSigusr1 = () => request("restart", "SIGUSR1");

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
    .option("--expect-final", "Wait for final response (agent)", false);

const callGatewayCli = async (
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
) =>
  callGateway({
    url: opts.url,
    token: opts.token,
    password: opts.password,
    method,
    params,
    expectFinal: Boolean(opts.expectFinal),
    timeoutMs: Number(opts.timeout ?? 10_000),
    clientName: "cli",
    mode: "cli",
  });

export function registerGatewayCli(program: Command) {
  program
    .command("gateway-daemon")
    .description("Run the WebSocket Gateway as a long-lived daemon")
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
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--ws-log <style>",
      'WebSocket log style ("auto"|"full"|"compact")',
      "auto",
    )
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as
        | string
        | undefined;
      const wsLogStyle: GatewayWsLogStyle =
        wsLogRaw === "compact"
          ? "compact"
          : wsLogRaw === "full"
            ? "full"
            : "auto";
      if (
        wsLogRaw !== undefined &&
        wsLogRaw !== "auto" &&
        wsLogRaw !== "compact" &&
        wsLogRaw !== "full"
      ) {
        defaultRuntime.error(
          'Invalid --ws-log (use "auto", "full", "compact")',
        );
        defaultRuntime.exit(1);
      }
      setGatewayWsLogStyle(wsLogStyle);

      const cfg = loadConfig();
      const portOverride = parsePort(opts.port);
      if (opts.port !== undefined && portOverride === null) {
        defaultRuntime.error("Invalid port");
        defaultRuntime.exit(1);
        return;
      }
      const port = portOverride ?? resolveGatewayPort(cfg);
      if (!Number.isFinite(port) || port <= 0) {
        defaultRuntime.error("Invalid port");
        defaultRuntime.exit(1);
        return;
      }
      if (opts.token) {
        process.env.CLAWDBOT_GATEWAY_TOKEN = String(opts.token);
      }
      const authModeRaw = opts.auth ? String(opts.auth) : undefined;
      const authMode =
        authModeRaw === "token" || authModeRaw === "password"
          ? authModeRaw
          : null;
      if (authModeRaw && !authMode) {
        defaultRuntime.error('Invalid --auth (use "token" or "password")');
        defaultRuntime.exit(1);
        return;
      }
      const tailscaleRaw = opts.tailscale ? String(opts.tailscale) : undefined;
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
      const bindRaw = String(opts.bind ?? cfg.gateway?.bind ?? "loopback");
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

      try {
        await runGatewayLoop({
          runtime: defaultRuntime,
          start: async () =>
            await startGatewayServer(port, {
              bind,
              auth:
                authMode || opts.password || authModeRaw
                  ? {
                      mode: authMode ?? undefined,
                      password: opts.password
                        ? String(opts.password)
                        : undefined,
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
            `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: clawdbot gateway stop`,
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
    });

  const gateway = program
    .command("gateway")
    .description("Run the WebSocket Gateway")
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
      "--force",
      "Kill any existing listener on the target port before starting",
      false,
    )
    .option("--verbose", "Verbose logging to stdout/stderr", false)
    .option(
      "--ws-log <style>",
      'WebSocket log style ("auto"|"full"|"compact")',
      "auto",
    )
    .option("--compact", 'Alias for "--ws-log compact"', false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const wsLogRaw = (opts.compact ? "compact" : opts.wsLog) as
        | string
        | undefined;
      const wsLogStyle: GatewayWsLogStyle =
        wsLogRaw === "compact"
          ? "compact"
          : wsLogRaw === "full"
            ? "full"
            : "auto";
      if (
        wsLogRaw !== undefined &&
        wsLogRaw !== "auto" &&
        wsLogRaw !== "compact" &&
        wsLogRaw !== "full"
      ) {
        defaultRuntime.error(
          'Invalid --ws-log (use "auto", "full", "compact")',
        );
        defaultRuntime.exit(1);
      }
      setGatewayWsLogStyle(wsLogStyle);

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
        process.env.CLAWDBOT_GATEWAY_TOKEN = String(opts.token);
      }
      const authModeRaw = opts.auth ? String(opts.auth) : undefined;
      const authMode =
        authModeRaw === "token" || authModeRaw === "password"
          ? authModeRaw
          : null;
      if (authModeRaw && !authMode) {
        defaultRuntime.error('Invalid --auth (use "token" or "password")');
        defaultRuntime.exit(1);
        return;
      }
      const tailscaleRaw = opts.tailscale ? String(opts.tailscale) : undefined;
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
      const configExists = fs.existsSync(CONFIG_PATH_CLAWDBOT);
      const mode = cfg.gateway?.mode;
      if (!opts.allowUnconfigured && mode !== "local") {
        if (!configExists) {
          defaultRuntime.error(
            "Missing config. Run `clawdbot setup` or set gateway.mode=local (or pass --allow-unconfigured).",
          );
        } else {
          defaultRuntime.error(
            "Gateway start blocked: set gateway.mode=local (or pass --allow-unconfigured).",
          );
        }
        defaultRuntime.exit(1);
        return;
      }
      const bindRaw = String(opts.bind ?? cfg.gateway?.bind ?? "loopback");
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

      try {
        await runGatewayLoop({
          runtime: defaultRuntime,
          start: async () =>
            await startGatewayServer(port, {
              bind,
              auth:
                authMode || opts.password || authModeRaw
                  ? {
                      mode: authMode ?? undefined,
                      password: opts.password
                        ? String(opts.password)
                        : undefined,
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
            `Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: clawdbot gateway stop`,
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
    });

  gateway
    .command("install")
    .description(
      "Install the Gateway service (alias for `clawdbot daemon install`)",
    )
    .option("--port <port>", "Gateway port")
    .option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node")
    .option("--token <token>", "Gateway token (token auth)")
    .action(async (opts) => {
      await runDaemonInstall(opts);
    });

  gateway
    .command("uninstall")
    .description(
      "Uninstall the Gateway service (alias for `clawdbot daemon uninstall`)",
    )
    .action(async () => {
      await runDaemonUninstall();
    });

  gateway
    .command("start")
    .description(
      "Start the Gateway service (alias for `clawdbot daemon start`)",
    )
    .action(async () => {
      await runDaemonStart();
    });

  const gatewayDaemon = gateway
    .command("daemon")
    .description("Daemon helpers (alias for `clawdbot daemon`)");

  gatewayDaemon
    .command("status")
    .description("Show daemon install status + probe the Gateway")
    .option(
      "--url <url>",
      "Gateway WebSocket URL (defaults to config/remote/local)",
    )
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--no-probe", "Skip RPC probe")
    .option("--deep", "Scan system-level services", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runDaemonStatus({
        rpc: opts,
        probe: Boolean(opts.probe),
        deep: Boolean(opts.deep),
        json: Boolean(opts.json),
      });
    });

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method and print JSON")
      .argument(
        "<method>",
        "Method name (health/status/system-presence/send/agent/cron.*)",
      )
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts) => {
        try {
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, opts, params);
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
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("status")
      .description("Fetch Gateway status")
      .action(async (opts) => {
        try {
          const result = await callGatewayCli("status", opts);
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("wake")
      .description("Enqueue a system event and optionally trigger a heartbeat")
      .requiredOption("--text <text>", "System event text")
      .option(
        "--mode <mode>",
        "Wake mode (now|next-heartbeat)",
        "next-heartbeat",
      )
      .action(async (opts) => {
        try {
          const result = await callGatewayCli("wake", opts, {
            mode: opts.mode,
            text: opts.text,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("send")
      .description("Send a message via the Gateway")
      .requiredOption("--to <jidOrPhone>", "Destination (E.164 or jid)")
      .requiredOption("--message <text>", "Message text")
      .option("--media-url <url>", "Optional media URL")
      .option("--gif-playback", "Treat video media as GIF playback", false)
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callGatewayCli("send", opts, {
            to: opts.to,
            message: opts.message,
            mediaUrl: opts.mediaUrl,
            gifPlayback: opts.gifPlayback,
            idempotencyKey,
          });
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gatewayCallOpts(
    gateway
      .command("agent")
      .description("Run an agent turn via the Gateway (waits for final)")
      .requiredOption("--message <text>", "User message")
      .option("--to <jidOrPhone>", "Destination")
      .option("--session-id <id>", "Session id")
      .option("--thinking <level>", "Thinking level")
      .option("--deliver", "Deliver response", false)
      .option("--timeout-seconds <n>", "Agent timeout seconds")
      .option("--idempotency-key <key>", "Idempotency key")
      .action(async (opts) => {
        try {
          const idempotencyKey = opts.idempotencyKey ?? randomIdempotencyKey();
          const result = await callGatewayCli(
            "agent",
            { ...opts, expectFinal: true },
            {
              message: opts.message,
              to: opts.to,
              sessionId: opts.sessionId,
              thinking: opts.thinking,
              deliver: Boolean(opts.deliver),
              timeout: opts.timeoutSeconds
                ? Number.parseInt(String(opts.timeoutSeconds), 10)
                : undefined,
              idempotencyKey,
            },
          );
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      }),
  );

  gateway
    .command("stop")
    .description("Stop the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonStop();
    });

  gateway
    .command("restart")
    .description("Restart the Gateway service (launchd/systemd/schtasks)")
    .action(async () => {
      await runDaemonRestart();
    });

  // Build default deps (keeps parity with other commands; future-proofing).
  void createDefaultDeps();
}
