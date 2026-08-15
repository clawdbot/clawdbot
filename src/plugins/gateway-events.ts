import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSet } from "../shared/global-singleton.js";
import type { PluginJsonValue } from "./host-hook-json.js";

const log = createSubsystemLogger("plugins");

export type OpenClawPluginGatewayEventScope = "operator.read" | "operator.write" | "operator.admin";

export type OpenClawPluginSessionsChangedEvent = {
  sessionKey: string;
  agentId?: string;
  label?: string;
  displayName?: string;
  reason?: string;
  phase?: string;
};

type SessionsChangedHandler = (event: OpenClawPluginSessionsChangedEvent) => unknown;

const sessionsChangedHandlers = resolveGlobalSet<SessionsChangedHandler>(
  Symbol.for("openclaw.pluginSessionsChangedHandlers"),
  "plugin-registry",
);

export type OpenClawPluginGatewayEvents = {
  emit: (
    event: string,
    payload: PluginJsonValue,
    opts: { scope: OpenClawPluginGatewayEventScope },
  ) => void;
  /**
   * Native plugins can already read full session entries through the injected runtime;
   * this notice only avoids polling and does not widen session access.
   */
  onSessionsChanged: (handler: (event: OpenClawPluginSessionsChangedEvent) => void) => () => void;
};

export function subscribePluginSessionsChanged(
  handler: (event: OpenClawPluginSessionsChangedEvent) => void,
): () => void {
  const subscription: SessionsChangedHandler = (event) => handler(event);
  sessionsChangedHandlers.add(subscription);
  return () => {
    sessionsChangedHandlers.delete(subscription);
  };
}

export function hasPluginSessionsChangedSubscribers(): boolean {
  return sessionsChangedHandlers.size > 0;
}

export function queuePluginSessionsChanged(payload: unknown): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }
  const source = payload as Record<string, unknown>;
  if (typeof source.sessionKey !== "string" || source.sessionKey.length === 0) {
    return;
  }
  if (sessionsChangedHandlers.size === 0) {
    return;
  }
  const subscriptions = [...sessionsChangedHandlers];
  const event: OpenClawPluginSessionsChangedEvent = {
    sessionKey: source.sessionKey,
    ...(typeof source.agentId === "string" ? { agentId: source.agentId } : {}),
    ...(typeof source.label === "string" ? { label: source.label } : {}),
    ...(typeof source.displayName === "string" ? { displayName: source.displayName } : {}),
    ...(typeof source.reason === "string" ? { reason: source.reason } : {}),
    ...(typeof source.phase === "string" ? { phase: source.phase } : {}),
  };
  queueMicrotask(() => {
    for (const handler of subscriptions) {
      if (!sessionsChangedHandlers.has(handler)) {
        continue;
      }
      try {
        const result = handler(event);
        void Promise.resolve(result).catch((error: unknown) => {
          log.warn(`plugin sessions.changed handler failed: ${String(error)}`);
        });
      } catch (error) {
        log.warn(`plugin sessions.changed handler failed: ${String(error)}`);
      }
    }
  });
}
