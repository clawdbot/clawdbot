import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type EventEmitterLike = {
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
};

export function cleanupDiscordProviderStartup(params: {
  deactivateMessageHandler?: () => void;
  autoPresenceController?: { stop: () => void } | null;
  setStatus?: DiscordMonitorStatusSink;
  onEarlyGatewayDebug?: ((msg: unknown) => void) | undefined;
  earlyGatewayEmitter?: EventEmitterLike | undefined;
  lifecycleStarted: boolean;
  lifecycleGateway?: MutableDiscordGateway;
  gatewaySupervisor?: { dispose: () => void };
  threadBindings: ThreadBindingManager;
  runtime: RuntimeEnv;
}) {
  params.deactivateMessageHandler?.();
  params.autoPresenceController?.stop();
  params.setStatus?.({ connected: false });
  if (params.onEarlyGatewayDebug) {
    params.earlyGatewayEmitter?.removeListener("debug", params.onEarlyGatewayDebug);
  }
  if (!params.lifecycleStarted) {
    try {
      params.lifecycleGateway?.disconnect();
    } catch (err) {
      params.runtime.error?.(
        danger(`discord: failed to disconnect gateway during startup cleanup: ${String(err)}`),
      );
    }
  }
  params.gatewaySupervisor?.dispose();
  if (!params.lifecycleStarted) {
    params.threadBindings.stop();
  }
}
