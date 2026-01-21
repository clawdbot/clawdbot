import type { startGatewayServer } from "../../gateway/server.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import {
  consumeGatewaySigusr1RestartAuthorization,
  isGatewaySigusr1RestartExternallyAllowed,
} from "../../infra/restart.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { defaultRuntime } from "../../runtime.js";

const gatewayLog = createSubsystemLogger("gateway");

type GatewayRunSignalAction = "stop" | "restart";

export async function runGatewayLoop(params: {
  start: () => Promise<Awaited<ReturnType<typeof startGatewayServer>>>;
  runtime: typeof defaultRuntime;
}) {
  const lock = await acquireGatewayLock();
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
    gatewayLog.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);

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
    const authorized = consumeGatewaySigusr1RestartAuthorization();
    if (!authorized && !isGatewaySigusr1RestartExternallyAllowed()) {
      gatewayLog.warn(
        "SIGUSR1 restart ignored (not authorized; enable commands.restart or use gateway tool).",
      );
      return;
    }
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
    await lock?.release();
    cleanupSignals();
  }
}
