import { z } from "zod";
import type { PluginLogger } from "../api.js";
import {
  normalizeWebhookPath,
  resolveConfiguredSecretInputString,
  type OpenClawConfig,
} from "../runtime-api.js";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const webhookRouteConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    path: z.string().trim().min(1).optional(),
    sessionKey: z.string().trim().min(1),
    secret: secretInputSchema,
    controllerId: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

const webhooksPluginConfigSchema = z
  .object({
    routes: z.record(z.string().trim().min(1), webhookRouteConfigSchema).default({}),
  })
  .strict();

export type ResolvedWebhookRouteConfig = {
  routeId: string;
  path: string;
  sessionKey: string;
  secret: string;
  controllerId: string;
  description?: string;
};

export async function resolveWebhooksPluginConfig(params: {
  pluginConfig: unknown;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  logger?: PluginLogger;
}): Promise<ResolvedWebhookRouteConfig[]> {
  const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
  const resolvedRoutes: ResolvedWebhookRouteConfig[] = [];
  const seenPaths = new Map<string, string>();

  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (!route.enabled) {
      continue;
    }
    const path = normalizeWebhookPath(route.path ?? `/plugins/webhooks/${routeId}`);
    const existingRouteId = seenPaths.get(path);
    if (existingRouteId) {
      throw new Error(
        `webhooks.routes.${routeId}.path conflicts with routes.${existingRouteId}.path (${path}).`,
      );
    }

    const secretResolution = await resolveConfiguredSecretInputString({
      config: params.cfg,
      env: params.env,
      value: route.secret,
      path: `plugins.entries.webhooks.routes.${routeId}.secret`,
    });
    const secret = secretResolution.value?.trim();
    if (!secret) {
      params.logger?.warn?.(
        `[webhooks] skipping route ${routeId}: ${
          secretResolution.unresolvedRefReason ?? "secret is empty or unresolved"
        }`,
      );
      continue;
    }

    seenPaths.set(path, routeId);
    resolvedRoutes.push({
      routeId,
      path,
      sessionKey: route.sessionKey,
      secret,
      controllerId: route.controllerId ?? `webhooks/${routeId}`,
      ...(route.description ? { description: route.description } : {}),
    });
  }

  return resolvedRoutes;
}
