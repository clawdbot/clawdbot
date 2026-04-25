import {
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
import {
  DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT,
  type MutableDiscordGateway,
} from "./gateway-handle.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
import {
  DiscordGatewayLifecycleError,
  type DiscordGatewayEvent,
  type DiscordGatewaySupervisor,
} from "./gateway-supervisor.js";
import type { DiscordMonitorStatusSink } from "./status.js";

const DISCORD_GATEWAY_READY_TIMEOUT_MS = 15_000;
const DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS = 30_000;
const DISCORD_GATEWAY_READY_POLL_MS = 250;
const DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS = 5_000;
const DISCORD_GATEWAY_STARTUP_TERMINATE_CLOSE_TIMEOUT_MS = 1_000;
const DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS = 30_000;

type GatewayReadyWaitResult = "ready" | "stopped" | "timeout";

async function restartGatewayAfterReadyTimeout(params: {
  gateway?: Pick<MutableDiscordGateway, "connect" | "disconnect" | "ws">;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
}): Promise<void> {
  if (!params.gateway || params.abortSignal?.aborted) {
    return;
  }

  const socket = params.gateway.ws;
  if (!socket) {
    params.gateway.disconnect();
    if (!params.abortSignal?.aborted) {
      params.gateway.connect(false);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    let terminateCloseTimeout: ReturnType<typeof setTimeout> | undefined;
    const ignoreSocketError = () => {};
    const clearTimers = () => {
      if (drainTimeout) {
        clearTimeout(drainTimeout);
        drainTimeout = undefined;
      }
      if (terminateCloseTimeout) {
        clearTimeout(terminateCloseTimeout);
        terminateCloseTimeout = undefined;
      }
    };
    const cleanup = () => {
      clearTimers();
      socket.removeListener("close", onClose);
      socket.removeListener("error", ignoreSocketError);
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const finishReject = (error: Error) => {
      if (params.abortSignal?.aborted) {
        finishResolve();
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onClose = () => {
      finishResolve();
    };

    socket.on("error", ignoreSocketError);
    socket.on("close", onClose);
    params.gateway?.disconnect();

    drainTimeout = setTimeout(() => {
      if (settled) {
        return;
      }
      if (typeof socket.terminate !== "function") {
        finishReject(
          new Error(
            `discord gateway socket did not close within ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms before restart`,
          ),
        );
        return;
      }
      params.runtime.error?.(
        danger(
          `discord: startup restart waiting on a stale gateway socket for ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms; forcing terminate before reconnect`,
        ),
      );
      try {
        socket.terminate();
      } catch {
        finishReject(
          new Error(
            `discord gateway socket did not close within ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms before restart`,
          ),
        );
        return;
      }
      terminateCloseTimeout = setTimeout(() => {
        finishReject(
          new Error(
            `discord gateway socket did not close within ${DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS}ms before restart`,
          ),
        );
      }, DISCORD_GATEWAY_STARTUP_TERMINATE_CLOSE_TIMEOUT_MS);
      terminateCloseTimeout.unref?.();
    }, DISCORD_GATEWAY_STARTUP_DISCONNECT_DRAIN_TIMEOUT_MS);
    drainTimeout.unref?.();
  });

  if (!params.abortSignal?.aborted) {
    params.gateway.connect(false);
  }
}

function parseGatewayCloseCode(message: string): number | undefined {
  const match = /Gateway websocket closed:\s*(\d{3,5})/.exec(message);
  if (!match?.[1]) {
    return undefined;
  }
  const code = Number.parseInt(match[1], 10);
  return Number.isFinite(code) ? code : undefined;
}

function resolveTransportActivityAt(event: unknown): number {
  const at = (event as { at?: unknown } | undefined)?.at;
  return typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : Date.now();
}

function createGatewayStatusObserver(params: {
  gateway?: Pick<MutableDiscordGateway, "isConnected">;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  pushStatus: (patch: Parameters<DiscordMonitorStatusSink>[0]) => void;
  isLifecycleStopping: () => boolean;
}) {
  let forceStopHandler: ((err: unknown) => void) | undefined;
  let queuedForceStopError: unknown;
  let readyPollId: ReturnType<typeof setInterval> | undefined;
  let readyTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const shouldStop = () => params.abortSignal?.aborted || params.isLifecycleStopping();
  const clearReadyWatch = () => {
    if (readyPollId) {
      clearInterval(readyPollId);
      readyPollId = undefined;
    }
    if (readyTimeoutId) {
      clearTimeout(readyTimeoutId);
      readyTimeoutId = undefined;
    }
  };
  const triggerForceStop = (err: unknown) => {
    if (forceStopHandler) {
      forceStopHandler(err);
      return;
    }
    queuedForceStopError = err;
  };
  const pushConnectedStatus = (at: number) => {
    params.pushStatus({
      ...createConnectedChannelStatusPatch(at),
      lastDisconnect: null,
      lastError: null,
    });
  };
  const startReadyWatch = () => {
    clearReadyWatch();
    const pollConnected = () => {
      if (shouldStop()) {
        clearReadyWatch();
        return;
      }
      if (!params.gateway?.isConnected) {
        return;
      }
      clearReadyWatch();
      pushConnectedStatus(Date.now());
    };

    pollConnected();
    if (!readyTimeoutId) {
      readyPollId = setInterval(pollConnected, DISCORD_GATEWAY_READY_POLL_MS);
      readyPollId.unref?.();
      readyTimeoutId = setTimeout(() => {
        clearReadyWatch();
        if (shouldStop() || params.gateway?.isConnected) {
          return;
        }
        const at = Date.now();
        const error = new Error(
          `discord gateway opened but did not reach READY within ${DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS}ms`,
        );
        params.pushStatus({
          connected: false,
          lastEventAt: at,
          lastDisconnect: {
            at,
            error: "runtime-not-ready",
          },
          lastError: "runtime-not-ready",
        });
        params.runtime.error?.(danger(error.message));
        triggerForceStop(error);
      }, DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS);
      readyTimeoutId.unref?.();
    }
  };

  const onGatewayDebug = (msg: unknown) => {
    if (shouldStop()) {
      return;
    }
    const at = Date.now();
    const message = String(msg);
    if (message.includes("Gateway websocket opened")) {
      params.pushStatus({ connected: false, lastEventAt: at });
      startReadyWatch();
      return;
    }
    if (message.includes("Gateway websocket closed")) {
      clearReadyWatch();
      const code = parseGatewayCloseCode(message);
      params.pushStatus({
        connected: false,
        lastEventAt: at,
        lastDisconnect: {
          at,
          ...(code !== undefined ? { status: code } : {}),
        },
      });
      return;
    }
    if (message.includes("Gateway reconnect scheduled in")) {
      clearReadyWatch();
      params.pushStatus({
        connected: false,
        lastEventAt: at,
        lastError: message,
      });
    }
  };

  return {
    onGatewayDebug,
    clearReadyWatch,
    registerForceStop: (handler: (err: unknown) => void) => {
      forceStopHandler = handler;
      if (queuedForceStopError !== undefined) {
        const err = queuedForceStopError;
        queuedForceStopError = undefined;
        handler(err);
      }
    },
    dispose: () => {
      clearReadyWatch();
      forceStopHandler = undefined;
      queuedForceStopError = undefined;
    },
  };
}

async function waitForGatewayReady(params: {
  gateway?: Pick<MutableDiscordGateway, "connect" | "disconnect" | "isConnected" | "ws">;
  abortSignal?: AbortSignal;
  beforePoll?: () => Promise<"continue" | "stop"> | "continue" | "stop";
  pushStatus?: (patch: Parameters<DiscordMonitorStatusSink>[0]) => void;
  runtime: RuntimeEnv;
  beforeRestart?: () => Promise<void> | void;
}): Promise<void> {
  const waitUntilReady = async (): Promise<GatewayReadyWaitResult> => {
    const deadlineAt = Date.now() + DISCORD_GATEWAY_READY_TIMEOUT_MS;
    while (!params.abortSignal?.aborted) {
      if ((await params.beforePoll?.()) === "stop") {
        return "stopped";
      }
      if (params.gateway?.isConnected === true) {
        const at = Date.now();
        params.pushStatus?.({
          ...createConnectedChannelStatusPatch(at),
          lastDisconnect: null,
          lastError: null,
        });
        return "ready";
      }
      if (Date.now() >= deadlineAt) {
        return "timeout";
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, DISCORD_GATEWAY_READY_POLL_MS);
        timeout.unref?.();
      });
    }
    return "stopped";
  };

  const firstAttempt = await waitUntilReady();
  if (firstAttempt !== "timeout") {
    return;
  }
  if (!params.gateway) {
    throw new Error(
      `discord gateway did not reach READY within ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms`,
    );
  }

  const restartAt = Date.now();
  params.runtime.error?.(
    danger(
      `discord: gateway was not ready after ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms; restarting gateway`,
    ),
  );
  params.pushStatus?.({
    connected: false,
    lastEventAt: restartAt,
    lastDisconnect: {
      at: restartAt,
      error: "startup-not-ready",
    },
    lastError: "startup-not-ready",
  });
  if (params.abortSignal?.aborted) {
    return;
  }
  await params.beforeRestart?.();
  await restartGatewayAfterReadyTimeout({
    gateway: params.gateway,
    abortSignal: params.abortSignal,
    runtime: params.runtime,
  });

  if ((await waitUntilReady()) === "timeout") {
    throw new Error(
      `discord gateway did not reach READY within ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms after restart`,
    );
  }
}

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
  gateway?: MutableDiscordGateway;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  isDisallowedIntentsError: (err: unknown) => boolean;
  voiceManager: DiscordVoiceManager | null;
  voiceManagerRef: { current: DiscordVoiceManager | null };
  threadBindings: { stop: () => void };
  gatewaySupervisor: DiscordGatewaySupervisor;
  statusSink?: DiscordMonitorStatusSink;
}) {
  const gateway = params.gateway;
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = params.gatewaySupervisor.emitter ?? getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime,
  });
  let lifecycleStopping = false;

  const pushStatus = (patch: Parameters<DiscordMonitorStatusSink>[0]) => {
    params.statusSink?.(patch);
  };
  const statusObserver = createGatewayStatusObserver({
    gateway,
    abortSignal: params.abortSignal,
    runtime: params.runtime,
    pushStatus,
    isLifecycleStopping: () => lifecycleStopping,
  });
  gatewayEmitter?.on("debug", statusObserver.onGatewayDebug);
  let lastTransportActivityStatusAt: number | undefined;
  const onGatewayTransportActivity = (event: unknown) => {
    if (lifecycleStopping || params.abortSignal?.aborted) {
      return;
    }
    const at = resolveTransportActivityAt(event);
    if (
      lastTransportActivityStatusAt !== undefined &&
      at - lastTransportActivityStatusAt < DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastTransportActivityStatusAt = at;
    pushStatus(createTransportActivityStatusPatch(at));
  };
  gatewayEmitter?.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, onGatewayTransportActivity);

  let sawDisallowedIntents = false;
  const handleGatewayEvent = (event: DiscordGatewayEvent): "continue" | "stop" => {
    if (event.type === "disallowed-intents") {
      lifecycleStopping = true;
      sawDisallowedIntents = true;
      params.runtime.error?.(
        danger(
          "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config.",
        ),
      );
      return "stop";
    }
    if (event.shouldStopLifecycle) {
      lifecycleStopping = true;
    }
    params.runtime.error?.(
      danger(
        event.shouldStopLifecycle
          ? `discord gateway ${event.type}: ${event.message}`
          : `discord gateway error: ${event.message}`,
      ),
    );
    return event.shouldStopLifecycle ? "stop" : "continue";
  };
  const drainPendingGatewayErrors = (): "continue" | "stop" =>
    params.gatewaySupervisor.drainPending((event) => {
      const decision = handleGatewayEvent(event);
      if (decision !== "stop") {
        return "continue";
      }
      if (event.type === "disallowed-intents") {
        return "stop";
      }
      throw new DiscordGatewayLifecycleError(event);
    });
  try {
    // Drain gateway errors emitted before lifecycle listeners were attached.
    if (drainPendingGatewayErrors() === "stop") {
      return;
    }

    await waitForGatewayReady({
      gateway,
      abortSignal: params.abortSignal,
      beforePoll: drainPendingGatewayErrors,
      pushStatus,
      runtime: params.runtime,
      beforeRestart: statusObserver.clearReadyWatch,
    });

    if (drainPendingGatewayErrors() === "stop") {
      return;
    }

    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal: params.abortSignal,
      gatewaySupervisor: params.gatewaySupervisor,
      onGatewayEvent: handleGatewayEvent,
      registerForceStop: statusObserver.registerForceStop,
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    lifecycleStopping = true;
    params.gatewaySupervisor.detachLifecycle();
    unregisterGateway(params.accountId);
    stopGatewayLogging();
    statusObserver.dispose();
    gatewayEmitter?.removeListener("debug", statusObserver.onGatewayDebug);
    gatewayEmitter?.removeListener(
      DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT,
      onGatewayTransportActivity,
    );
    if (params.voiceManager) {
      await params.voiceManager.destroy();
      params.voiceManagerRef.current = null;
    }
    params.threadBindings.stop();
  }
}
