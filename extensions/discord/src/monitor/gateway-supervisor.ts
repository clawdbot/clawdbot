import type { EventEmitter } from "node:events";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

export type DiscordGatewayEventType =
  | "disallowed-intents"
  | "fatal"
  | "other"
  | "reconnect-exhausted";

export type DiscordGatewayEvent = {
  type: DiscordGatewayEventType;
  err: unknown;
  message: string;
  shouldStopLifecycle: boolean;
};

export class DiscordGatewayLifecycleError extends Error {
  readonly eventType: DiscordGatewayEventType;

  constructor(event: Pick<DiscordGatewayEvent, "type" | "message" | "err">) {
    super(`discord gateway ${event.type}: ${event.message}`, {
      cause: event.err instanceof Error ? event.err : undefined,
    });
    this.name = "DiscordGatewayLifecycleError";
    this.eventType = event.type;
  }
}

export function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined {
  return (gateway as { emitter?: EventEmitter } | undefined)?.emitter;
}

export type DiscordGatewaySupervisor = {
  emitter?: EventEmitter;
  attachLifecycle: (handler: (event: DiscordGatewayEvent) => void) => void;
  detachLifecycle: () => void;
  drainPending: (
    handler: (event: DiscordGatewayEvent) => "continue" | "stop",
  ) => "continue" | "stop";
  dispose: () => void;
};

type GatewaySupervisorPhase = "active" | "buffering" | "disposed" | "teardown";

function readFirstStackFrame(err: Error): string | undefined {
  const stack = err.stack;
  if (!stack) {
    return undefined;
  }
  const frame = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find(Boolean);
  return frame ? frame.replace(/^at\s+/, "") : undefined;
}

function formatDiscordGatewayErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return formatErrorMessage(err);
  }
  if (err.message) {
    const detail = formatErrorMessage(err);
    return err.name ? `${err.name}: ${detail}` : detail;
  }
  const detail = formatErrorMessage(err);
  const firstFrame = readFirstStackFrame(err);
  if (firstFrame && detail === (err.name || "Error")) {
    return `${detail} @ ${firstFrame}`;
  }
  return detail;
}

export function classifyDiscordGatewayEvent(params: {
  err: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
}): DiscordGatewayEvent {
  const message = formatDiscordGatewayErrorMessage(params.err);
  if (params.isDisallowedIntentsError(params.err)) {
    return {
      type: "disallowed-intents",
      err: params.err,
      message,
      shouldStopLifecycle: true,
    };
  }
  if (message.includes("Max reconnect attempts")) {
    return {
      type: "reconnect-exhausted",
      err: params.err,
      message,
      shouldStopLifecycle: true,
    };
  }
  if (
    params.err instanceof TypeError ||
    message.includes("Fatal Gateway error") ||
    message.includes("Fatal gateway close code") ||
    message.includes("Gateway HELLO missing heartbeat") ||
    message.includes("Invalid gateway payload") ||
    message.includes("Gateway socket emitted an unknown error")
  ) {
    return {
      type: "fatal",
      err: params.err,
      message,
      shouldStopLifecycle: true,
    };
  }
  return {
    type: "other",
    err: params.err,
    message,
    shouldStopLifecycle: false,
  };
}

export function createDiscordGatewaySupervisor(params: {
  gateway?: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
  runtime: RuntimeEnv;
}): DiscordGatewaySupervisor {
  const emitter = getDiscordGatewayEmitter(params.gateway);
  const pending: DiscordGatewayEvent[] = [];
  if (!emitter) {
    return {
      attachLifecycle: () => {},
      detachLifecycle: () => {},
      drainPending: () => "continue",
      dispose: () => {},
      emitter,
    };
  }

  let lifecycleHandler: ((event: DiscordGatewayEvent) => void) | undefined;
  let phase: GatewaySupervisorPhase = "buffering";
  const seenLateEventKeys = new Set<string>();
  const logLateEvent =
    (state: Extract<GatewaySupervisorPhase, "disposed" | "teardown">) =>
    (event: DiscordGatewayEvent) => {
      const key = `${state}:${event.type}:${event.message}`;
      if (seenLateEventKeys.has(key)) {
        return;
      }
      seenLateEventKeys.add(key);
      params.runtime.error?.(
        danger(
          `discord: suppressed late gateway ${event.type} error ${
            state === "disposed" ? "after dispose" : "during teardown"
          }: ${event.message}`,
        ),
      );
    };
  const onGatewayError = (err: unknown) => {
    const event = classifyDiscordGatewayEvent({
      err,
      isDisallowedIntentsError: params.isDisallowedIntentsError,
    });
    switch (phase) {
      case "disposed":
        logLateEvent("disposed")(event);
        return;
      case "active":
        lifecycleHandler?.(event);
        return;
      case "teardown":
        logLateEvent("teardown")(event);
        return;
      case "buffering":
        pending.push(event);
        return;
    }
  };
  emitter.on("error", onGatewayError);

  return {
    emitter,
    attachLifecycle: (handler) => {
      lifecycleHandler = handler;
      phase = "active";
    },
    detachLifecycle: () => {
      lifecycleHandler = undefined;
      phase = "teardown";
    },
    drainPending: (handler) => {
      if (pending.length === 0) {
        return "continue";
      }
      const queued = [...pending];
      pending.length = 0;
      for (const event of queued) {
        if (handler(event) === "stop") {
          return "stop";
        }
      }
      return "continue";
    },
    dispose: () => {
      if (phase === "disposed") {
        return;
      }
      lifecycleHandler = undefined;
      phase = "disposed";
      pending.length = 0;
    },
  };
}
