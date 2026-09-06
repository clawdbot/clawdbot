import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { ControlUiAction, ControlUiSession } from "../../../src/plugin-sdk/control-ui.js";
import type { PluginSessionMenuAction } from "../components/session-menu.ts";
import type { ControlUiPluginCapability } from "./control-ui-capability.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

export function pluginSessionMenuActions(
  runtime: ControlUiPluginCapability,
  session: ControlUiSession,
): PluginSessionMenuAction[] {
  return runtime
    .registrations("actions")
    .filter((entry) => entry.value.placement === "session")
    .flatMap((entry) => {
      try {
        const state = entry.value.resolve?.({
          sessionKey: session.key,
          agentId: session.agentId,
          session: structuredClone(session),
        });
        return state?.hidden
          ? []
          : [
              {
                id: entry.key,
                label: state?.label ?? entry.value.label,
                disabled: state?.disabled,
              },
            ];
      } catch (error) {
        runtime.reportError(entry.pluginId, error);
        return [];
      }
    });
}

export async function runControlUiPluginAction(
  params: BoardGetParams & {
    runtime: ControlUiPluginCapability;
    id: string;
    placement: ControlUiAction["placement"];
    session?: ControlUiSession;
    signal: AbortSignal;
  },
): Promise<void> {
  const retry =
    params.placement === "session"
      ? "Reopen the session menu."
      : "Try again from the current view.";
  if (params.placement === "session" && !params.session) {
    throw new Error(`This session is no longer available. ${retry}`);
  }
  const entry = params.runtime
    .registrations("actions")
    .find(
      (candidate) => candidate.key === params.id && candidate.value.placement === params.placement,
    );
  if (!entry) {
    throw new Error(`This plugin action is no longer active. ${retry}`);
  }
  const signal = AbortSignal.any([params.signal, entry.signal]);
  signal.throwIfAborted();
  const context = {
    sessionKey: params.sessionKey,
    agentId: params.agentId ?? params.session?.agentId,
    session: params.session ? structuredClone(params.session) : undefined,
  };
  const state = entry.value.resolve?.(context);
  // A resolver can synchronously withdraw its own registration.
  signal.throwIfAborted();
  if (state?.hidden || state?.disabled) {
    throw new Error(`This plugin action is currently unavailable. ${retry}`);
  }
  await entry.value.run({
    ...context,
    host: scopeControlUiHost(entry.host, signal),
    signal,
  });
  signal.throwIfAborted();
}
