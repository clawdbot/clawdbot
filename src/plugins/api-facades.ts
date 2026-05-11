import type { OpenClawPluginApi } from "./types.js";

type PluginApiFacadeFields = Pick<
  OpenClawPluginApi,
  "agent" | "lifecycle" | "runContext" | "session"
>;
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
    registerRuntimeLifecycle: (...args) => api.registerRuntimeLifecycle(...args),
  };
  return api as T & PluginApiFacadeFields;
}
