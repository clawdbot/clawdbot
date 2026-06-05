/**
 * Channel message action discovery.
 *
 * Builds agent tool schema contributions from loaded or bundled channel action hooks.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getChannelPlugin, getLoadedChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import {
  resolveBundledChannelMessageToolDiscoveryAdapter,
  type ChannelMessageToolDiscoveryAdapter,
} from "./message-tool-api.js";
import type {
  ChannelMessageActionDiscoveryContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "./types.public.js";

/**
 * Input used to discover channel message actions for agent tool schemas.
 */
export type ChannelMessageActionDiscoveryInput = {
  cfg?: OpenClawConfig;
  channel?: string | null;
  currentChannelProvider?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
};

type ChannelMessageActionDiscoveryParams = ChannelMessageActionDiscoveryInput & {
  cfg: OpenClawConfig;
};

type ChannelMessageToolMediaSourceParamKeyInput = ChannelMessageActionDiscoveryParams & {
  action?: ChannelMessageActionName;
};

const loggedMessageActionErrors = new Set<string>();

/**
 * Normalizes a raw channel/provider id before consulting action discovery hooks.
 */
export function resolveMessageActionDiscoveryChannelId(raw?: string | null): string | undefined {
  return normalizeAnyChannelId(raw) ?? normalizeOptionalString(raw);
}

/**
 * Builds the context object passed to plugin message-tool discovery hooks.
 */
export function createMessageActionDiscoveryContext(
  params: ChannelMessageActionDiscoveryInput,
): ChannelMessageActionDiscoveryContext {
  const currentChannelProvider = resolveMessageActionDiscoveryChannelId(
    params.channel ?? params.currentChannelProvider,
  );
  return {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    currentChannelId: params.currentChannelId,
    currentChannelProvider,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
  };
}

