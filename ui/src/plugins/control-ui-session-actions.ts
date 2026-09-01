import type { ControlUiSession } from "../../../src/plugin-sdk/control-ui.js";
import type { PluginSessionMenuAction } from "../components/session-menu.ts";
import type { ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

export function pluginSessionMenuActions(
  runtime: ControlUiPluginRuntime,
  session: ControlUiSession,
): PluginSessionMenuAction[] {
  return runtime
    .registrations("actions")
    .filter((entry) => entry.value.placement === "session")
    .flatMap((entry) => {
      try {
        const state = entry.value.resolve?.({
          sessionKey: session.key,
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

export async function runPluginSessionMenuAction(params: {
  runtime: ControlUiPluginRuntime;
  id: string;
  session: ControlUiSession;
  signal: AbortSignal;
}): Promise<void> {
  const entry = params.runtime
    .registrations("actions")
    .find((candidate) => candidate.key === params.id && candidate.value.placement === "session");
  if (!entry) {
    throw new Error("This plugin action is no longer active. Reopen the session menu.");
  }
  const signal = AbortSignal.any([params.signal, entry.signal]);
  signal.throwIfAborted();
  const session = structuredClone(params.session);
  const state = entry.value.resolve?.({ sessionKey: session.key, session });
  if (state?.hidden || state?.disabled) {
    throw new Error("This plugin action is currently unavailable. Reopen the session menu.");
  }
  await entry.value.run({
    sessionKey: params.session.key,
    session,
    host: scopeControlUiHost(entry.host, signal),
    signal,
  });
  signal.throwIfAborted();
}
