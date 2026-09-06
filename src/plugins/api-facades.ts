import { pluginInstanceState, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import type { OpenClawPluginApi } from "./types.js";

type PluginApiFacadeFields = Pick<
  OpenClawPluginApi,
  "agent" | "lifecycle" | "runContext" | "session"
>;
/** Plugin API shape without nested facade namespaces attached. */
export type OpenClawPluginApiWithoutFacades = Omit<OpenClawPluginApi, keyof PluginApiFacadeFields>;
type PluginApiFacadeSource = Pick<
  OpenClawPluginApi,
  | "clearRunContext"
  | "emitAgentEvent"
  | "enqueueNextTurnInjection"
  | "getRunContext"
  | "registerAgentEventSubscription"
  | "registerControlUiDescriptor"
  | "registerRuntimeLifecycle"
  | "registerSessionAction"
  | "registerSessionExtension"
  | "registerSessionSchedulerJob"
  | "scheduleSessionTurn"
  | "sendSessionAttachment"
  | "setRunContext"
  | "unscheduleSessionTurnsByTag"
>;

/** Attaches nested facade namespaces to the flat plugin API implementation. */
export function attachPluginApiFacades<T extends object>(
  api: T & PluginApiFacadeSource & Partial<PluginApiFacadeFields>,
): T & PluginApiFacadeFields {
  api.session = {
    state: {
      registerSessionExtension: (...args) => api.registerSessionExtension(...args),
    },
    workflow: {
      enqueueNextTurnInjection: (...args) => api.enqueueNextTurnInjection(...args),
      registerSessionSchedulerJob: (...args) => api.registerSessionSchedulerJob(...args),
      sendSessionAttachment: (...args) => api.sendSessionAttachment(...args),
      scheduleSessionTurn: (...args) => api.scheduleSessionTurn(...args),
      unscheduleSessionTurnsByTag: (...args) => api.unscheduleSessionTurnsByTag(...args),
    },
    controls: {
      registerSessionAction: (...args) => api.registerSessionAction(...args),
      registerControlUiDescriptor: (...args) => api.registerControlUiDescriptor(...args),
    },
  };
  api.agent = {
    events: {
      registerAgentEventSubscription: (...args) => api.registerAgentEventSubscription(...args),
      emitAgentEvent: (...args) => api.emitAgentEvent(...args),
    },
  };
  api.runContext = {
    setRunContext: (...args) => api.setRunContext(...args),
    getRunContext: (...args) => api.getRunContext(...args),
    clearRunContext: (...args) => api.clearRunContext(...args),
  };
  api.lifecycle = {
    ...api.lifecycle,
    registerRuntimeLifecycle: (...args) => api.registerRuntimeLifecycle(...args),
  };
  return api as T & PluginApiFacadeFields;
}

/** Registration callbacks and their API retain the exact admitted instance. */
export function instrumentPluginInstanceApi(
  api: OpenClawPluginApi,
  instance?: PluginInstanceHandle,
): OpenClawPluginApi {
  if (!instance) {
    return api;
  }
  api.lifecycle = { ...api.lifecycle, ...instance.lifecycle };
  const instrumented = attachPluginApiFacades(
    new Proxy(api, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (
          typeof value !== "function" ||
          typeof key !== "string" ||
          (!key.startsWith("register") && key !== "on" && key !== "onConversationBindingResolved")
        ) {
          return value;
        }
        return (...args: unknown[]) =>
          instance.run(() =>
            Reflect.apply(
              value,
              target,
              args.map((arg) => instance.wrap(arg)),
            ),
          );
      },
    }),
  );
  pluginInstanceState.values.set(instrumented, instance);
  return instrumented;
}
