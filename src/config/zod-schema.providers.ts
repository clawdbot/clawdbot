import { z } from "zod";
import { collectBundledChannelConfigs } from "../plugins/bundled-channel-config-metadata.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifest } from "../plugins/manifest.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ChannelsConfig } from "./types.channels.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import { ContextVisibilityModeSchema, GroupPolicySchema } from "./zod-schema.core.js";

export * from "./zod-schema.providers-core.js";
export * from "./zod-schema.providers-whatsapp.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

const ChannelModelByChannelSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .optional();

function getDirectChannelRuntimeSchema(channelId: string, registry: PluginManifestRegistry) {
  const record = registry.plugins.find(
    (plugin) => plugin.origin === "bundled" && plugin.channels.includes(channelId),
  );
  if (!record) {
    return undefined;
  }
  const manifestRuntime = record.channelConfigs?.[channelId]?.runtime;
  if (manifestRuntime) {
    return manifestRuntime;
  }
  return collectBundledChannelConfigs({
    pluginDir: record.rootDir,
    manifest: {
      id: record.id,
      configSchema: record.configSchema ?? {},
      channels: record.channels,
      channelConfigs: record.channelConfigs,
    } as PluginManifest,
    packageManifest: record.packageManifest,
  })?.[channelId]?.runtime;
}

function hasPluginOwnedChannelConfig(
  value: ChannelsConfig,
): value is ChannelsConfig & Record<string, unknown> {
  return Object.keys(value).some((key) => key !== "defaults" && key !== "modelByChannel");
}

function addLegacyChannelAcpBindingIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => addLegacyChannelAcpBindingIssues(entry, ctx, [...path, index]));
    return;
  }

  const record = value as Record<string, unknown>;
  const bindings = record.bindings;
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const acp = (bindings as Record<string, unknown>).acp;
    if (acp && typeof acp === "object") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "bindings", "acp"],
        message:
          "Legacy channel-local ACP bindings were removed; use top-level bindings[] entries.",
      });
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    addLegacyChannelAcpBindingIssues(entry, ctx, [...path, key]);
  }
}

function normalizeBundledChannelConfigs(
  value: ChannelsConfig | undefined,
  ctx: z.RefinementCtx,
): ChannelsConfig | undefined {
  if (!value || !hasPluginOwnedChannelConfig(value)) {
    return value;
  }

  let next: ChannelsConfig | undefined;
  let registry: PluginManifestRegistry | undefined;
  for (const channelId of Object.keys(value)) {
    registry ??= loadPluginMetadataSnapshot({ config: {}, env: process.env }).manifestRegistry;
    const runtimeSchema = getDirectChannelRuntimeSchema(channelId, registry);
    if (!runtimeSchema) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(value, channelId)) {
      continue;
    }
    const parsed = runtimeSchema.safeParse(value[channelId]);
    if (!parsed.success) {
      for (const issue of parsed.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message ?? `Invalid channels.${channelId} config.`,
          path: [channelId, ...(Array.isArray(issue.path) ? issue.path : [])],
        });
      }
      continue;
    }
    next ??= { ...value };
    next[channelId] = parsed.data as ChannelsConfig[string];
  }

  return next ?? value;
}

export const ChannelsSchema: z.ZodType<ChannelsConfig | undefined> = z
  .object({
    defaults: z
      .object({
        groupPolicy: GroupPolicySchema.optional(),
        contextVisibility: ContextVisibilityModeSchema.optional(),
        heartbeat: ChannelHeartbeatVisibilitySchema,
      })
      .strict()
      .optional(),
    modelByChannel: ChannelModelByChannelSchema,
  })
  .passthrough() // Allow extension channel configs (nostr, matrix, zalo, etc.)
  .superRefine((value, ctx) => {
    addLegacyChannelAcpBindingIssues(value, ctx);
  })
  .transform((value, ctx) => normalizeBundledChannelConfigs(value as ChannelsConfig, ctx))
  .optional() as z.ZodType<ChannelsConfig | undefined>;
