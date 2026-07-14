/** Caches plugin tool descriptors by plugin source, contract names, and runtime context. */
import fs from "node:fs";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { JsonObject, ToolDescriptor } from "../tools/types.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginRegistry } from "./registry-types.js";
import type { OpenClawPluginToolContext } from "./types.js";

const PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION = 3;
const PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT = 256;

/** Cached display descriptor for one plugin-created tool. */
export type CachedPluginToolDescriptor = {
  descriptor: ToolDescriptor;
  displaySummary?: string;
  requiredClientCaps?: string[];
  optional: boolean;
};

export const pluginToolDescriptorCacheState = {
  descriptors: new Map<string, CachedPluginToolDescriptor[]>(),
  objectIds: new WeakMap<object, number>(),
  nextObjectId: 1,
  runtimeRegistries: new WeakMap<CachedPluginToolDescriptor, PluginRegistry>(),
};

export type PluginToolDescriptorConfigCacheKeyMemo = WeakMap<object, string | number | null>;

/** Creates a memo table for config cache keys reused across descriptor cache calls. */
export function createPluginToolDescriptorConfigCacheKeyMemo(): PluginToolDescriptorConfigCacheKeyMemo {
  return new WeakMap();
}

function sourceFingerprint(source: string): string {
  try {
    const stat = fs.statSync(source);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

function getDescriptorCacheObjectId(value: object | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const existing = pluginToolDescriptorCacheState.objectIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const next = pluginToolDescriptorCacheState.nextObjectId++;
  pluginToolDescriptorCacheState.objectIds.set(value, next);
  return next;
}

function stripDescriptorVolatileConfigFields(
  value: NonNullable<PluginLoadOptions["config"]>,
): NonNullable<PluginLoadOptions["config"]> {
  if (typeof value !== "object") {
    return value;
  }
  if (!("meta" in value) && !("wizard" in value)) {
    return value;
  }
  const { meta: _meta, wizard: _wizard, ...stableConfig } = value as Record<string, unknown>;
  return stableConfig as NonNullable<PluginLoadOptions["config"]>;
}

function getDescriptorConfigCacheKey(
  value: PluginLoadOptions["config"] | null | undefined,
  memo?: PluginToolDescriptorConfigCacheKeyMemo,
): string | number | null {
  if (!value) {
    return null;
  }
  const cached = memo?.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let resolved: string | number | null;
  try {
    resolved = resolveRuntimeConfigCacheKey(stripDescriptorVolatileConfigFields(value));
  } catch {
    resolved = getDescriptorCacheObjectId(value);
  }
  memo?.set(value, resolved);
  return resolved;
}

function buildDescriptorContextCacheKey(params: {
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
}): string {
  const { ctx } = params;
  return JSON.stringify({
    config: getDescriptorConfigCacheKey(ctx.config, params.configCacheKeyMemo),
    runtimeConfig: getDescriptorConfigCacheKey(ctx.runtimeConfig, params.configCacheKeyMemo),
    currentRuntimeConfig: getDescriptorConfigCacheKey(
      params.currentRuntimeConfig,
      params.configCacheKeyMemo,
    ),
    fsPolicy: ctx.fsPolicy ?? null,
    workspaceDir: ctx.workspaceDir ?? null,
    agentDir: ctx.agentDir ?? null,
    agentId: ctx.agentId ?? null,
    activeModel: ctx.activeModel ?? null,
    browser: ctx.browser ?? null,
    messageChannel: ctx.messageChannel ?? null,
    agentAccountId: ctx.agentAccountId ?? null,
    nativeChannelId: ctx.nativeChannelId ?? null,
    deliveryContext: ctx.deliveryContext ?? null,
    requesterSenderId: ctx.requesterSenderId ?? null,
    senderIsOwner: ctx.senderIsOwner ?? null,
    sandboxed: ctx.sandboxed ?? null,
  });
}

export function buildPluginToolDescriptorCacheKey(params: {
  pluginId: string;
  source: string;
  rootDir?: string;
  contractToolNames: readonly string[];
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
}): string {
  return JSON.stringify({
    version: PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION,
    pluginId: params.pluginId,
    source: params.source,
    rootDir: params.rootDir ?? null,
    sourceFingerprint: sourceFingerprint(params.source),
    contractToolNames: [...params.contractToolNames].toSorted(),
    context: buildDescriptorContextCacheKey({
      ctx: params.ctx,
      currentRuntimeConfig: params.currentRuntimeConfig,
      configCacheKeyMemo: params.configCacheKeyMemo,
    }),
  });
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

export function capturePluginToolDescriptor(params: {
  pluginId: string;
  tool: AnyAgentTool;
  optional: boolean;
}): CachedPluginToolDescriptor {
  const label = (params.tool as { label?: unknown }).label;
  const title = typeof label === "string" && label.trim() ? label.trim() : undefined;
  return {
    ...(params.tool.displaySummary ? { displaySummary: params.tool.displaySummary } : {}),
    ...(params.tool.requiredClientCaps
      ? { requiredClientCaps: [...params.tool.requiredClientCaps] }
      : {}),
    optional: params.optional,
    descriptor: {
      name: params.tool.name,
      ...(title ? { title } : {}),
      description: params.tool.description,
      inputSchema: asJsonObject(params.tool.parameters),
      owner: { kind: "plugin", pluginId: params.pluginId },
      executor: { kind: "plugin", pluginId: params.pluginId, toolName: params.tool.name },
    },
  };
}

export function readCachedPluginToolDescriptors(
  cacheKey: string,
): readonly CachedPluginToolDescriptor[] | undefined {
  return pluginToolDescriptorCacheState.descriptors.get(cacheKey);
}

export function writeCachedPluginToolDescriptors(params: {
  cacheKey: string;
  descriptors: readonly CachedPluginToolDescriptor[];
}): void {
  if (
    !pluginToolDescriptorCacheState.descriptors.has(params.cacheKey) &&
    pluginToolDescriptorCacheState.descriptors.size >= PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT
  ) {
    const oldestKey = pluginToolDescriptorCacheState.descriptors.keys().next().value;
    if (oldestKey !== undefined) {
      pluginToolDescriptorCacheState.descriptors.delete(oldestKey);
    }
  }
  pluginToolDescriptorCacheState.descriptors.set(params.cacheKey, [...params.descriptors]);
}
