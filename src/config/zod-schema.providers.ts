import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import { collectBundledChannelConfigs } from "../plugins/bundled-channel-config-metadata.js";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import type { ChannelsConfig } from "./types.channels.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import { ContextVisibilityModeSchema, GroupPolicySchema } from "./zod-schema.core.js";

export * from "./zod-schema.providers-core.js";
export * from "./zod-schema.providers-whatsapp.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

const ChannelModelByChannelSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .optional();

const OPENCLAW_PACKAGE_ROOT =
  resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
  }) ?? fileURLToPath(new URL("../..", import.meta.url));

function getDirectChannelRuntimeSchema(channelId: string): ChannelConfigRuntimeSchema | undefined {
  for (const entry of listBundledPluginMetadata({
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  })) {
    const manifestRuntime = entry.manifest.channelConfigs?.[channelId]?.runtime;
    if (manifestRuntime) {
      return manifestRuntime;
    }
    if (!entry.manifest.channels?.includes(channelId)) {
      continue;
    }
    const collectedChannelConfigs = collectBundledChannelConfigs({
      pluginDir: path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions", entry.dirName),
      manifest: entry.manifest,
      ...(entry.packageManifest ? { packageManifest: entry.packageManifest } : {}),
    });
    const collectedRuntime = collectedChannelConfigs?.[channelId]?.runtime;
    if (collectedRuntime) {
      return collectedRuntime;
    }
  }

  return undefined;
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
  for (const channelId of Object.keys(value)) {
    const runtimeSchema = getDirectChannelRuntimeSchema(channelId);
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
