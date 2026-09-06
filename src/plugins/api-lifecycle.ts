import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { attachPluginApiFacades } from "./api-facades.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "./types.js";

const LATE_CALLABLE_PLUGIN_API_METHODS: ReadonlySet<string> = new Set<keyof OpenClawPluginApi>([
  "clearRunContext",
  "emitAgentEvent",
  "enqueueNextTurnInjection",
  "getRunContext",
  "sendSessionAttachment",
  "scheduleSessionTurn",
  "setRunContext",
  "unscheduleSessionTurnsByTag",
]);

function createGuardedPluginRegistrationApi(api: OpenClawPluginApi): {
  api: OpenClawPluginApi;
  close: () => void;
} {
  let closed = false;
  const guardedApi = attachPluginApiFacades(
    new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        if (typeof prop === "string" && LATE_CALLABLE_PLUGIN_API_METHODS.has(prop)) {
          return (...args: unknown[]) => Reflect.apply(value, target, args);
        }
        return (...args: unknown[]) => {
          if (closed) {
            return undefined;
          }
          return Reflect.apply(value, target, args);
        };
      },
    }),
  );
  return {
    api: guardedApi,
    close: () => {
      closed = true;
    },
  };
}

export function runPluginRegistration(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
  asyncResult: "reject" | "ignore" = "reject",
): void {
  const guarded = createGuardedPluginRegistrationApi(api);
  try {
    const result = register(guarded.api);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      if (asyncResult === "reject") {
        throw new Error("plugin register must be synchronous");
      }
    }
  } finally {
    guarded.close();
  }
}
