import type { OpenClawPluginApi } from "./types.js";

type FunctionPropertyNames<T> = Extract<
  {
    [K in keyof T]-?: Exclude<T[K], undefined> extends (...args: unknown[]) => unknown ? K : never;
  }[keyof T],
  string
>;

export type PluginApiMethodName = FunctionPropertyNames<OpenClawPluginApi>;

export type PluginApiLifecyclePolicy = {
  phase: "registration" | "runtime";
  lateCallable: boolean;
};

const PLUGIN_API_METHOD_POLICIES: Partial<Record<PluginApiMethodName, PluginApiLifecyclePolicy>> = {
  emitAgentEvent: { phase: "runtime", lateCallable: true },
  sendSessionAttachment: { phase: "runtime", lateCallable: true },
  scheduleSessionTurn: { phase: "runtime", lateCallable: true },
  unscheduleSessionTurnsByTag: { phase: "runtime", lateCallable: true },
};

export function getPluginApiMethodLifecyclePolicy(
  methodName: string,
): PluginApiLifecyclePolicy | undefined {
  return PLUGIN_API_METHOD_POLICIES[methodName as PluginApiMethodName];
}

export function isLateCallablePluginApiMethod(
  methodName: string,
): methodName is PluginApiMethodName {
  return getPluginApiMethodLifecyclePolicy(methodName)?.lateCallable === true;
}
