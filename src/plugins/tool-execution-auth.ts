import { AsyncLocalStorage } from "node:async_hooks";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawPluginAuthContext } from "./tool-types.js";

type PluginToolExecutionAuthStore = {
  delegatedAuthByPluginId: Map<string, PluginToolExecutionAuthBinding>;
};

type PluginToolExecutionAuthBinding = {
  active: boolean;
  auth: OpenClawPluginAuthContext | undefined;
};

const executionAuthStorage = new AsyncLocalStorage<PluginToolExecutionAuthStore>();
const log = createSubsystemLogger("plugins/tools");

function createStoreForPlugin(params: {
  pluginId: string;
  binding: PluginToolExecutionAuthBinding;
}): PluginToolExecutionAuthStore {
  const inherited = executionAuthStorage.getStore()?.delegatedAuthByPluginId;
  const delegatedAuthByPluginId = inherited ? new Map(inherited) : new Map();
  delegatedAuthByPluginId.set(params.pluginId, params.binding);
  return { delegatedAuthByPluginId };
}

export function createExecutionScopedPluginAuthContext(
  pluginId: string,
): OpenClawPluginAuthContext {
  return {
    getDelegatedAccessToken: async (request) => {
      const binding = executionAuthStorage.getStore()?.delegatedAuthByPluginId.get(pluginId);
      if (!binding?.active || !binding.auth) {
        log.debug?.("plugin delegated auth unavailable outside active tool execution", {
          pluginId,
          provider: request.provider,
          hasAudience: Boolean(request.audience?.trim()),
          scopeCount: request.scopes?.filter((scope) => scope.trim()).length ?? 0,
          hasBinding: Boolean(binding),
          active: binding?.active === true,
          hasAuth: Boolean(binding?.auth),
        });
        return { ok: false, reason: "unavailable" };
      }
      return binding.auth.getDelegatedAccessToken(request);
    },
  };
}

export function bindPluginToolExecutionAuth(params: {
  tool: AnyAgentTool;
  pluginId: string;
  auth: OpenClawPluginAuthContext | undefined;
}): AnyAgentTool {
  const boundExecute = async (
    toolCallId: string,
    toolParams: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => {
    const binding: PluginToolExecutionAuthBinding = {
      active: true,
      auth: params.auth,
    };
    try {
      return await executionAuthStorage.run(
        createStoreForPlugin({
          pluginId: params.pluginId,
          binding,
        }),
        () =>
          Reflect.apply(params.tool.execute, params.tool, [
            toolCallId,
            toolParams,
            signal,
            onUpdate,
          ]) as ReturnType<AnyAgentTool["execute"]>,
      );
    } finally {
      binding.active = false;
    }
  };
  return new Proxy(params.tool, {
    get(target, prop) {
      return prop === "execute" ? boundExecute : Reflect.get(target, prop, target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === "execute") {
        return {
          configurable: true,
          enumerable: Object.prototype.propertyIsEnumerable.call(target, prop),
          value: boundExecute,
          writable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}
