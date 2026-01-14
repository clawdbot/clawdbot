#!/usr/bin/env node
import process from "node:process";

declare const __CLAWDBOT_VERSION__: string;

const BUNDLED_VERSION =
  (typeof __CLAWDBOT_VERSION__ === "string" && __CLAWDBOT_VERSION__) ||
  process.env.CLAWDBOT_BUNDLED_VERSION ||
  "0.0.0";

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const args = process.argv.slice(2);

type GatewayWsLogStyle = "auto" | "full" | "compact";

async function main() {
  if (hasFlag(args, "--version") || hasFlag(args, "-v")) {
    // Match `clawdbot --version` behavior for Swift env/version checks.
    // Keep output a single line.
    console.log(BUNDLED_VERSION);
    process.exit(0);
  }

  // Bun runtime ships a global `Long` that protobufjs detects, but it does not
  // implement the long.js API that Baileys/WAProto expects (fromBits, ...).
  // Ensure we use long.js so the embedded gateway doesn't crash at startup.
  if (typeof process.versions.bun === "string") {
    const mod = await import("long");
    const Long = (mod as unknown as { default?: unknown }).default ?? mod;
    (globalThis as unknown as { Long?: unknown }).Long = Long;
  }

  const [
    { loadConfig },
    { startGatewayServer },
    { setGatewayWsLogStyle },
    { setVerbose },
    { defaultRuntime },
  ] = await Promise.all([
    import("../config/config.js"),
    import("../gateway/server.js"),
    import("../gateway/ws-logging.js"),
    import("../globals.js"),
    import("../runtime.js"),
  ]);

  setVerbose(hasFlag(args, "--verbose"));

  const wsLogRaw = (
    hasFlag(args, "--compact") ? "compact" : argValue(args, "--ws-log")
  ) as string | undefined;
  const wsLogStyle: GatewayWsLogStyle =
    wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
  setGatewayWsLogStyle(wsLogStyle);

  const cfg = loadConfig();
  const portRaw =
    argValue(args, "--port") ??
    process.env.CLAWDBOT_GATEWAY_PORT ??
    (typeof cfg.gateway?.port === "number" ? String(cfg.gateway.port) : "") ??
    "18789";
  const port = Number.parseInt(portRaw, 10);
  if (Number.isNaN(port) || port <= 0) {
    defaultRuntime.error(`Invalid --port (${portRaw})`);
    process.exit(1);
  }

  const bindRaw =
    argValue(args, "--bind") ??
    process.env.CLAWDBOT_GATEWAY_BIND ??
    cfg.gateway?.bind ??
    "loopback";
  const bind =
    bindRaw === "loopback" ||
    bindRaw === "lan" ||
    bindRaw === "auto" ||
    bindRaw === "custom"
      ? bindRaw
      : null;
  if (!bind) {
    defaultRuntime.error(
      'Invalid --bind (use "loopback", "lan", "auto", or "custom")',
    );
    process.exit(1);
  }

  const token = argValue(args, "--token");
  if (token) process.env.CLAWDBOT_GATEWAY_TOKEN = token;

  let server: Awaited<ReturnType<typeof startGatewayServer>> | null = null;
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  let restartResolver: (() => void) | null = null;

  const cleanupSignals = () => {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onSigusr1);
  };

  const request = (action: "stop" | "restart", signal: string) => {
    if (shuttingDown) {
      defaultRuntime.log(
        `gateway: received ${signal} during shutdown; ignoring`,
      );
      return;
    }
    shuttingDown = true;
    const isRestart = action === "restart";
    defaultRuntime.log(
      `gateway: received ${signal}; ${isRestart ? "restarting" : "shutting down"}`,
    );

    forceExitTimer = setTimeout(() => {
      defaultRuntime.error(
        "gateway: shutdown timed out; exiting without full cleanup",
      );
      cleanupSignals();
      process.exit(0);
    }, 5000);

    void (async () => {
      try {
        await server?.close({
          reason: isRestart ? "gateway restarting" : "gateway stopping",
          restartExpectedMs: isRestart ? 1500 : null,
        });
      } catch (err) {
        defaultRuntime.error(`gateway: shutdown error: ${String(err)}`);
      } finally {
        if (forceExitTimer) clearTimeout(forceExitTimer);
        server = null;
        if (isRestart) {
          shuttingDown = false;
          restartResolver?.();
        } else {
          cleanupSignals();
          process.exit(0);
        }
      }
    })();
  };

  const onSigterm = () => {
    defaultRuntime.log("gateway: signal SIGTERM received");
    request("stop", "SIGTERM");
  };
  const onSigint = () => {
    defaultRuntime.log("gateway: signal SIGINT received");
    request("stop", "SIGINT");
  };
  const onSigusr1 = () => {
    defaultRuntime.log("gateway: signal SIGUSR1 received");
    request("restart", "SIGUSR1");
  };

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  process.on("SIGUSR1", onSigusr1);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        server = await startGatewayServer(port, { bind });
      } catch (err) {
        cleanupSignals();
        defaultRuntime.error(`Gateway failed to start: ${String(err)}`);
        process.exit(1);
      }
      await new Promise<void>((resolve) => {
        restartResolver = resolve;
      });
    }
  } finally {
    cleanupSignals();
  }
}

void main();
