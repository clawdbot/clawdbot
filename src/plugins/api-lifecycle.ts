/** Tracks plugin API lifecycle callbacks registered during runtime activation. */
import type { OpenClawPluginApi } from "./types.js";

type FunctionPropertyNames<T> = Extract<
  {
    [K in keyof T]-?: Exclude<T[K], undefined> extends (...args: unknown[]) => unknown ? K : never;
  }[keyof T],
  string
>;

/** Names of plugin API methods exposed on the OpenClaw plugin API. */
type PluginApiMethodName = FunctionPropertyNames<OpenClawPluginApi>;

/** Lifecycle policy for whether a plugin API method can be called after registration. */
type PluginApiLifecyclePolicy = {
  phase: "registration" | "runtime";
  lateCallable: boolean;
};

const PLUGIN_API_METHOD_POLICIES: Partial<Record<PluginApiMethodName, PluginApiLifecyclePolicy>> = {
  emitAgentEvent: { phase: "runtime", lateCallable: true },
  enqueueNextTurnInjection: { phase: "runtime", lateCallable: true },
  sendSessionAttachment: { phase: "runtime", lateCallable: true },
  scheduleSessionTurn: { phase: "runtime", lateCallable: true },
  unscheduleSessionTurnsByTag: { phase: "runtime", lateCallable: true },
};

/** Returns lifecycle policy for one plugin API method name. */
function getPluginApiMethodLifecyclePolicy(
  methodName: string,
): PluginApiLifecyclePolicy | undefined {
  return PLUGIN_API_METHOD_POLICIES[methodName as PluginApiMethodName];
}

/** True when a plugin API method remains callable after registration. */
export function isLateCallablePluginApiMethod(
  methodName: string,
): methodName is PluginApiMethodName {
  return getPluginApiMethodLifecyclePolicy(methodName)?.lateCallable === true;
}
