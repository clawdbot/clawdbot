import type { AnyAgentTool } from "../agents/tools/common.js";
import type { NormalizedPluginsConfig } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolveDelegatedAuthForPlugin } from "./tool-delegated-auth-policy.js";
import {
  bindPluginToolExecutionAuth,
  createExecutionScopedPluginAuthContext,
} from "./tool-execution-auth.js";
import type { OpenClawPluginAuthContext, OpenClawPluginToolContext } from "./tool-types.js";

export type PluginToolDelegatedAuth = {
  executionAuth: OpenClawPluginAuthContext | undefined;
  factoryAuth: OpenClawPluginAuthContext | undefined;
  factoryContext: OpenClawPluginToolContext;
};

function withPluginDelegatedAuthContext(
  context: OpenClawPluginToolContext,
  auth: OpenClawPluginAuthContext | undefined,
): OpenClawPluginToolContext {
  if (auth) {
    return { ...context, auth };
  }
  const { auth: _auth, ...contextWithoutAuth } = context;
  return contextWithoutAuth;
}

export function isPluginToolFactoryEffectivelyOptional(params: {
  entryOptional: boolean;
  manifestPlugin: PluginManifestRecord | undefined;
  toolNames: readonly string[];
}): boolean {
  return (
    params.entryOptional ||
    Boolean(
      params.manifestPlugin &&
      params.toolNames.length > 0 &&
      params.toolNames.every(
        (toolName) => params.manifestPlugin?.toolMetadata?.[toolName]?.optional === true,
      ),
    )
  );
}

export function resolvePluginToolDelegatedAuth(params: {
  context: OpenClawPluginToolContext;
  pluginId: string;
  allowed: boolean;
  plugins: NormalizedPluginsConfig;
}): PluginToolDelegatedAuth {
  const executionAuth = resolveDelegatedAuthForPlugin({
    auth: params.context.auth,
    chatType: params.context.chatType,
    pluginId: params.pluginId,
    plugins: params.plugins,
  });
  const factoryAuth =
    executionAuth && params.allowed
      ? createExecutionScopedPluginAuthContext(params.pluginId)
      : undefined;
  return {
    executionAuth: factoryAuth ? executionAuth : undefined,
    factoryAuth,
    factoryContext: withPluginDelegatedAuthContext(params.context, factoryAuth),
  };
}

export function bindPluginToolDelegatedAuth(params: {
  tool: AnyAgentTool;
  pluginId: string;
  delegatedAuth: PluginToolDelegatedAuth;
}): AnyAgentTool {
  return params.delegatedAuth.factoryAuth
    ? bindPluginToolExecutionAuth({
        tool: params.tool,
        pluginId: params.pluginId,
        auth: params.delegatedAuth.executionAuth,
      })
    : params.tool;
}

export function recordPluginDescriptorFactoryAuth(
  state: Map<string, boolean>,
  pluginId: string,
  enabled: boolean,
): void {
  state.set(pluginId, (state.get(pluginId) ?? false) || enabled);
}