function logMessageActionError(params: {
  pluginId: string;
  operation: "describeMessageTool";
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.operation}:${message}`;
  // Discovery runs while building tool schemas, so log each plugin/error pair
  // once and let the agent continue with the remaining channel capabilities.
  if (loggedMessageActionErrors.has(key)) {
    return;
  }
  loggedMessageActionErrors.add(key);
  const stack = params.error instanceof Error && params.error.stack ? params.error.stack : null;
  defaultRuntime.error?.(
    `[message-action-discovery] ${params.pluginId}.actions.${params.operation} failed: ${stack ?? message}`,
  );
}

function describeMessageToolSafely(params: {
  pluginId: string;
  context: ChannelMessageActionDiscoveryContext;
  describeMessageTool: NonNullable<ChannelMessageToolDiscoveryAdapter["describeMessageTool"]>;
}): ChannelMessageToolDiscovery | null {
  try {
    return params.describeMessageTool(params.context) ?? null;
  } catch (error) {
    logMessageActionError({
      pluginId: params.pluginId,
      operation: "describeMessageTool",
      error,
    });
    return null;
  }
}

/**
 * Normalizes plugin schema contributions into a list for merge callers.
 */
function normalizeToolSchemaContributions(
  value:
    | ChannelMessageToolSchemaContribution
    | ChannelMessageToolSchemaContribution[]
    | null
    | undefined,
): ChannelMessageToolSchemaContribution[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

type ResolvedChannelMessageActionDiscovery = {
  actions: ChannelMessageActionName[];
  capabilities: readonly ChannelMessageCapability[];
  schemaContributions: ChannelMessageToolSchemaContribution[];
  mediaSourceParams: readonly string[];
};

type MessageToolMediaSourceParamMap = Partial<Record<ChannelMessageActionName, readonly string[]>>;

/**
 * Resolves media-source parameter names, optionally scoped to one action.
 */
function normalizeMessageToolMediaSourceParams(
  mediaSourceParams: ChannelMessageToolDiscovery["mediaSourceParams"],
  action?: ChannelMessageActionName,
): readonly string[] {
  if (Array.isArray(mediaSourceParams)) {
    return mediaSourceParams;
  }
  if (!mediaSourceParams || typeof mediaSourceParams !== "object") {
    return [];
  }
  const scopedMediaSourceParams = mediaSourceParams as MessageToolMediaSourceParamMap;
  if (action) {
    const scoped = scopedMediaSourceParams[action];
    return Array.isArray(scoped) ? scoped : [];
  }
  return Object.values(scopedMediaSourceParams).flatMap((scoped) =>
    Array.isArray(scoped) ? scoped : [],
  );
}

/**
 * Finds the lightest available message-tool discovery adapter for one channel.
 */
export function resolveCurrentChannelMessageToolDiscoveryAdapter(channel?: string | null): {
  pluginId: string;
  actions: ChannelMessageToolDiscoveryAdapter;
} | null {
  const channelId = resolveMessageActionDiscoveryChannelId(channel);
  if (!channelId) {
    return null;
  }
  const loadedPlugin = getLoadedChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (loadedPlugin?.actions) {
    return {
      pluginId: loadedPlugin.id,
      actions: loadedPlugin.actions,
    };
  }
  // Prefer the bundled public artifact before full plugin materialization so
  // schema construction stays cheap on hot agent/tool paths.
  const bundledActions = resolveBundledChannelMessageToolDiscoveryAdapter(channelId);
  if (bundledActions) {
    return {
      pluginId: channelId,
      actions: bundledActions,
    };
  }
  const plugin = getChannelPlugin(channelId as Parameters<typeof getChannelPlugin>[0]);
  if (!plugin?.actions) {
    return null;
  }
  return {
    pluginId: plugin.id,
    actions: plugin.actions,
  };
}

/**
 * Resolves one plugin's message action metadata with caller-selected fields.
 */
export function resolveMessageActionDiscoveryForPlugin(params: {
  pluginId: string;
  actions?: ChannelMessageToolDiscoveryAdapter;
  context: ChannelMessageActionDiscoveryContext;
  action?: ChannelMessageActionName;
  includeActions?: boolean;
  includeCapabilities?: boolean;
  includeSchema?: boolean;
}): ResolvedChannelMessageActionDiscovery {
  const adapter = params.actions;
  if (!adapter) {
    return {
      actions: [],
      capabilities: [],
      schemaContributions: [],
      mediaSourceParams: [],
    };
  }

  const described = describeMessageToolSafely({
    pluginId: params.pluginId,
    context: params.context,
    describeMessageTool: adapter.describeMessageTool,
  });
  return {
    actions:
      params.includeActions && Array.isArray(described?.actions) ? [...described.actions] : [],
    capabilities:
      params.includeCapabilities && Array.isArray(described?.capabilities)
        ? described.capabilities
        : [],
    schemaContributions: params.includeSchema
      ? normalizeToolSchemaContributions(described?.schema)
      : [],
    mediaSourceParams: normalizeMessageToolMediaSourceParams(
      described?.mediaSourceParams,
      params.action,
    ),
  };
}

/**
 * Lists message actions available across registered channel plugins.
 */
export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    for (const action of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
      includeActions: true,
    }).actions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

/**
 * Lists actions whose schemas do not block cross-channel tool usage.
 */
export function listCrossChannelSchemaSupportedMessageActions(
  params: ChannelMessageActionDiscoveryParams & {
    channel?: string;
  },
): ChannelMessageActionName[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
  if (!pluginActions?.actions) {
    return [];
  }
  const resolved = resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    includeActions: true,
    includeSchema: true,
  });
  const schemaBlockedActions = new Set<ChannelMessageActionName>();
  for (const contribution of resolved.schemaContributions) {
    // Current-channel-only schema params are not safe for cross-channel tool
    // calls unless the plugin explicitly leaves an action without that schema.
    if ((contribution.visibility ?? "current-channel") !== "current-channel") {
      continue;
    }
    if (!Object.hasOwn(contribution, "actions")) {
      return [];
    }
    const actions = contribution.actions;
    if (!Array.isArray(actions)) {
      return [];
    }
    if (actions.length === 0) {
      continue;
    }
    for (const action of actions) {
      schemaBlockedActions.add(action);
    }
  }
  return resolved.actions.filter((action) => !schemaBlockedActions.has(action));
}

/**
 * Lists message capabilities advertised across registered channel plugins.
 */
export function listChannelMessageCapabilities(cfg: OpenClawConfig): ChannelMessageCapability[] {
  const capabilities = new Set<ChannelMessageCapability>();
  for (const plugin of listChannelPlugins()) {
    for (const capability of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: { cfg },
      includeCapabilities: true,
    }).capabilities) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities);
}

/**
 * Lists message capabilities advertised by the current channel.
 */
export function listChannelMessageCapabilitiesForChannel(
  params: ChannelMessageActionDiscoveryParams,
): ChannelMessageCapability[] {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
  if (!pluginActions) {
    return [];
  }
  return Array.from(
    resolveMessageActionDiscoveryForPlugin({
      pluginId: pluginActions.pluginId,
      actions: pluginActions.actions,
      context: createMessageActionDiscoveryContext(params),
      includeCapabilities: true,
    }).capabilities,
  );
}

/**
 * Merges schema properties while preserving the first plugin to define a key.
 */
function mergeToolSchemaProperties(
  target: Record<string, TSchema>,
  source: Record<string, TSchema> | undefined,
) {
  if (!source) {
    return;
  }
  for (const [name, schema] of Object.entries(source)) {
    if (!(name in target)) {
      target[name] = schema;
    }
  }
}

/**
 * Resolves extra message-tool schema properties from channel discovery hooks.
 */
export function resolveChannelMessageToolSchemaProperties(
  params: ChannelMessageActionDiscoveryParams,
): Record<string, TSchema> {
  const properties: Record<string, TSchema> = {};
  const currentChannel = resolveMessageActionDiscoveryChannelId(params.channel);
  const discoveryBase = createMessageActionDiscoveryContext(params);
  const seenPluginIds = new Set<string>();

  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions) {
      continue;
    }
    seenPluginIds.add(plugin.id);
    for (const contribution of resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: discoveryBase,
      includeSchema: true,
    }).schemaContributions) {
      const visibility = contribution.visibility ?? "current-channel";
      if (currentChannel) {
        if (visibility === "all-configured" || plugin.id === currentChannel) {
          mergeToolSchemaProperties(properties, contribution.properties);
        }
        continue;
      }
      mergeToolSchemaProperties(properties, contribution.properties);
    }
  }
  if (currentChannel && !seenPluginIds.has(currentChannel)) {
    // The active channel may be bundled but not configured/registered yet; use
    // its lightweight discovery artifact so current-channel schemas still work.
    const currentActions = resolveCurrentChannelMessageToolDiscoveryAdapter(currentChannel);
    if (currentActions?.actions) {
      for (const contribution of resolveMessageActionDiscoveryForPlugin({
        pluginId: currentActions.pluginId,
        actions: currentActions.actions,
        context: discoveryBase,
        includeSchema: true,
      }).schemaContributions) {
        const visibility = contribution.visibility ?? "current-channel";
        if (visibility === "all-configured" || currentActions.pluginId === currentChannel) {
          mergeToolSchemaProperties(properties, contribution.properties);
        }
      }
    }
  }

  return properties;
}

/**
 * Resolves tool parameter names that should be treated as media source selectors.
 */
export function resolveChannelMessageToolMediaSourceParamKeys(
  params: ChannelMessageToolMediaSourceParamKeyInput,
): string[] {
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(params.channel);
  if (!pluginActions) {
    return [];
  }
  const described = resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    action: params.action,
    includeSchema: false,
  });
  return uniqueStrings(described.mediaSourceParams);
}

/**
 * Returns whether any registered channel advertises a message capability.
 */
export function channelSupportsMessageCapability(
  cfg: OpenClawConfig,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilities(cfg).includes(capability);
}

/**
 * Returns whether the current channel advertises a message capability.
 */
export function channelSupportsMessageCapabilityForChannel(
  params: ChannelMessageActionDiscoveryParams,
  capability: ChannelMessageCapability,
): boolean {
  return listChannelMessageCapabilitiesForChannel(params).includes(capability);
}

export const testing = {
  resetLoggedMessageActionErrors() {
    loggedMessageActionErrors.clear();
  },
};
export { testing as __testing };
