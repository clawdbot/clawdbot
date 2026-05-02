import path from "node:path";
import { z } from "zod";
import { InstallRecordShape } from "./zod-schema.installs.js";
import { sensitive } from "./zod-schema.sensitive.js";

function isSafeRelativeModulePath(raw: string): boolean {
  const value = raw.trim();
  if (!value) {
    return false;
  }
  // Hook modules are loaded via file-path resolution + dynamic import().
  // Keep this strictly relative to a configured base dir to avoid path traversal and surprises.
  if (path.isAbsolute(value)) {
    return false;
  }
  if (value.startsWith("~")) {
    return false;
  }
  // Disallow URL-ish and drive-relative forms (e.g. "file:...", "C:foo").
  if (value.includes(":")) {
    return false;
  }
  const parts = value.split(/[\\/]+/g);
  if (parts.some((part) => part === "..")) {
    return false;
  }
  return true;
}

const SafeRelativeModulePathSchema = z
  .string()
  .refine(isSafeRelativeModulePath, "module must be a safe relative path (no absolute paths)");

export const HookMappingSchema = z
  .object({
    id: z.string().optional(),
    match: z
      .object({
        path: z.string().optional(),
        source: z.string().optional(),
      })
      .optional(),
    action: z.union([z.literal("wake"), z.literal("agent")]).optional(),
    wakeMode: z.union([z.literal("now"), z.literal("next-heartbeat")]).optional(),
    name: z.string().optional(),
    agentId: z.string().optional(),
    sessionKey: z.string().optional().register(sensitive),
    messageTemplate: z.string().optional(),
    textTemplate: z.string().optional(),
    deliver: z.boolean().optional(),
    allowUnsafeExternalContent: z.boolean().optional(),
    // Keep this open-ended so runtime channel plugins (for example feishu) can be
    // referenced without hard-coding every channel id in the config schema.
    // Runtime still validates the resolved value against currently registered channels.
    channel: z.string().trim().min(1).optional(),
    to: z.string().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    transform: z
      .object({
        module: SafeRelativeModulePathSchema,
        export: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const InternalHookHandlerSchema = z
  .object({
    event: z.string(),
    module: SafeRelativeModulePathSchema,
    export: z.string().optional(),
  })
  .strict();

const HookConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  // Hook configs are intentionally open-ended (handlers can define their own keys).
  // Keep enabled/env typed, but allow additional per-hook keys without marking the
  // whole config invalid (which triggers doctor/best-effort loads).
  .passthrough();

const HookInstallRecordSchema = z
  .object({
    ...InstallRecordShape,
    hooks: z.array(z.string()).optional(),
  })
  .strict();

export const InternalHooksSchema = z
  .object({
    enabled: z.boolean().optional(),
    handlers: z.array(InternalHookHandlerSchema).optional(),
    entries: z.record(z.string(), HookConfigSchema).optional(),
    load: z
      .object({
        extraDirs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    installs: z.record(z.string(), HookInstallRecordSchema).optional(),
  })
  .strict()
  .optional();

export const HooksGmailSchema = z
  .object({
    account: z.string().optional(),
    label: z.string().optional(),
    topic: z.string().optional(),
    subscription: z.string().optional(),
    pushToken: z.string().optional().register(sensitive),
    hookUrl: z.string().optional(),
    includeBody: z.boolean().optional(),
    maxBytes: z.number().int().positive().optional(),
    renewEveryMinutes: z.number().int().positive().optional(),
    allowUnsafeExternalContent: z.boolean().optional(),
    serve: z
      .object({
        bind: z.string().optional(),
        port: z.number().int().positive().optional(),
        path: z.string().optional(),
      })
      .strict()
      .optional(),
    tailscale: z
      .object({
        mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
        path: z.string().optional(),
        target: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    thinking: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
      ])
      .optional(),
  })
  .strict()
  .optional();
